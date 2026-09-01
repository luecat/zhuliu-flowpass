import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { decryptDatabaseText, encryptDatabaseText } from './encrypted-fields';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface CaseTaskRow {
  id: string;
  case_id: string;
  alert_id: string | null;
  task_type: string;
  title: string;
  instructions_enc: string;
  accepted_document_types_json: string;
  due_at: string | null;
  status: string;
  created_by_type: string;
  created_by_id: string;
  completed_at: string | null;
  created_at: string;
  row_version: number;
}

/** Full task storage projection; only admin-scoped reads return it. */
export interface AdminCaseTaskRecord {
  id: string;
  caseId: string;
  alertId: string | null;
  taskType: string;
  title: string;
  instructionsEnc: string;
  acceptedDocumentTypesJson: string;
  dueAt: string | null;
  status: string;
  createdByType: string;
  createdById: string;
  completedAt: string | null;
  createdAt: string;
  rowVersion: number;
}

/** Deliberately public-safe task details for the task's case owner. */
export interface ApplicantCaseTaskRecord {
  id: string;
  caseId: string;
  caseRowVersion: number;
  taskType: string;
  title: string;
  instructions: string;
  acceptedDocumentTypes: string[];
  dueAt: string | null;
  status: string;
  completedAt: string | null;
  createdAt: string;
  rowVersion: number;
}

function mapAdminCaseTask(row: CaseTaskRow): AdminCaseTaskRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    alertId: row.alert_id,
    taskType: row.task_type,
    title: row.title,
    instructionsEnc: row.instructions_enc,
    acceptedDocumentTypesJson: row.accepted_document_types_json,
    dueAt: row.due_at,
    status: row.status,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    rowVersion: row.row_version,
  };
}

function mapApplicantCaseTask(row: CaseTaskRow & { case_row_version: number }, crypto: FieldCrypto): ApplicantCaseTaskRecord {
  let acceptedDocumentTypes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.accepted_document_types_json);
    if (Array.isArray(parsed)) acceptedDocumentTypes = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    acceptedDocumentTypes = [];
  }
  return {
    id: row.id,
    caseId: row.case_id,
    caseRowVersion: row.case_row_version,
    taskType: row.task_type,
    title: row.title,
    instructions: decryptDatabaseText(crypto, 'case_tasks', 'instructions_enc', row.id, row.instructions_enc),
    acceptedDocumentTypes,
    dueAt: row.due_at,
    status: row.status,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    rowVersion: row.row_version,
  };
}

export function getCaseTaskForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  taskId: string,
): ApplicantCaseTaskRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT case_tasks.*, cases.row_version AS case_row_version
       FROM case_tasks
       JOIN cases ON cases.id = case_tasks.case_id
       WHERE case_tasks.id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL`,
    )
    .get(taskId, scope.applicantId) as (CaseTaskRow & { case_row_version: number }) | undefined;

  return row ? mapApplicantCaseTask(row, crypto) : null;
}

export function listCaseTasksForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  caseId: string,
): ApplicantCaseTaskRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT case_tasks.*, cases.row_version AS case_row_version
       FROM case_tasks
       JOIN cases ON cases.id = case_tasks.case_id
       WHERE case_tasks.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
       ORDER BY case_tasks.created_at DESC, case_tasks.id DESC`,
    )
    .all(caseId, scope.applicantId) as Array<CaseTaskRow & { case_row_version: number }>;

  return rows.map((row) => mapApplicantCaseTask(row, crypto));
}

export function listAllCaseTasksForApplicant(database: FlowPassDatabase, scope: ApplicantScope, crypto: FieldCrypto): ApplicantCaseTaskRecord[] {
  requireApplicantScope(scope);
  const rows = database.prepare(`SELECT case_tasks.*, cases.row_version AS case_row_version FROM case_tasks JOIN cases ON cases.id = case_tasks.case_id WHERE cases.applicant_id = ? AND cases.deleted_at IS NULL ORDER BY case_tasks.created_at DESC, case_tasks.id DESC`).all(scope.applicantId) as Array<CaseTaskRow & { case_row_version: number }>;
  return rows.map((row) => mapApplicantCaseTask(row, crypto));
}

export function getCaseTaskForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  taskId: string,
): AdminCaseTaskRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare('SELECT case_tasks.* FROM case_tasks JOIN cases ON cases.id = case_tasks.case_id WHERE case_tasks.id = ? AND cases.deleted_at IS NULL')
    .get(taskId) as CaseTaskRow | undefined;

  return row ? mapAdminCaseTask(row) : null;
}

export function insertEncryptedCaseTaskForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    caseId: string;
    alertId: string | null;
    taskType:
      | 'provide_document'
      | 'revise_passport'
      | 'reconfirm_passport'
      | 'incident_acknowledgement'
      | 'incident_remediation';
    title: string;
    instructions: string;
    acceptedDocumentTypesJson: string;
    dueAt: string | null;
    status: 'open' | 'opened' | 'completed' | 'cancelled' | 'expired';
    createdByType: string;
    createdById: string;
    createdAt: string;
    rowVersion: number;
  },
): void {
  requireAdminScope(scope);
  database
    .prepare(
      `INSERT INTO case_tasks (
        id, case_id, alert_id, task_type, title, instructions_enc, accepted_document_types_json,
        due_at, status, created_by_type, created_by_id, completed_at, created_at, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.caseId,
      input.alertId,
      input.taskType,
      input.title,
      encryptDatabaseText(crypto, 'case_tasks', 'instructions_enc', input.id, input.instructions),
      input.acceptedDocumentTypesJson,
      input.dueAt,
      input.status,
      input.createdByType,
      input.createdById,
      input.createdAt,
      input.rowVersion,
    );
}
