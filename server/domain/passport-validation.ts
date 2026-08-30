import {
  DATA_CATEGORY_VALUES,
  MAX_PASSPORT_JSON_BYTES,
  MAX_PASSPORT_STRING_BYTES,
  PassportDocumentSchema,
  REDACTED_SOURCE_EXCERPT,
  type FlowPassPassport,
  type PassportValidation,
  type RepairRecord,
  type ValidationIssue,
} from '../../shared/passport-contract';

export type SourceExcerptRedaction = {
  code: 'source_excerpt_redacted';
  path: string;
};

export type PassportInspection = {
  validation: PassportValidation;
  redactions: SourceExcerptRedaction[];
  diagnostics: ValidationIssue[];
  canonical: FlowPassPassport | null;
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathFromSegments(segments: PropertyKey[]): string {
  return segments.reduce<string>((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;
    return `${path}.${String(segment)}`;
  }, '$');
}

function syntaxIssue(code: string, message: string): ValidationIssue {
  return {
    code,
    category: 'syntax',
    severity: 'error',
    path: '$',
    message,
  };
}

function rawDocumentIssue(
  code: 'raw_document_too_large' | 'raw_document_unserializable',
): ValidationIssue {
  return {
    code,
    category: 'schema',
    severity: 'error',
    path: '$',
    message:
      code === 'raw_document_too_large'
        ? `FlowPass JSON 不可超過 ${MAX_PASSPORT_JSON_BYTES} 位元組。`
        : 'FlowPass 文件無法安全序列化驗證。',
  };
}

/**
 * Object callers have no raw text ingress, so serialize only to measure the
 * incoming JSON-equivalent document before any clone, repair, or redaction.
 * The serialized text is deliberately never returned or logged.
 */
function rawDocumentByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
  } catch {
    return null;
  }
}

function schemaIssue(path: string, code = 'schema_invalid_value'): ValidationIssue {
  const isNodeKind = /\.nodes\[\d+\]\.kind$/.test(path);
  return {
    code,
    category: 'schema',
    severity: 'error',
    path,
    message: isNodeKind
      ? '節點 kind 只允許：data、ai_tool、plugin、storage、person、organization、destination。照片、音訊、影片或創作成品應使用 kind「data」，並把格式放在 data_category。'
      : '欄位不符合 FlowPass 格式。',
  };
}

function cloneInput(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return { ok: false };
  }
}

function stringLimitIssues(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new WeakSet<object>();

  function visit(current: unknown, path: string) {
    if (typeof current === 'string') {
      if (utf8ByteLength(current) > MAX_PASSPORT_STRING_BYTES) {
        issues.push({
          code: 'string_too_large',
          category: 'schema',
          severity: 'error',
          path,
          message: `字串不可超過 ${MAX_PASSPORT_STRING_BYTES} 位元組。`,
        });
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (visited.has(current)) {
      issues.push({
        code: 'cyclic_input',
        category: 'schema',
        severity: 'error',
        path,
        message: 'FlowPass JSON 不可包含循環參照。',
      });
      return;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    Object.entries(current).forEach(([key, item]) => visit(item, `${path}.${key}`));
  }

  visit(value, '$');
  return issues;
}

function adaptLegacyQuestions(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.passport_draft)) return;
  const draft = value.passport_draft;
  if (!Object.prototype.hasOwnProperty.call(draft, 'confirmation_questions')) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'follow_up_questions')) {
    return;
  }
  if (!Array.isArray(draft.confirmation_questions)) return;

  draft.follow_up_questions = draft.confirmation_questions.map((question) => {
    if (!isRecord(question)) return question;
    const adapted = { ...question };
    const prompt = adapted.question;
    const relatedNodeIds = adapted.related_node_ids;
    delete adapted.question;
    delete adapted.related_node_ids;

    return {
      ...adapted,
      prompt,
      relatedNodeIds,
      version: adapted.version ?? 1,
      answerSchema: adapted.answerSchema ?? { type: 'text', maxLength: 400 },
      required: adapted.required ?? false,
      status: adapted.status ?? 'open',
    };
  });
  delete draft.confirmation_questions;
}

