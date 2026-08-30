import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { encryptDatabaseText } from './encrypted-fields';
import {
  requireAdminScope,
  requireApplicantScope,
  requireSystemScope,
  type AdminScope,
  type ApplicantScope,
  type SystemScope,
} from './scopes';

export interface PassportRecord {
  id: string;
  caseId: string;
  createdAt: string;
}

/** Full passport-version storage projection; only admin-scoped reads return it. */
export interface AdminPassportVersionRecord {
  id: string;
  passportId: string;
  versionNo: number;
  parentVersionId: string | null;
  origin: string;
  workflowState: string;
  schemaVersion: string;
  answerVersionId: string;
  programRuleVersionId: string;
  payloadEnc: string;
  contentSha256: string;
  createdByType: string;
  createdById: string;
  createdAt: string;
}

/** Deliberately public-safe passport version summary for the case owner. */
export interface ApplicantPassportVersionRecord {
  id: string;
  versionNo: number;
  origin: string;
  workflowState: string;
  schemaVersion: string;
  createdAt: string;
}

interface PassportRow {
  id: string;
  case_id: string;
  created_at: string;
}

interface PassportVersionRow {
  id: string;
  passport_id: string;
  version_no: number;
  parent_version_id: string | null;
  origin: string;
  workflow_state: string;
  schema_version: string;
  answer_version_id: string;
  program_rule_version_id: string;
  payload_enc: string;
  content_sha256: string;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
}

function mapPassport(row: PassportRow): PassportRecord {
  return { id: row.id, caseId: row.case_id, createdAt: row.created_at };
}

function mapAdminPassportVersion(row: PassportVersionRow): AdminPassportVersionRecord {
  return {
    id: row.id,
    passportId: row.passport_id,
    versionNo: row.version_no,
    parentVersionId: row.parent_version_id,
    origin: row.origin,
    workflowState: row.workflow_state,
    schemaVersion: row.schema_version,
    answerVersionId: row.answer_version_id,
    programRuleVersionId: row.program_rule_version_id,
    payloadEnc: row.payload_enc,
    contentSha256: row.content_sha256,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    createdAt: row.created_at,
  };
}

function mapApplicantPassportVersion(row: PassportVersionRow): ApplicantPassportVersionRecord {
  return {
    id: row.id,
    versionNo: row.version_no,
    origin: row.origin,
    workflowState: row.workflow_state,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

export function getPassportForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): PassportRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT passports.id, passports.case_id, passports.created_at
       FROM passports
       JOIN cases ON cases.id = passports.case_id
       WHERE passports.case_id = ? AND cases.applicant_id = ?`,
    )
    .get(caseId, scope.applicantId) as PassportRow | undefined;

  return row ? mapPassport(row) : null;
}

export function getPassportForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): PassportRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare('SELECT id, case_id, created_at FROM passports WHERE case_id = ?')
    .get(caseId) as PassportRow | undefined;

  return row ? mapPassport(row) : null;
}

export function listPassportVersionsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantPassportVersionRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT passport_versions.*
       FROM passport_versions
       JOIN passports ON passports.id = passport_versions.passport_id
       JOIN cases ON cases.id = passports.case_id
       WHERE cases.id = ? AND cases.applicant_id = ?
       ORDER BY passport_versions.version_no DESC`,
    )
    .all(caseId, scope.applicantId) as PassportVersionRow[];

  return rows.map(mapApplicantPassportVersion);
}

export function listPassportVersionsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminPassportVersionRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT passport_versions.*
       FROM passport_versions
       JOIN passports ON passports.id = passport_versions.passport_id
       WHERE passports.case_id = ?
       ORDER BY passport_versions.version_no DESC`,
    )
    .all(caseId) as PassportVersionRow[];

  return rows.map(mapAdminPassportVersion);
}

export function insertEncryptedPassportVersionForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    passportId: string;
    versionNo: number;
    parentVersionId: string | null;
    origin: 'ai_draft' | 'applicant_revision' | 'admin_supplement';
    workflowState:
      | 'ai_drafting'
      | 'follow_up_required'
      | 'needs_applicant_confirmation'
      | 'confirmed'
      | 'locked';
    schemaVersion: string;
    answerVersionId: string;
    programRuleVersionId: string;
    payload: string;
    contentSha256: string;
    createdByType: string;
    createdById: string;
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO passport_versions (
        id, passport_id, version_no, parent_version_id, origin, workflow_state, schema_version,
        answer_version_id, program_rule_version_id, payload_enc, content_sha256,
        created_by_type, created_by_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.passportId,
      input.versionNo,
      input.parentVersionId,
      input.origin,
      input.workflowState,
      input.schemaVersion,
      input.answerVersionId,
      input.programRuleVersionId,
      encryptDatabaseText(crypto, 'passport_versions', 'payload_enc', input.id, input.payload),
      input.contentSha256,
      input.createdByType,
      input.createdById,
      input.createdAt,
    );
}

export function insertEncryptedPassportToolIndexForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    passportVersionId: string;
    nodeKey: string;
    toolProductId: string;
    toolVersionId: string | null;
    userVisibleLabel: string | null;
    usageStartAt: string | null;
    usageEndAt: string | null;
    needsConfirmation: boolean;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO passport_tool_index (
        id, passport_version_id, node_key, tool_product_id, tool_version_id, user_visible_label_enc,
        usage_start_at, usage_end_at, needs_confirmation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.passportVersionId,
      input.nodeKey,
      input.toolProductId,
      input.toolVersionId,
      input.userVisibleLabel == null
        ? null
        : encryptDatabaseText(
            crypto,
            'passport_tool_index',
            'user_visible_label_enc',
            input.id,
            input.userVisibleLabel,
          ),
      input.usageStartAt,
      input.usageEndAt,
      input.needsConfirmation ? 1 : 0,
    );
}

export function insertEncryptedPassportFollowUpQuestionForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    passportVersionId: string;
    questionKey: string;
    versionNo: number;
    prompt: string;
    reason: string;
    answerSchemaJson: string;
    required: boolean;
    relatedNodeKeysJson: string;
    priority: 'high' | 'medium' | 'low';
    status: 'open' | 'answered' | 'superseded';
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO passport_follow_up_questions (
        id, passport_version_id, question_key, version_no, prompt_enc, reason_enc,
        answer_schema_json, required, related_node_keys_json, priority, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.passportVersionId,
      input.questionKey,
      input.versionNo,
      encryptDatabaseText(crypto, 'passport_follow_up_questions', 'prompt_enc', input.id, input.prompt),
      encryptDatabaseText(crypto, 'passport_follow_up_questions', 'reason_enc', input.id, input.reason),
      input.answerSchemaJson,
      input.required ? 1 : 0,
      input.relatedNodeKeysJson,
      input.priority,
      input.status,
      input.createdAt,
    );
}

export function insertEncryptedPassportFollowUpAnswerForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    questionId: string;
    passportVersionId: string;
    answer: string;
    answeredByApplicantId: string;
    answeredAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO passport_follow_up_answers (
        id, question_id, passport_version_id, answer_enc, answer_hash,
        answered_by_applicant_id, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.questionId,
      input.passportVersionId,
      encryptDatabaseText(crypto, 'passport_follow_up_answers', 'answer_enc', input.id, input.answer),
      crypto.hmacLookup(input.answer, 'passport-follow-up-answer'),
      input.answeredByApplicantId,
      input.answeredAt,
    );
}
