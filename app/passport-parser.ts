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

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {
      status: 'invalid_json',
      passport: null,
      summary: null,
      issues: [
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
      issues: (validatePassport.errors ?? []).map(schemaIssue),
    };
  }

  const passport = (value as { passport_draft: PassportDraft })
    .passport_draft;

  return {
    status: 'valid',
    passport,
    issues: [],
    summary: buildSummary(passport),
  };
}