function repairKnownCategoryNodeKinds(value: unknown): RepairRecord[] {
  if (!isRecord(value) || !isRecord(value.passport_draft)) return [];
  const nodes = value.passport_draft.nodes;
  if (!Array.isArray(nodes)) return [];

  const knownCategories = new Set<string>(DATA_CATEGORY_VALUES);
  const repairs: RepairRecord[] = [];
  nodes.forEach((node, index) => {
    if (!isRecord(node) || typeof node.kind !== 'string') return;
    if (!knownCategories.has(node.kind)) return;

    const from = node.kind as RepairRecord['from'];
    node.kind = 'data';
    repairs.push({
      path: `$.passport_draft.nodes[${index}].kind`,
      nodeId: typeof node.id === 'string' ? node.id : '',
      from,
      to: 'data',
      reason: 'known_data_category_in_kind',
    });
  });
  return repairs;
}

function redactSourceExcerpts(
  value: unknown,
  redactions: SourceExcerptRedaction[],
): void {
  if (!isRecord(value) || !isRecord(value.passport_draft)) return;
  const draft = value.passport_draft;
  const redact = (record: unknown, path: string) => {
    if (!isRecord(record) || typeof record.source_excerpt !== 'string') return;
    record.source_excerpt = REDACTED_SOURCE_EXCERPT;
    redactions.push({ code: 'source_excerpt_redacted', path });
  };

  if (Array.isArray(draft.nodes)) {
    draft.nodes.forEach((node, index) =>
      redact(node, `$.passport_draft.nodes[${index}].source_excerpt`),
    );
  }
  if (Array.isArray(draft.edges)) {
    draft.edges.forEach((edge, index) =>
      redact(edge, `$.passport_draft.edges[${index}].source_excerpt`),
    );
  }
  redact(draft.sharing_scope, '$.passport_draft.sharing_scope.source_excerpt');
}

function zodIssuesToValidationIssues(issues: readonly unknown[]): ValidationIssue[] {
  const mapped: ValidationIssue[] = [];
  for (const issue of issues) {
    const current = issue as {
      code?: string;
      path?: PropertyKey[];
      keys?: string[];
    };
    const path = pathFromSegments(current.path ?? []);
    if (current.code === 'unrecognized_keys' && current.keys) {
      current.keys.forEach((key) => {
        mapped.push(schemaIssue(`${path}.${key}`, 'schema_unrecognized_key'));
      });
      continue;
    }
    if (current.code === 'invalid_type' && current.path?.length) {
      mapped.push(schemaIssue(path, 'schema_invalid_type'));
      continue;
    }
    if (current.code === 'too_big' && current.path?.length) {
      mapped.push(schemaIssue(path, 'schema_too_big'));
      continue;
    }
    mapped.push(schemaIssue(path));
  }
  return mapped;
}

function idIssues(
  items: Array<{ id: string }>,
  label: 'node' | 'edge' | 'action' | 'question',
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!item.id.trim()) {
      issues.push({
        code: `blank_${label}_id`,
        category: 'graph',
        severity: 'error',
        path: `${path}[${index}].id`,
        message: `${label} 的 id 不可為空白。`,
      });
      return;
    }
    if (seen.has(item.id)) {
      issues.push({
        code: `duplicate_${label}_id`,
        category: 'graph',
        severity: 'error',
        path: `${path}[${index}].id`,
        message: '同一集合內的 id 重複出現。',
      });
      return;
    }
    seen.add(item.id);
  });
  return issues;
}

function cycleIssues(
  passport: FlowPassPassport,
  nodeById: Map<string, FlowPassPassport['nodes'][number]>,
): ValidationIssue[] {
  const adjacency = new Map<string, string[]>();
  passport.nodes.forEach((node) => adjacency.set(node.id, []));
  passport.edges.forEach((edge) => {
    if (
      edge.from_node_id !== edge.to_node_id &&
      nodeById.has(edge.from_node_id) &&
      nodeById.has(edge.to_node_id)
    ) {
      adjacency.get(edge.from_node_id)?.push(edge.to_node_id);
    }
  });

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const signatures = new Set<string>();
  const issues: ValidationIssue[] = [];
  const visit = (nodeId: string) => {
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const nextId of adjacency.get(nodeId) ?? []) {
      const nextState = state.get(nextId) ?? 0;
      if (nextState === 0) {
        visit(nextId);
        continue;
      }
      if (nextState !== 1) continue;
      const cycle = [...stack.slice(stack.lastIndexOf(nextId)), nextId];
      const signature = [...new Set(cycle)].sort().join('|');
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      issues.push({
        code: 'graph_cycle',
        category: 'graph',
        severity: 'warning',
        path: '$.passport_draft.edges',
        message: '資料流形成循環。請確認是否為真實回流。',
      });
    }
    stack.pop();
    state.set(nodeId, 2);
  };
  adjacency.forEach((_, nodeId) => {
    if ((state.get(nodeId) ?? 0) === 0) visit(nodeId);
  });
  return issues;
}

