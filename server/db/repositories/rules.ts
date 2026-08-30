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
  return {
    id: row.id,
    caseId: row.case_id,
    evaluationKind: row.evaluation_kind,
    outcome: row.outcome,
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
       WHERE rule_evaluations.case_id = ? AND cases.applicant_id = ?
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
      `SELECT * FROM rule_evaluations
       WHERE case_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(caseId) as RuleEvaluationRow[];

  return rows.map(mapAdminRuleEvaluation);
}
