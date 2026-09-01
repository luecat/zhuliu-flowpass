import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { encryptDatabaseText } from './encrypted-fields';
import { decryptDatabaseText } from './encrypted-fields';
import { validateCoreAnswers, type CoreAnswers } from '../../../shared/case-contract';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

export type { AdminScope, ApplicantScope } from './scopes';

interface CaseRow {
  id: string;
  case_code: string;
  applicant_id: string;
  program_cycle_id: string;
  program_rule_version_id: string;
  state: string;
  current_answer_version_id: string | null;
  current_passport_version_id: string | null;
  submitted_answer_version_id: string | null;
  submitted_passport_version_id: string | null;
  approved_passport_version_id: string | null;
  requested_amount_twd: number | null;
  calculated_amount_twd: number | null;
  approved_amount_twd: number | null;
  disbursed_amount_twd: number | null;
  title_enc: string | null;
  decision_reason_enc: string | null;
  submitted_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
}

/** Full case storage projection; only admin-scoped repository functions return it. */
export interface AdminCaseRecord {
  id: string;
  caseCode: string;
  applicantId: string;
  programCycleId: string;
  programRuleVersionId: string;
  state: string;
  currentAnswerVersionId: string | null;
  currentPassportVersionId: string | null;
  submittedAnswerVersionId: string | null;
  submittedPassportVersionId: string | null;
  approvedPassportVersionId: string | null;
  requestedAmountTwd: number | null;
  calculatedAmountTwd: number | null;
  approvedAmountTwd: number | null;
  disbursedAmountTwd: number | null;
  titleEnc: string | null;
  decisionReasonEnc: string | null;
  submittedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

/** Deliberately public-safe projection for an authenticated case owner. */
export interface ApplicantCaseRecord {
  id: string;
  caseCode: string;
  state: string;
  requestedAmountTwd: number | null;
  calculatedAmountTwd: number | null;
  approvedAmountTwd: number | null;
  submittedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

const CASE_COLUMNS = `
  id,
  case_code,
  applicant_id,
  program_cycle_id,
  program_rule_version_id,
  state,
  current_answer_version_id,
  current_passport_version_id,
  submitted_answer_version_id,
  submitted_passport_version_id,
  approved_passport_version_id,
  requested_amount_twd,
  calculated_amount_twd,
  approved_amount_twd,
  disbursed_amount_twd,
  title_enc,
  decision_reason_enc,
  submitted_at,
  closed_at,
  created_at,
  updated_at,
  row_version
`;

function mapAdminCase(row: CaseRow): AdminCaseRecord {
  return {
    id: row.id,
    caseCode: row.case_code,
    applicantId: row.applicant_id,
    programCycleId: row.program_cycle_id,
    programRuleVersionId: row.program_rule_version_id,
    state: row.state,
    currentAnswerVersionId: row.current_answer_version_id,
    currentPassportVersionId: row.current_passport_version_id,
    submittedAnswerVersionId: row.submitted_answer_version_id,
    submittedPassportVersionId: row.submitted_passport_version_id,
    approvedPassportVersionId: row.approved_passport_version_id,
    requestedAmountTwd: row.requested_amount_twd,
    calculatedAmountTwd: row.calculated_amount_twd,
    approvedAmountTwd: row.approved_amount_twd,
    disbursedAmountTwd: row.disbursed_amount_twd,
    titleEnc: row.title_enc,
    decisionReasonEnc: row.decision_reason_enc,
    submittedAt: row.submitted_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

function mapApplicantCase(row: CaseRow): ApplicantCaseRecord {
  return {
    id: row.id,
    caseCode: row.case_code,
    state: row.state,
    requestedAmountTwd: row.requested_amount_twd,
    calculatedAmountTwd: row.calculated_amount_twd,
    approvedAmountTwd: row.approved_amount_twd,
    submittedAt: row.submitted_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

export function getCaseForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantCaseRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = ? AND applicant_id = ? AND deleted_at IS NULL`)
    .get(caseId, scope.applicantId) as CaseRow | undefined;

  return row ? mapApplicantCase(row) : null;
}

export function listCasesForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  cursor?: string,
): ApplicantCaseRecord[] {
  requireApplicantScope(scope);
  const rows = cursor
    ? database
        .prepare(
          `SELECT ${CASE_COLUMNS}
           FROM cases
           WHERE applicant_id = ? AND deleted_at IS NULL AND state <> 'draft' AND id < ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(scope.applicantId, cursor)
    : database
        .prepare(
          `SELECT ${CASE_COLUMNS}
           FROM cases
           WHERE applicant_id = ? AND deleted_at IS NULL AND state <> 'draft'
           ORDER BY created_at DESC, id DESC`,
        )
        .all(scope.applicantId);

  return (rows as CaseRow[]).map(mapApplicantCase);
}

/** Returns only the current answer version for the authenticated case owner. */
export function getCurrentAnswersForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  caseId: string,
): CoreAnswers | null {
  requireApplicantScope(scope);
  const row = database.prepare(
    `SELECT a.id, a.answers_enc
       FROM cases c
       JOIN answer_versions a ON a.id = c.current_answer_version_id
       WHERE c.id = ? AND c.applicant_id = ? AND c.deleted_at IS NULL`,
  ).get(caseId, scope.applicantId) as { id: string; answers_enc: string } | undefined;
  if (!row) return null;
  try {
    return validateCoreAnswers(JSON.parse(
      decryptDatabaseText(crypto, 'answer_versions', 'answers_enc', row.id, row.answers_enc),
    ));
  } catch {
    throw new Error('Current answers are unavailable');
  }
}

export function getCaseForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminCaseRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = ? AND deleted_at IS NULL`)
    .get(caseId) as CaseRow | undefined;

  return row ? mapAdminCase(row) : null;
}

/**
 * Encrypts the mutable case fields before a later state-command repository writes
 * them. Task 6 remains responsible for If-Match and state transitions.
 */
export function encryptCaseSensitiveFields(
  crypto: FieldCrypto,
  caseId: string,
  input: { title?: string | null; decisionReason?: string | null },
): { titleEnc: string | null; decisionReasonEnc: string | null } {
  return {
    titleEnc:
      input.title == null
        ? null
        : encryptDatabaseText(crypto, 'cases', 'title_enc', caseId, input.title),
    decisionReasonEnc:
      input.decisionReason == null
        ? null
        : encryptDatabaseText(crypto, 'cases', 'decision_reason_enc', caseId, input.decisionReason),
  };
}

export function insertEncryptedAnswerVersionForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    caseId: string;
    versionNo: number;
    answers: string;
    contentSha256: string;
    createdAt: string;
  },
): void {
  requireApplicantScope(scope);
  const ownedCase = database
    .prepare('SELECT id FROM cases WHERE id = ? AND applicant_id = ? AND deleted_at IS NULL')
    .get(input.caseId, scope.applicantId) as { id: string } | undefined;
  if (!ownedCase) {
    throw new Error('Case is not available');
  }

  database
    .prepare(
      `INSERT INTO answer_versions (
        id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.caseId,
      input.versionNo,
      encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', input.id, input.answers),
      input.contentSha256,
      scope.applicantId,
      input.createdAt,
    );
}

export function insertEncryptedCaseStateTransitionForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    caseId: string;
    sequenceNo: number;
    fromState: string | null;
    toState: string;
    reasonCode: string | null;
    reason: string | null;
    actorType: 'applicant' | 'admin' | 'system';
    actorId: string;
    createdAt: string;
  },
): void {
  requireAdminScope(scope);
  database
    .prepare(
      `INSERT INTO case_state_transitions (
        id, case_id, sequence_no, from_state, to_state, reason_code, reason_enc,
        actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.caseId,
      input.sequenceNo,
      input.fromState,
      input.toState,
      input.reasonCode,
      input.reason == null
        ? null
        : encryptDatabaseText(crypto, 'case_state_transitions', 'reason_enc', input.id, input.reason),
      input.actorType,
      input.actorId,
      input.createdAt,
    );
}
