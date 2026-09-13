import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface RuleEvaluationRow {
  id: string;
  case_id: string;
  passport_version_id: string | null;
  document_id: string | null;
  program_rule_version_id: string;
  evaluation_kind: string;
  outcome: string;
  result_json: string;
  input_snapshot_hash: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
}

/** Full rule-evaluation storage projection; only admin-scoped reads return it. */
export interface AdminRuleEvaluationRecord {
  id: string;
  caseId: string;
  passportVersionId: string | null;
  documentId: string | null;
  programRuleVersionId: string;
  evaluationKind: string;
  outcome: string;
  resultJson: string;
  inputSnapshotHash: string;
  actorType: string;
  actorId: string;
  createdAt: string;
}

/** Public-safe outcome summary for the authenticated case owner. */
export interface ApplicantRuleEvaluationRecord {
  id: string;
  caseId: string;
  evaluationKind: string;
  outcome: string;
  ruleCode: string | null;
  explanation: string | null;
  steps: Array<{ label: string; value: string }>;
  createdAt: string;
}

function mapAdminRuleEvaluation(row: RuleEvaluationRow): AdminRuleEvaluationRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    passportVersionId: row.passport_version_id,
    documentId: row.document_id,
    programRuleVersionId: row.program_rule_version_id,
    evaluationKind: row.evaluation_kind,
    outcome: row.outcome,
    resultJson: row.result_json,
    inputSnapshotHash: row.input_snapshot_hash,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

function mapApplicantRuleEvaluation(row: RuleEvaluationRow): ApplicantRuleEvaluationRecord {
  let ruleCode: string | null = null;
  let explanation: string | null = null;
  let steps: Array<{ label: string; value: string }> = [];
  try {
    const parsed = JSON.parse(row.result_json) as {
      ruleCode?: string;
      explanation?: string;
      steps?: Array<{ label?: string; value?: string }>;
    };
    ruleCode = typeof parsed.ruleCode === 'string' ? parsed.ruleCode : null;
    explanation = typeof parsed.explanation === 'string' ? parsed.explanation : null;
    if (Array.isArray(parsed.steps) && (parsed.ruleCode === 'subsidy_estimate' || parsed.ruleCode === 'admin_data_recalculation')) {
      steps = parsed.steps
        .filter((step): step is { label: string; value: string } => typeof step?.label === 'string' && typeof step?.value === 'string')
        .filter((step) => step.label !== '交易指紋');
    }
  } catch {
    /* keep empty public projection */
  }
  return {
    id: row.id,
    caseId: row.case_id,
    evaluationKind: row.evaluation_kind,
    outcome: row.outcome,
    ruleCode,
    explanation,
    steps,
    createdAt: row.created_at,
  };
}

export function listRuleEvaluationsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantRuleEvaluationRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT rule_evaluations.*
       FROM rule_evaluations
       JOIN cases ON cases.id = rule_evaluations.case_id
       WHERE rule_evaluations.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
       ORDER BY rule_evaluations.created_at DESC, rule_evaluations.id DESC`,
    )
    .all(caseId, scope.applicantId) as RuleEvaluationRow[];

  return rows.map(mapApplicantRuleEvaluation);
}

export function listRuleEvaluationsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminRuleEvaluationRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT rule_evaluations.* FROM rule_evaluations
       JOIN cases ON cases.id = rule_evaluations.case_id
       WHERE rule_evaluations.case_id = ? AND cases.deleted_at IS NULL ORDER BY rule_evaluations.created_at DESC, rule_evaluations.id DESC`,
    )
    .all(caseId) as RuleEvaluationRow[];

  return rows.map(mapAdminRuleEvaluation);
}
