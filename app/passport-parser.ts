import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { PASSPORT_JSON_SCHEMA } from './prompt-builder';

export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory = 'syntax' | 'schema' | 'graph' | 'readiness';
export type ParseStatus =
  | 'invalid_json'
  | 'invalid_contract'
  | 'invalid_graph'
  | 'valid_with_warnings'
  | 'valid';

export type ValidationIssue = {
  code: string;
  category: IssueCategory;
  severity: IssueSeverity;
  path: string;
  message: string;
  relatedIds?: string[];
};

export type NodeKind =
  | 'data'
  | 'ai_tool'
  | 'plugin'
  | 'storage'
  | 'person'
  | 'organization'
  | 'destination';

export type Sensitivity = 'low' | 'medium' | 'high' | 'unknown';
export type QuestionPriority = 'high' | 'medium' | 'low';

export type PassportNode = {
  id: string;
  kind: NodeKind;
  label: string;
  data_category:
    | 'photo'
    | 'audio'
    | 'video'
    | 'document'
    | 'code'
    | 'personal_data'
    | 'creative_asset'
    | 'other'
    | null;
  sensitivity: Sensitivity;
  source_field:
    | 'materials'
    | 'intended_use'
    | 'personal_or_sensitive_data'
    | 'destination_and_audience';
  source_excerpt: string;
  confidence: number;
  needs_confirmation: boolean;
};

export type PassportEdge = {
  id: string;
  from_node_id: string;
  to_node_id: string;
  purpose: string;
  source_field: PassportNode['source_field'];
  source_excerpt: string;
  confidence: number;
  needs_confirmation: boolean;
};

export type SafetyAction = {
  id: string;
  action: string;
  reason: string;
  applies_to_node_ids: string[];
  status: 'required_confirmation';
  evidence_type:
    | 'applicant_confirmation'
    | 'system_check'
    | 'officer_review';
};

export type ConfirmationQuestion = {
  id: string;
  question: string;
  reason: string;
  related_node_ids: string[];
  priority: QuestionPriority;
};

export type PassportDraft = {
  use_case: {
    title: string;
    purpose: string;
    intended_outcome: string;
  };
  nodes: PassportNode[];
  edges: PassportEdge[];
  sharing_scope: {
    audience: 'self' | 'team' | 'client' | 'public' | 'unknown';
    source_field: 'destination_and_audience';
    source_excerpt: string;
    needs_confirmation: boolean;
  };
  retention: {
    storage_location: string;
    duration: string;
    deletion_plan: string;
    needs_confirmation: boolean;
  };
  safety_actions: SafetyAction[];
  confirmation_questions: ConfirmationQuestion[];
  administrative_hints: {
    requested_tool: string;
    invoice_fields_required: Array<
      'tool_name' | 'purchase_date' | 'amount' | 'invoice_number'
    >;
    subsidy_calculation: 'not_performed_by_ai';
    requires_officer_review: true;
  };
  audit: {
    draft_status: 'ai_generated_unconfirmed';
    rules_version: 'hackathon-mvp-2026-08-27';
    unknown_fields: string[];
  };
};

export type ReadableFlow = {
  id: string;
  fromLabel: string;
  toLabel: string;
  purpose: string;
  needsConfirmation: boolean;
};

export type PassportSummary = {
  nodeCount: number;
  edgeCount: number;
  actionCount: number;
  questionCount: number;
  priorityCounts: Record<QuestionPriority, number>;
  sensitivityCounts: Record<Sensitivity, number>;
  unknownFields: string[];
  flows: ReadableFlow[];
};