const REDACTED_INVALID_GRAPH_REFERENCE = '[invalid graph reference]';
const REDACTED_DUPLICATE_GRAPH_ID = '[duplicate graph id]';
const REDACTED_DUPLICATE_TRANSFER_PURPOSE = '[duplicate transfer purpose]';

function redactDuplicateIds<T extends { id: string }>(items: T[]): Set<string> {
  const counts = new Map<string, number>();
  items.forEach((item) => counts.set(item.id, (counts.get(item.id) ?? 0) + 1));
  const duplicateIds = new Set(
    [...counts].filter(([, count]) => count > 1).map(([id]) => id),
  );
  items.forEach((item) => {
    if (duplicateIds.has(item.id)) {
      item.id = REDACTED_DUPLICATE_GRAPH_ID;
    }
  });
  return duplicateIds;
}

/**
 * Invalid graph fields can contain a pasted source excerpt. Diagnostics expose
 * only paths and rule codes, while this projection keeps that malformed value
 * out of parser and revision payloads. Valid graph fields remain untouched.
 */
function redactInvalidGraphValues(
  passport: FlowPassPassport,
  diagnostics: ValidationIssue[],
): void {
  const diagnosticCodes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
  const duplicateNodeIds = diagnosticCodes.has('duplicate_node_id')
    ? redactDuplicateIds(passport.nodes)
    : new Set<string>();

  if (diagnosticCodes.has('duplicate_edge_id')) redactDuplicateIds(passport.edges);
  if (diagnosticCodes.has('duplicate_action_id')) {
    redactDuplicateIds(passport.safety_actions);
  }
  if (diagnosticCodes.has('duplicate_question_id')) {
    redactDuplicateIds(passport.follow_up_questions);
  }

  if (duplicateNodeIds.size > 0) {
    const redactDuplicateNodeReference = (nodeId: string) =>
      duplicateNodeIds.has(nodeId) ? REDACTED_INVALID_GRAPH_REFERENCE : nodeId;
    passport.edges.forEach((edge) => {
      edge.from_node_id = redactDuplicateNodeReference(edge.from_node_id);
      edge.to_node_id = redactDuplicateNodeReference(edge.to_node_id);
    });
    passport.safety_actions.forEach((action) => {
      action.applies_to_node_ids = action.applies_to_node_ids.map(
        redactDuplicateNodeReference,
      );
    });
    passport.follow_up_questions.forEach((question) => {
      question.relatedNodeIds = question.relatedNodeIds.map(
        redactDuplicateNodeReference,
      );
    });
    passport.retention.storage_location = redactDuplicateNodeReference(
      passport.retention.storage_location,
    );
  }

  if (diagnosticCodes.has('duplicate_edge')) {
    const duplicateTransferCounts = new Map<string, number>();
    passport.edges.forEach((edge) => {
      const key = JSON.stringify([edge.from_node_id, edge.to_node_id, edge.purpose]);
      duplicateTransferCounts.set(key, (duplicateTransferCounts.get(key) ?? 0) + 1);
    });
    passport.edges.forEach((edge) => {
      const key = JSON.stringify([edge.from_node_id, edge.to_node_id, edge.purpose]);
      if ((duplicateTransferCounts.get(key) ?? 0) > 1) {
        edge.purpose = REDACTED_DUPLICATE_TRANSFER_PURPOSE;
      }
    });
  }

  diagnostics.forEach((diagnostic) => {
    const edgeReference = diagnostic.path.match(
      /^\$\.passport_draft\.edges\[(\d+)\]\.(from_node_id|to_node_id)$/,
    );
    if (diagnostic.code === 'invalid_edge_reference' && edgeReference) {
      const edge = passport.edges[Number(edgeReference[1])];
      if (edge) edge[edgeReference[2] as 'from_node_id' | 'to_node_id'] = REDACTED_INVALID_GRAPH_REFERENCE;
      return;
    }

    const actionReference = diagnostic.path.match(
      /^\$\.passport_draft\.safety_actions\[(\d+)\]\.applies_to_node_ids\[(\d+)\]$/,
    );
    if (diagnostic.code === 'invalid_action_reference' && actionReference) {
      const action = passport.safety_actions[Number(actionReference[1])];
      const referenceIndex = Number(actionReference[2]);
      if (action) action.applies_to_node_ids[referenceIndex] = REDACTED_INVALID_GRAPH_REFERENCE;
      return;
    }

    const questionReference = diagnostic.path.match(
      /^\$\.passport_draft\.follow_up_questions\[(\d+)\]\.relatedNodeIds\[(\d+)\]$/,
    );
    if (diagnostic.code === 'invalid_question_reference' && questionReference) {
      const question = passport.follow_up_questions[Number(questionReference[1])];
      const referenceIndex = Number(questionReference[2]);
      if (question) question.relatedNodeIds[referenceIndex] = REDACTED_INVALID_GRAPH_REFERENCE;
      return;
    }

    if (diagnostic.code === 'invalid_retention_storage') {
      passport.retention.storage_location = REDACTED_INVALID_GRAPH_REFERENCE;
      return;
    }

    const selfLoop = diagnostic.path.match(/^\$\.passport_draft\.edges\[(\d+)\]$/);
    if (diagnostic.code === 'self_loop' && selfLoop) {
      const edge = passport.edges[Number(selfLoop[1])];
      if (edge) {
        edge.from_node_id = REDACTED_INVALID_GRAPH_REFERENCE;
        edge.to_node_id = REDACTED_INVALID_GRAPH_REFERENCE;
      }
    }
  });
}

