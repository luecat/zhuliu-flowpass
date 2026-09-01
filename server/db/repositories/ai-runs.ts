import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface AiRunRow {
  id: string;
  case_id: string;
  passport_version_id: string | null;
  operation: 'draft' | 'revise';
  adapter: 'lm_studio';
  model_id: string;
  prompt_version: string;
  schema_version: string;
  input_hash: string;
  output_hash: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  result_code: string;
  repair_count: number;
  created_at: string;
}

/** Full AI-run storage projection; only admin-scoped reads return it. */
export interface AdminAiRunRecord {
  id: string;
  caseId: string;
  passportVersionId: string | null;
  operation: 'draft' | 'revise';
  adapter: 'lm_studio';
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: string;
  outputHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  resultCode: string;
  repairCount: number;
  createdAt: string;
}

/** Public-safe AI operation status for the authenticated case owner. */
export interface ApplicantAiRunRecord {
  id: string;
  caseId: string;
  operation: 'draft' | 'revise';
  resultCode: string;
  createdAt: string;
}

function mapAdminAiRun(row: AiRunRow): AdminAiRunRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    passportVersionId: row.passport_version_id,
    operation: row.operation,
    adapter: row.adapter,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    durationMs: row.duration_ms,
    resultCode: row.result_code,
    repairCount: row.repair_count,
    createdAt: row.created_at,
  };
}

function mapApplicantAiRun(row: AiRunRow): ApplicantAiRunRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    operation: row.operation,
    resultCode: row.result_code,
    createdAt: row.created_at,
  };
}

export function listAiRunsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantAiRunRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT ai_runs.*
       FROM ai_runs
       JOIN cases ON cases.id = ai_runs.case_id
       WHERE ai_runs.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
       ORDER BY ai_runs.created_at DESC, ai_runs.id DESC`,
    )
    .all(caseId, scope.applicantId) as AiRunRow[];

  return rows.map(mapApplicantAiRun);
}

export function listAiRunsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminAiRunRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT ai_runs.* FROM ai_runs JOIN cases ON cases.id = ai_runs.case_id WHERE ai_runs.case_id = ? AND cases.deleted_at IS NULL ORDER BY ai_runs.created_at DESC, ai_runs.id DESC')
    .all(caseId) as AiRunRow[];

  return rows.map(mapAdminAiRun);
}