export type FlowPassParseResult = {
  status: ParseStatus;
  passport: PassportDraft | null;
  issues: ValidationIssue[];
  summary: PassportSummary | null;
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatePassport = ajv.compile(
  structuredClone(PASSPORT_JSON_SCHEMA) as object,
);

function pointerToPath(pointer: string): string {
  if (!pointer) return '$';

  return pointer
    .split('/')
    .slice(1)
    .reduce((path, rawSegment) => {
      const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
      return /^\d+$/.test(segment)
        ? `${path}[${segment}]`
        : `${path}.${segment}`;
    }, '$');
}

function schemaErrorPath(error: ErrorObject): string {
  const basePath = pointerToPath(error.instancePath);

  if (error.keyword === 'required') {
    const missingProperty = String(error.params.missingProperty);
    return `${basePath}.${missingProperty}`;
  }
  if (error.keyword === 'additionalProperties') {
    const additionalProperty = String(error.params.additionalProperty);
    return `${basePath}.${additionalProperty}`;
  }

  return basePath;
}

function schemaIssue(error: ErrorObject): ValidationIssue {
  return {
    code: `schema_${error.keyword}`,
    category: 'schema',
    severity: 'error',
    path: schemaErrorPath(error),
    message: `欄位不符合 FlowPass 格式：${error.message ?? error.keyword}`,
  };
}

function buildSummary(passport: PassportDraft): PassportSummary {
  const priorityCounts: Record<QuestionPriority, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const sensitivityCounts: Record<Sensitivity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0,
  };

  for (const question of passport.confirmation_questions) {
    priorityCounts[question.priority] += 1;
  }
  for (const node of passport.nodes) {
    sensitivityCounts[node.sensitivity] += 1;
  }

  const nodeById = new Map(passport.nodes.map((node) => [node.id, node]));
  const flows = passport.edges.flatMap((edge) => {
    const from = nodeById.get(edge.from_node_id);
    const to = nodeById.get(edge.to_node_id);
    if (!from || !to) return [];

    return [
      {
        id: edge.id,
        fromLabel: from.label,
        toLabel: to.label,
        purpose: edge.purpose,
        needsConfirmation: edge.needs_confirmation,
      },
    ];
  });

  return {
    nodeCount: passport.nodes.length,
    edgeCount: passport.edges.length,
    actionCount: passport.safety_actions.length,
    questionCount: passport.confirmation_questions.length,
    priorityCounts,
    sensitivityCounts,
    unknownFields: [...passport.audit.unknown_fields],
    flows,
  };
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
        message: `id「${item.id}」重複出現。`,
        relatedIds: [item.id],
      });
      return;
    }

    seen.add(item.id);
  });

  return issues;
}