/**
 * Returns the graph and readiness diagnostics for a canonical, schema-valid
 * passport. Callers should reject error-severity records before persistence.
 */
export function collectPassportDiagnostics(
  passport: FlowPassPassport,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...idIssues(passport.nodes, 'node', '$.passport_draft.nodes'),
    ...idIssues(passport.edges, 'edge', '$.passport_draft.edges'),
    ...idIssues(passport.safety_actions, 'action', '$.passport_draft.safety_actions'),
    ...idIssues(
      passport.follow_up_questions,
      'question',
      '$.passport_draft.follow_up_questions',
    ),
  ];
  const nodeById = new Map(passport.nodes.map((node) => [node.id, node]));
  const participatingNodeIds = new Set<string>();
  const transferKeys = new Set<string>();

  passport.edges.forEach((edge, index) => {
    const fromExists = nodeById.has(edge.from_node_id);
    const toExists = nodeById.has(edge.to_node_id);
    if (!fromExists) {
      issues.push({
        code: 'invalid_edge_reference',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.edges[${index}].from_node_id`,
        message: '連線來源節點不存在。',
      });
    } else {
      participatingNodeIds.add(edge.from_node_id);
    }
    if (!toExists) {
      issues.push({
        code: 'invalid_edge_reference',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.edges[${index}].to_node_id`,
        message: '連線目的地節點不存在。',
      });
    } else {
      participatingNodeIds.add(edge.to_node_id);
    }
    if (edge.from_node_id === edge.to_node_id) {
      issues.push({
        code: 'self_loop',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.edges[${index}]`,
        message: '連線的起點與終點相同。',
      });
    }
    const transferKey = `${edge.from_node_id}|${edge.to_node_id}|${edge.purpose}`;
    if (transferKeys.has(transferKey)) {
      issues.push({
        code: 'duplicate_edge',
        category: 'graph',
        severity: 'warning',
        path: `$.passport_draft.edges[${index}]`,
        message: '相同用途的資料傳遞重複出現。',
      });
    } else {
      transferKeys.add(transferKey);
    }
  });

  passport.safety_actions.forEach((action, actionIndex) => {
    action.applies_to_node_ids.forEach((nodeId, referenceIndex) => {
      if (nodeById.has(nodeId)) return;
      issues.push({
        code: 'invalid_action_reference',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.safety_actions[${actionIndex}].applies_to_node_ids[${referenceIndex}]`,
        message: '安全措施引用了不存在的節點。',
      });
    });
  });

  passport.follow_up_questions.forEach((question, questionIndex) => {
    question.relatedNodeIds.forEach((nodeId, referenceIndex) => {
      if (nodeById.has(nodeId)) return;
      issues.push({
        code: 'invalid_question_reference',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.follow_up_questions[${questionIndex}].relatedNodeIds[${referenceIndex}]`,
        message: '確認問題引用了不存在的節點。',
      });
    });
  });

  passport.nodes.forEach((node, index) => {
    if (participatingNodeIds.has(node.id)) return;
    issues.push({
      code: 'orphan_node',
      category: 'graph',
      severity:
        node.kind === 'person' || node.kind === 'organization' ? 'info' : 'warning',
      path: `$.passport_draft.nodes[${index}]`,
      message: '有節點沒有連到任何資料流。',
    });
  });

  const storageLocation = passport.retention.storage_location;
  if (nodeById.has(storageLocation) || storageLocation.startsWith('node_')) {
    const storageNode = nodeById.get(storageLocation);
    if (!storageNode || storageNode.kind !== 'storage') {
      issues.push({
        code: 'invalid_retention_storage',
        category: 'graph',
        severity: 'error',
        path: '$.passport_draft.retention.storage_location',
        message: '保存位置不是有效的 storage 節點。',
      });
    }
  }

  if (passport.sharing_scope.audience === 'public') {
    const hasConnectedDestination = passport.nodes.some(
      (node) => node.kind === 'destination' && participatingNodeIds.has(node.id),
    );
    if (!hasConnectedDestination) {
      issues.push({
        code: 'public_without_destination_flow',
        category: 'graph',
        severity: 'warning',
        path: '$.passport_draft.sharing_scope.audience',
        message: '分享範圍是公開，但沒有連入資料流的公開目的地節點。',
      });
    }
  }

  issues.push(...cycleIssues(passport, nodeById));
  if (
    passport.sharing_scope.needs_confirmation ||
    passport.retention.needs_confirmation ||
    passport.nodes.some((node) => node.needs_confirmation) ||
    passport.edges.some((edge) => edge.needs_confirmation)
  ) {
    issues.push({
      code: 'confirmation_required',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft',
      message: '這份護照包含尚待本人確認的節點、連線、分享或保存資訊。',
    });
  }
  if (passport.audit.unknown_fields.length > 0) {
    issues.push({
      code: 'unknown_fields',
      category: 'readiness',
      severity: 'warning',
      path: '$.passport_draft.audit.unknown_fields',
      message: `仍有 ${passport.audit.unknown_fields.length} 個未知欄位。`,
    });
  }
  const highSensitivityCount = passport.nodes.filter(
    (node) => node.sensitivity === 'high',
  ).length;
  if (highSensitivityCount > 0) {
    issues.push({
      code: 'high_sensitivity_present',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft.nodes',
      message: `護照中有 ${highSensitivityCount} 個高敏感節點，需逐項確認處理方式。`,
    });
  }
  if (passport.sharing_scope.audience === 'public') {
    issues.push({
      code: 'public_sharing',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft.sharing_scope.audience',
      message: '預計分享範圍包含公開發布。',
    });
  }
  if (
    !passport.retention.duration.trim() ||
    passport.retention.duration === 'unknown' ||
    !passport.retention.deletion_plan.trim() ||
    passport.retention.deletion_plan === 'unknown'
  ) {
    issues.push({
      code: 'unknown_retention',
      category: 'readiness',
      severity: 'warning',
      path: '$.passport_draft.retention',
      message: '保存期限或刪除計畫尚未確認。',
    });
  }
  if (
    !passport.administrative_hints.requested_tool.trim() ||
    passport.administrative_hints.requested_tool === 'unknown'
  ) {
    issues.push({
      code: 'unknown_tool',
      category: 'readiness',
      severity: 'warning',
      path: '$.passport_draft.administrative_hints.requested_tool',
      message: '申請使用的 AI 工具尚未指定。',
    });
  }
  issues.push({
    code: 'officer_review_required',
    category: 'readiness',
    severity: 'info',
    path: '$.passport_draft.administrative_hints.requires_officer_review',
    message: '此草稿仍需要承辦人員複核。',
  });
  return issues;
}

function inspectDocument(value: unknown): PassportInspection {
  const rawBytes = rawDocumentByteLength(value);
  if (rawBytes === null) {
    return {
      validation: {
        ok: false,
        errors: [rawDocumentIssue('raw_document_unserializable')],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }
  if (rawBytes > MAX_PASSPORT_JSON_BYTES) {
    return {
      validation: {
        ok: false,
        errors: [rawDocumentIssue('raw_document_too_large')],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }

  const cloned = cloneInput(value);
  if (!cloned.ok) {
    return {
      validation: {
        ok: false,
        errors: [
          schemaIssue('$', 'schema_uncloneable_input'),
        ],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }
  const stringIssues = stringLimitIssues(cloned.value);
  if (stringIssues.length > 0) {
    return {
      validation: { ok: false, errors: stringIssues },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }

  adaptLegacyQuestions(cloned.value);
  const repairs = repairKnownCategoryNodeKinds(cloned.value);
  const redactions: SourceExcerptRedaction[] = [];
  redactSourceExcerpts(cloned.value, redactions);

  const parsed = PassportDocumentSchema.safeParse(cloned.value);
  if (!parsed.success) {
    return {
      validation: {
        ok: false,
        errors: zodIssuesToValidationIssues(parsed.error.issues),
      },
      redactions,
      diagnostics: [],
      canonical: null,
    };
  }

  const canonicalText = JSON.stringify(parsed.data);
  if (utf8ByteLength(canonicalText) > MAX_PASSPORT_JSON_BYTES) {
    return {
      validation: {
        ok: false,
        errors: [
          {
            code: 'canonical_json_too_large',
            category: 'schema',
            severity: 'error',
            path: '$',
            message: `FlowPass JSON 不可超過 ${MAX_PASSPORT_JSON_BYTES} 位元組。`,
          },
        ],
      },
      redactions,
      diagnostics: [],
      canonical: null,
    };
  }

  const diagnostics = collectPassportDiagnostics(parsed.data.passport_draft);
  redactInvalidGraphValues(parsed.data.passport_draft, diagnostics);
  const errors = diagnostics.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    return {
      validation: { ok: false, errors },
      redactions,
      diagnostics,
      canonical: parsed.data.passport_draft,
    };
  }
  return {
    validation: {
      ok: true,
      value: parsed.data.passport_draft,
      repairs,
    },
    redactions,
    diagnostics,
    canonical: parsed.data.passport_draft,
  };
}

function stripJsonFence(raw: string): string {
  const match = raw.trim().match(/^```json\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : raw.trim();
}

/** Validates JSON text through the same path used by browser preview and persistence. */
export function inspectPassportJson(raw: string): PassportInspection {
  if (utf8ByteLength(raw) > MAX_PASSPORT_JSON_BYTES) {
    return {
      validation: {
        ok: false,
        errors: [
          syntaxIssue(
            'raw_json_too_large',
            `FlowPass JSON 不可超過 ${MAX_PASSPORT_JSON_BYTES} 位元組。`,
          ),
        ],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }
  const json = stripJsonFence(raw);
  if (!json) {
    return {
      validation: {
        ok: false,
        errors: [syntaxIssue('empty_input', '請貼上 AI 回傳的 FlowPass JSON。')],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }
  try {
    return inspectDocument(JSON.parse(json));
  } catch {
    return {
      validation: {
        ok: false,
        errors: [
          syntaxIssue(
            'invalid_json',
            'JSON 格式無法解析，請檢查括號、引號或尾端逗號。',
          ),
        ],
      },
      redactions: [],
      diagnostics: [],
      canonical: null,
    };
  }
}

export function validatePassportJson(raw: string): PassportValidation {
  return inspectPassportJson(raw).validation;
}

export function inspectPassportDocument(value: unknown): PassportInspection {
  return inspectDocument(value);
}

export function validatePassportDocument(value: unknown): PassportValidation {
  return inspectDocument(value).validation;
}
