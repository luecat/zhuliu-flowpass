import {
  collectPassportDiagnostics,
  inspectPassportJson,
} from '../server/domain/passport-validation';
import type {
  FlowPassPassport,
  PassportDraft,
  QuestionPriority,
  Sensitivity,
  ValidationIssue,
} from '../shared/passport-contract';

export { NODE_KIND_GUIDE, PASSPORT_JSON_SCHEMA } from '../shared/passport-contract';
export type {
  ConfirmationQuestion,
  IssueCategory,
  IssueSeverity,
  PassportDraft,
  PassportEdge,
  PassportNode,
  QuestionPriority,
  SafetyAction,
  Sensitivity,
  ValidationIssue,
} from '../shared/passport-contract';

export type ParseStatus =
  | 'invalid_json'
  | 'invalid_contract'
  | 'invalid_graph'
  | 'valid_with_warnings'
  | 'valid';

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

function projectLegacyPath(path: string): string {
  return path
    .replace('.follow_up_questions', '.confirmation_questions')
    .replaceAll('.relatedNodeIds', '.related_node_ids')
    .replaceAll('.prompt', '.question');
}

function projectLegacyIssue(issue: ValidationIssue): ValidationIssue {
  return { ...issue, path: projectLegacyPath(issue.path) };
}

function projectLegacyPassport(passport: FlowPassPassport): PassportDraft {
  return {
    use_case: passport.use_case,
    nodes: passport.nodes.map((node) => ({ ...node })),
    edges: passport.edges.map((edge) => ({ ...edge })),
    sharing_scope: { ...passport.sharing_scope },
    retention: passport.retention,
    safety_actions: passport.safety_actions,
    administrative_hints: passport.administrative_hints,
    audit: passport.audit,
    confirmation_questions: passport.follow_up_questions.map((question) => ({
      id: question.id,
      question: question.prompt,
      reason: question.reason,
      related_node_ids: [...question.relatedNodeIds],
      priority: question.priority,
      version: question.version,
      answerSchema: question.answerSchema,
      required: question.required,
      status: question.status,
    })),
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
  passport.confirmation_questions.forEach((question) => {
    priorityCounts[question.priority] += 1;
  });
  passport.nodes.forEach((node) => {
    sensitivityCounts[node.sensitivity] += 1;
  });
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

function markdownFenceIssue(raw: string): ValidationIssue | null {
  return /^```json\s*\r?\n[\s\S]*?\r?\n```$/i.test(raw.trim())
    ? {
        code: 'markdown_fence',
        category: 'syntax',
        severity: 'warning',
        path: '$',
        message: '已移除 Markdown code fence；正式回傳應只包含 JSON。',
      }
    : null;
}

function repairIssues(
  repairs: Array<{
    path: string;
    nodeId: string;
    from: string;
  }>,
): ValidationIssue[] {
  return repairs.map((repair) => ({
    code: 'normalized_node_kind',
    category: 'schema',
    severity: 'warning',
    path: projectLegacyPath(repair.path),
    message: `已將節點 kind「${repair.from}」修正為「data」；內容格式應放在 data_category。`,
    relatedIds: repair.nodeId ? [repair.nodeId] : undefined,
  }));
}

/**
 * Studio compatibility adapter. Validation, repair, redaction, and graph
 * checks are delegated to the one canonical server/domain validator.
 */
export function parseFlowPassJson(raw: string): FlowPassParseResult {
  const fenceIssue = markdownFenceIssue(raw);
  const inspection = inspectPassportJson(raw);
  const initialIssues = fenceIssue ? [fenceIssue] : [];

  if (!inspection.validation.ok) {
    const diagnostics = inspection.diagnostics.length
      ? inspection.diagnostics
      : inspection.validation.errors;
    const issues = [...initialIssues, ...diagnostics.map(projectLegacyIssue)];
    const hasSyntaxError = issues.some(
      (issue) => issue.category === 'syntax' && issue.severity === 'error',
    );
    const hasGraphError = issues.some(
      (issue) => issue.category === 'graph' && issue.severity === 'error',
    );
    const passport = inspection.canonical
      ? projectLegacyPassport(inspection.canonical)
      : null;
    return {
      status: hasSyntaxError
        ? 'invalid_json'
        : hasGraphError
          ? 'invalid_graph'
          : 'invalid_contract',
      passport,
      issues,
      summary: passport ? buildSummary(passport) : null,
    };
  }

  const passport = projectLegacyPassport(inspection.validation.value);
  const issues = [
    ...initialIssues,
    ...repairIssues(inspection.validation.repairs),
    ...collectPassportDiagnostics(inspection.validation.value).map(
      projectLegacyIssue,
    ),
  ];
  return {
    status: issues.length > 0 ? 'valid_with_warnings' : 'valid',
    passport,
    issues,
    summary: buildSummary(passport),
  };
}