function cycleIssues(
  passport: PassportDraft,
  nodeById: Map<string, PassportNode>,
): ValidationIssue[] {
  const adjacency = new Map<string, string[]>();
  for (const node of passport.nodes) adjacency.set(node.id, []);
  for (const edge of passport.edges) {
    if (
      edge.from_node_id !== edge.to_node_id &&
      nodeById.has(edge.from_node_id) &&
      nodeById.has(edge.to_node_id)
    ) {
      adjacency.get(edge.from_node_id)?.push(edge.to_node_id);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const signatures = new Set<string>();
  const issues: ValidationIssue[] = [];

  function visit(nodeId: string) {
    state.set(nodeId, 1);
    stack.push(nodeId);

    for (const nextId of adjacency.get(nodeId) ?? []) {
      const nextState = state.get(nextId) ?? 0;
      if (nextState === 0) {
        visit(nextId);
        continue;
      }
      if (nextState !== 1) continue;

      const cycleStart = stack.lastIndexOf(nextId);
      const cycle = [...stack.slice(cycleStart), nextId];
      const signature = [...new Set(cycle)].sort().join('|');
      if (signatures.has(signature)) continue;

      signatures.add(signature);
      issues.push({
        code: 'graph_cycle',
        category: 'graph',
        severity: 'warning',
        path: '$.passport_draft.edges',
        message: `資料流形成循環：${cycle.join(' → ')}。請確認是否為真實回流。`,
        relatedIds: cycle,
      });
    }

    stack.pop();
    state.set(nodeId, 2);
  }

  for (const nodeId of adjacency.keys()) {
    if ((state.get(nodeId) ?? 0) === 0) visit(nodeId);
  }

  return issues;
}

function graphIssues(passport: PassportDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...idIssues(passport.nodes, 'node', '$.passport_draft.nodes'),
    ...idIssues(passport.edges, 'edge', '$.passport_draft.edges'),
    ...idIssues(
      passport.safety_actions,
      'action',
      '$.passport_draft.safety_actions',
    ),
    ...idIssues(
      passport.confirmation_questions,
      'question',
      '$.passport_draft.confirmation_questions',
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
        message: `連線來源「${edge.from_node_id}」不存在。`,
        relatedIds: [edge.from_node_id],
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
        message: `連線目的地「${edge.to_node_id}」不存在。`,
        relatedIds: [edge.to_node_id],
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
        message: `連線「${edge.id}」的起點與終點相同。`,
        relatedIds: [edge.from_node_id],
      });
    }

    const transferKey = `${edge.from_node_id}|${edge.to_node_id}|${edge.purpose}`;
    if (transferKeys.has(transferKey)) {
      issues.push({
        code: 'duplicate_edge',
        category: 'graph',
        severity: 'warning',
        path: `$.passport_draft.edges[${index}]`,
        message: `相同用途的資料傳遞重複出現：${edge.purpose}。`,
        relatedIds: [edge.from_node_id, edge.to_node_id],
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
        message: `安全措施引用了不存在的節點「${nodeId}」。`,
        relatedIds: [nodeId],
      });
    });
  });

  passport.confirmation_questions.forEach((question, questionIndex) => {
    question.related_node_ids.forEach((nodeId, referenceIndex) => {
      if (nodeById.has(nodeId)) return;
      issues.push({
        code: 'invalid_question_reference',
        category: 'graph',
        severity: 'error',
        path: `$.passport_draft.confirmation_questions[${questionIndex}].related_node_ids[${referenceIndex}]`,
        message: `確認問題引用了不存在的節點「${nodeId}」。`,
        relatedIds: [nodeId],
      });
    });
  });

  passport.nodes.forEach((node, index) => {
    if (participatingNodeIds.has(node.id)) return;
    const informational = node.kind === 'person' || node.kind === 'organization';
    issues.push({
      code: 'orphan_node',
      category: 'graph',
      severity: informational ? 'info' : 'warning',
      path: `$.passport_draft.nodes[${index}]`,
      message: `節點「${node.label}」沒有連到任何資料流。`,
      relatedIds: [node.id],
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
        message: `保存位置「${storageLocation}」不是有效的 storage 節點。`,
        relatedIds: [storageLocation],
      });
    }
  }

  if (passport.sharing_scope.audience === 'public') {
    const hasConnectedDestination = passport.nodes.some(
      (node) =>
        node.kind === 'destination' && participatingNodeIds.has(node.id),
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
  return issues;
}

function readinessIssues(passport: PassportDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const confirmableIds = [
    ...passport.nodes
      .filter((node) => node.needs_confirmation)
      .map((node) => node.id),
    ...passport.edges
      .filter((edge) => edge.needs_confirmation)
      .map((edge) => edge.id),
  ];

  if (
    passport.sharing_scope.needs_confirmation ||
    passport.retention.needs_confirmation ||
    confirmableIds.length > 0
  ) {
    issues.push({
      code: 'confirmation_required',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft',
      message: '這份護照包含尚待本人確認的節點、連線、分享或保存資訊。',
      relatedIds: confirmableIds,
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

  const highSensitivityIds = passport.nodes
    .filter((node) => node.sensitivity === 'high')
    .map((node) => node.id);
  if (highSensitivityIds.length > 0) {
    issues.push({
      code: 'high_sensitivity_present',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft.nodes',
      message: `護照中有 ${highSensitivityIds.length} 個高敏感節點，需逐項確認處理方式。`,
      relatedIds: highSensitivityIds,
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

  const requestedTool = passport.administrative_hints.requested_tool;
  if (!requestedTool.trim() || requestedTool === 'unknown') {
    issues.push({
      code: 'unknown_tool',
      category: 'readiness',
      severity: 'warning',
      path: '$.passport_draft.administrative_hints.requested_tool',
      message: '申請使用的 AI 工具尚未指定。',
    });
  }

  if (passport.administrative_hints.requires_officer_review) {
    issues.push({
      code: 'officer_review_required',
      category: 'readiness',
      severity: 'info',
      path: '$.passport_draft.administrative_hints.requires_officer_review',
      message: '此草稿仍需要承辦人員複核。',
    });
  }

  return issues;
}

function stripJsonFence(raw: string): {
  json: string;
  issue: ValidationIssue | null;
} {
  const match = raw.match(/^```json\s*\n([\s\S]*?)\n```$/i);
  if (!match) return { json: raw, issue: null };

  return {
    json: match[1].trim(),
    issue: {
      code: 'markdown_fence',
      category: 'syntax',
      severity: 'warning',
      path: '$',
      message: '已移除 Markdown code fence；正式回傳應只包含 JSON。',
    },
  };
}

export function parseFlowPassJson(raw: string): FlowPassParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      status: 'invalid_json',
      passport: null,
      summary: null,
      issues: [
        {
          code: 'empty_input',
          category: 'syntax',
          severity: 'error',
          path: '$',
          message: '請貼上 AI 回傳的 FlowPass JSON。',
        },
      ],
    };
  }

  const fenced = stripJsonFence(trimmed);
  const initialIssues = fenced.issue ? [fenced.issue] : [];
  let value: unknown;
  try {
    value = JSON.parse(fenced.json);
  } catch {
    return {
      status: 'invalid_json',
      passport: null,
      summary: null,
      issues: [
        ...initialIssues,
        {
          code: 'invalid_json',
          category: 'syntax',
          severity: 'error',
          path: '$',
          message: 'JSON 格式無法解析，請檢查括號、引號或尾端逗號。',
        },
      ],
    };
  }

  if (!validatePassport(value)) {
    return {
      status: 'invalid_contract',
      passport: null,
      summary: null,
      issues: [
        ...initialIssues,
        ...(validatePassport.errors ?? []).map(schemaIssue),
      ],
    };
  }

  const passport = (value as { passport_draft: PassportDraft })
    .passport_draft;
  const issues = [
    ...initialIssues,
    ...graphIssues(passport),
    ...readinessIssues(passport),
  ];
  const hasGraphError = issues.some(
    (issue) => issue.category === 'graph' && issue.severity === 'error',
  );

  return {
    status: hasGraphError
      ? 'invalid_graph'
      : issues.length > 0
        ? 'valid_with_warnings'
        : 'valid',
    passport,
    issues,
    summary: buildSummary(passport),
  };
}
