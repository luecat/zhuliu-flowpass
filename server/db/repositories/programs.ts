import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface ProgramCycleRow {
  id: string;
  code: string;
  name: string;
  year: number;
  status: string;
  retention_policy_json: string;
  created_at: string;
  updated_at: string;
  row_version: number;
}

/** Full program-cycle storage projection; only admin-scoped reads return it. */
export interface AdminProgramCycleRecord {
  id: string;
  code: string;
  name: string;
  year: number;
  status: string;
  retentionPolicyJson: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface ApplicantProgramCycleRecord {
  id: string;
  code: string;
  name: string;
  year: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

interface ProgramRuleVersionRow {
  id: string;
  program_cycle_id: string;
  version_no: number;
  status: string;
  application_start_at: string | null;
  application_end_at: string | null;
  purchase_start_at: string | null;
  purchase_end_at: string | null;
  subsidy_rate_bps: number;
  per_case_cap_twd: number;
  rounding_mode: string;
  required_documents_json: string;
  rules_json: string;
  published_at: string | null;
  published_by_admin_id: string | null;
  created_at: string;
}

/** Full rule-version storage projection; only admin-scoped reads return it. */
export interface AdminProgramRuleVersionRecord {
  id: string;
  programCycleId: string;
  versionNo: number;
  status: string;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  purchaseStartAt: string | null;
  purchaseEndAt: string | null;
  subsidyRateBps: number;
  perCaseCapTwd: number;
  roundingMode: string;
  requiredDocumentsJson: string;
  rulesJson: string;
  publishedAt: string | null;
  publishedByAdminId: string | null;
  createdAt: string;
}

/** Published program rules without an administrator identity. */
export interface ApplicantProgramRuleVersionRecord {
  id: string;
  programCycleId: string;
  versionNo: number;
  status: string;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  purchaseStartAt: string | null;
  purchaseEndAt: string | null;
  subsidyRateBps: number;
  perCaseCapTwd: number;
  roundingMode: string;
  requiredDocumentsJson: string;
  rulesJson: string;
  publishedAt: string | null;
  createdAt: string;
}

function mapAdminProgramCycle(row: ProgramCycleRow): AdminProgramCycleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    year: row.year,
    status: row.status,
    retentionPolicyJson: row.retention_policy_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

function mapApplicantProgramCycle(row: ProgramCycleRow): ApplicantProgramCycleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    year: row.year,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

function mapAdminProgramRuleVersion(row: ProgramRuleVersionRow): AdminProgramRuleVersionRecord {
  return {
    id: row.id,
    programCycleId: row.program_cycle_id,
    versionNo: row.version_no,
    status: row.status,
    applicationStartAt: row.application_start_at,
    applicationEndAt: row.application_end_at,
    purchaseStartAt: row.purchase_start_at,
    purchaseEndAt: row.purchase_end_at,
    subsidyRateBps: row.subsidy_rate_bps,
    perCaseCapTwd: row.per_case_cap_twd,
    roundingMode: row.rounding_mode,
    requiredDocumentsJson: row.required_documents_json,
    rulesJson: row.rules_json,
    publishedAt: row.published_at,
    publishedByAdminId: row.published_by_admin_id,
    createdAt: row.created_at,
  };
}

function mapApplicantProgramRuleVersion(
  row: ProgramRuleVersionRow,
): ApplicantProgramRuleVersionRecord {
  return {
    id: row.id,
    programCycleId: row.program_cycle_id,
    versionNo: row.version_no,
    status: row.status,
    applicationStartAt: row.application_start_at,
    applicationEndAt: row.application_end_at,
    purchaseStartAt: row.purchase_start_at,
    purchaseEndAt: row.purchase_end_at,
    subsidyRateBps: row.subsidy_rate_bps,
    perCaseCapTwd: row.per_case_cap_twd,
    roundingMode: row.rounding_mode,
    requiredDocumentsJson: row.required_documents_json,
    rulesJson: row.rules_json,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

export function listActiveProgramCyclesForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
): ApplicantProgramCycleRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(`SELECT * FROM program_cycles WHERE status = 'active' ORDER BY year DESC, code ASC`)
    .all() as ProgramCycleRow[];

  return rows.map(mapApplicantProgramCycle);
}

export function listProgramCyclesForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
): AdminProgramCycleRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT * FROM program_cycles ORDER BY year DESC, code ASC')
    .all() as ProgramCycleRow[];

  return rows.map(mapAdminProgramCycle);
}

export function listPublishedRuleVersionsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  programCycleId: string,
): ApplicantProgramRuleVersionRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT * FROM program_rule_versions
       WHERE program_cycle_id = ? AND status = 'published'
       ORDER BY version_no DESC`,
    )
    .all(programCycleId) as ProgramRuleVersionRow[];

  return rows.map(mapApplicantProgramRuleVersion);
}

export function listProgramRuleVersionsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  programCycleId: string,
): AdminProgramRuleVersionRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT * FROM program_rule_versions WHERE program_cycle_id = ? ORDER BY version_no DESC')
    .all(programCycleId) as ProgramRuleVersionRow[];

  return rows.map(mapAdminProgramRuleVersion);
}

export interface CreateDraftProgramRuleVersionInput {
  sourceRuleVersionId: string;
  id: string;
  createdAt: string;
  applicationStartAt?: string | null;
  applicationEndAt?: string | null;
  purchaseStartAt?: string | null;
  purchaseEndAt?: string | null;
  subsidyRateBps?: number;
  perCaseCapTwd?: number;
  roundingMode?: 'floor' | 'half_up';
  requiredDocumentsJson?: string;
  rulesJson?: string;
}

/**
 * Published rules are immutable. An editor therefore starts from a published
 * (or draft) snapshot and inserts a new draft version; it never updates the
 * source row. Application and purchase windows remain separate fields.
 */
export function createDraftProgramRuleVersionForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  input: CreateDraftProgramRuleVersionInput,
): AdminProgramRuleVersionRecord {
  requireAdminScope(scope);
  const source = database
    .prepare('SELECT * FROM program_rule_versions WHERE id = ?')
    .get(input.sourceRuleVersionId) as ProgramRuleVersionRow | undefined;
  if (!source) throw new Error('Program rule version is not available');

  const versionNo = (database
    .prepare('SELECT COALESCE(MAX(version_no), 0) AS version FROM program_rule_versions WHERE program_cycle_id = ?')
    .get(source.program_cycle_id) as { version: number }).version + 1;
  database
    .prepare(
      `INSERT INTO program_rule_versions (
        id, program_cycle_id, version_no, status,
        application_start_at, application_end_at, purchase_start_at, purchase_end_at,
        subsidy_rate_bps, per_case_cap_twd, rounding_mode,
        required_documents_json, rules_json, published_at, published_by_admin_id, created_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      input.id,
      source.program_cycle_id,
      versionNo,
      input.applicationStartAt === undefined ? source.application_start_at : input.applicationStartAt,
      input.applicationEndAt === undefined ? source.application_end_at : input.applicationEndAt,
      input.purchaseStartAt === undefined ? source.purchase_start_at : input.purchaseStartAt,
      input.purchaseEndAt === undefined ? source.purchase_end_at : input.purchaseEndAt,
      input.subsidyRateBps === undefined ? source.subsidy_rate_bps : input.subsidyRateBps,
      input.perCaseCapTwd === undefined ? source.per_case_cap_twd : input.perCaseCapTwd,
      input.roundingMode === undefined ? source.rounding_mode : input.roundingMode,
      input.requiredDocumentsJson === undefined ? source.required_documents_json : input.requiredDocumentsJson,
      input.rulesJson === undefined ? source.rules_json : input.rulesJson,
      input.createdAt,
    );
  const created = database
    .prepare('SELECT * FROM program_rule_versions WHERE id = ?')
    .get(input.id) as ProgramRuleVersionRow | undefined;
  if (!created) throw new Error('Draft rule version could not be read');
  return mapAdminProgramRuleVersion(created);
}

export function publishProgramRuleVersionForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  input: { ruleVersionId: string; adminId: string; publishedAt: string },
): AdminProgramRuleVersionRecord {
  requireAdminScope(scope);
  const result = database
    .prepare(
      `UPDATE program_rule_versions
       SET status = 'published', published_at = ?, published_by_admin_id = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .run(input.publishedAt, input.adminId, input.ruleVersionId);
  if (result.changes !== 1) throw new Error('Only a draft rule version can be published');
  const published = database
    .prepare('SELECT * FROM program_rule_versions WHERE id = ?')
    .get(input.ruleVersionId) as ProgramRuleVersionRow | undefined;
  if (!published) throw new Error('Published rule version could not be read');
  return mapAdminProgramRuleVersion(published);
}
