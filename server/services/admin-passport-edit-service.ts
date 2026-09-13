import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { decryptDatabaseText, encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { calculateSubsidy } from '../domain/subsidy-calculator';
import { subsidyDerivationSteps } from '../domain/submission-checks';
import { inspectPassportDocument } from '../domain/passport-validation';
import { rebuildPassportIndexes } from '../domain/passport-indexes';
import { persistRuleEvaluation, persistSubsidyCalculation } from './rule-evaluation-service';
import { PurchaseDetailsSchema, type PurchaseDetails } from '../../shared/purchase-details-contract';
import { validateCoreAnswers, type CoreAnswers } from '../../shared/case-contract';
import type { AdminDataFieldType, AdminFieldPatch, AdminFieldPatchResult } from '../../shared/admin-data-management-contract';

export type AdminPassportEditErrorCode = 'NOT_FOUND' | 'LOCKED_FIELD' | 'INVALID_VALUE' | 'ROW_CONFLICT';

export class AdminPassportEditError extends Error {
  constructor(readonly code: AdminPassportEditErrorCode) {
    super(code);
    this.name = 'AdminPassportEditError';
  }
}

export interface AdminPassportEditInput extends AdminFieldPatch {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  caseId: string;
  adminId: string;
  requestId: string;
  now?: Date;
  idGenerator?: () => string;
}

const CASE_STATES = new Set(['draft', 'submitted', 'under_review', 'awaiting_documents', 'returned_for_correction', 'resubmitted', 'approved', 'rejected', 'awaiting_disbursement', 'disbursed', 'closed']);
const ANSWER_FIELDS = new Set<keyof CoreAnswers>(['material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience']);
const PURCHASE_FIELDS = new Set<keyof PurchaseDetails>(['billingCycle', 'billingPeriods', 'softwareFunction', 'otherFunction', 'softwareName', 'companyName', 'purchaseDate', 'payerType', 'originalCurrency', 'otherCurrency', 'originalExpense', 'convertedTwd', 'specialStatus', 'invoiceNumber', 'paymentSourceFingerprint']);
const TASK_STATUSES = new Set(['open', 'opened', 'completed', 'cancelled', 'expired']);
const ALERT_STATUSES = new Set(['open', 'acknowledged', 'resolved', 'dismissed']);

function asText(value: unknown, max = 4_096, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new AdminPassportEditError('INVALID_VALUE');
  const text = value.trim();
  if (!text || Array.from(text).length > max) throw new AdminPassportEditError('INVALID_VALUE');
  return text;
}

function asMoney(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000_000) throw new AdminPassportEditError('INVALID_VALUE');
  return value;
}

function asDateTime(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new AdminPassportEditError('INVALID_VALUE');
  return value;
}

function parseEncryptedJson<T>(crypto: FieldCrypto, table: string, column: string, id: string, envelope: string): T {
  try { return JSON.parse(decryptDatabaseText(crypto, table, column, id, envelope)) as T; }
  catch { throw new AdminPassportEditError('INVALID_VALUE'); }
}

function updateCaseField(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, field: string, value: unknown): AdminDataFieldType {
  switch (field) {
    case 'state': {
      if (typeof value !== 'string' || !CASE_STATES.has(value)) throw new AdminPassportEditError('INVALID_VALUE');
      database.prepare('UPDATE cases SET state = ? WHERE id = ?').run(value, caseId);
      return 'status';
    }
    case 'requested_amount_twd':
      database.prepare('UPDATE cases SET requested_amount_twd = ? WHERE id = ?').run(asMoney(value, true), caseId);
      return 'money';
    case 'approved_amount_twd':
      database.prepare('UPDATE cases SET approved_amount_twd = ? WHERE id = ?').run(asMoney(value, true), caseId);
      return 'money';
    case 'title_enc': {
      const text = value === null ? null : asText(value, 200);
      database.prepare('UPDATE cases SET title_enc = ? WHERE id = ?').run(text === null ? null : encryptDatabaseText(crypto, 'cases', 'title_enc', caseId, text), caseId);
      return 'text';
    }
    case 'decision_reason_enc': {
      const text = value === null ? null : asText(value, 2_000);
      database.prepare('UPDATE cases SET decision_reason_enc = ? WHERE id = ?').run(text === null ? null : encryptDatabaseText(crypto, 'cases', 'decision_reason_enc', caseId, text), caseId);
      return 'text';
    }
    case 'closed_at':
      database.prepare('UPDATE cases SET closed_at = ? WHERE id = ?').run(asDateTime(value), caseId);
      return 'datetime';
    default:
      throw new AdminPassportEditError('LOCKED_FIELD');
  }
}

function grantCorrection(database: FlowPassDatabase, operationId: string, table: string, recordId: string): void {
  database.prepare(`INSERT INTO admin_data_mutation_guards (id, operation_id, table_name, record_id, action, expires_at) VALUES (?, ?, ?, ?, 'update', ?)`).run(
    uuidv7(), operationId, table, recordId, new Date(Date.now() + 60_000).toISOString(),
  );
}

function revokeCorrection(database: FlowPassDatabase, operationId: string): void {
  database.prepare('DELETE FROM admin_data_mutation_guards WHERE operation_id = ?').run(operationId);
}

function updateAnswer(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, recordId: string, field: string, value: unknown, operationId: string): void {
  if (!ANSWER_FIELDS.has(field as keyof CoreAnswers)) throw new AdminPassportEditError('LOCKED_FIELD');
  const row = database.prepare(`
    SELECT answer_versions.answers_enc
    FROM cases JOIN answer_versions ON answer_versions.id = cases.current_answer_version_id
    WHERE cases.id = ? AND answer_versions.id = ?
  `).get(caseId, recordId) as { answers_enc: string } | undefined;
  if (!row) throw new AdminPassportEditError('NOT_FOUND');
  const answers = parseEncryptedJson<CoreAnswers>(crypto, 'answer_versions', 'answers_enc', recordId, row.answers_enc);
  const next = validateCoreAnswers({ ...answers, [field]: asText(value, 600) });
  const serialized = JSON.stringify(next);
  grantCorrection(database, operationId, 'answer_versions', recordId);
  database.prepare('UPDATE answer_versions SET answers_enc = ?, content_sha256 = ? WHERE id = ?').run(
    encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', recordId, serialized),
    createHash('sha256').update(serialized).digest('hex'),
    recordId,
  );
  revokeCorrection(database, operationId);
}

function updatePurchase(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, recordId: string, field: string, value: unknown): void {
  if (recordId !== caseId || !PURCHASE_FIELDS.has(field as keyof PurchaseDetails)) throw new AdminPassportEditError('LOCKED_FIELD');
  const row = database.prepare('SELECT details_enc FROM case_purchase_details WHERE case_id = ?').get(caseId) as { details_enc: string } | undefined;
  if (!row) throw new AdminPassportEditError('NOT_FOUND');
  const details = parseEncryptedJson<PurchaseDetails>(crypto, 'case_purchase_details', 'details_enc', caseId, row.details_enc);
  const next = PurchaseDetailsSchema.safeParse({ ...details, [field]: value });
  if (!next.success) throw new AdminPassportEditError('INVALID_VALUE');
  const serialized = JSON.stringify(next.data);
  database.prepare(`
    UPDATE case_purchase_details
    SET details_enc = ?, content_sha256 = ?, updated_at = ?, row_version = row_version + 1
    WHERE case_id = ?
  `).run(
    encryptDatabaseText(crypto, 'case_purchase_details', 'details_enc', caseId, serialized),
    createHash('sha256').update(serialized).digest('hex'),
    new Date().toISOString(),
    caseId,
  );
}

function pathSegments(path: string): Array<string | number> {
  if (!/^[A-Za-z0-9_.]+$/.test(path) || path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')) throw new AdminPassportEditError('LOCKED_FIELD');
  return path.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function editablePassportPath(path: string): boolean {
  if (/^use_case\.(title|purpose|intended_outcome)$/.test(path)) return true;
  if (/^nodes\.\d+\.(label|data_category|sensitivity|confidence|needs_confirmation)$/.test(path)) return true;
  if (/^edges\.\d+\.(purpose|confidence|needs_confirmation)$/.test(path)) return true;
  if (/^sharing_scope\.(audience|needs_confirmation)$/.test(path)) return true;
  if (/^retention\.(storage_location|duration|deletion_plan|needs_confirmation)$/.test(path)) return true;
  if (/^safety_actions\.\d+\.(action|reason)$/.test(path)) return true;
  return path === 'administrative_hints.requested_tool';
}

function setPath(root: unknown, path: string, value: unknown): void {
  const segments = pathSegments(path);
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current || typeof current !== 'object' || !(segment in current)) throw new AdminPassportEditError('INVALID_VALUE');
    current = (current as Record<string | number, unknown>)[segment];
  }
  const last = segments.at(-1);
  if (last === undefined || !current || typeof current !== 'object' || !(last in current)) throw new AdminPassportEditError('INVALID_VALUE');
  (current as Record<string | number, unknown>)[last] = value;
}

function updatePassport(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, recordId: string, field: string, value: unknown, idGenerator: () => string, operationId: string): void {
  if (!editablePassportPath(field)) throw new AdminPassportEditError('LOCKED_FIELD');
  const row = database.prepare(`
    SELECT passport_versions.payload_enc, passport_versions.workflow_state, passport_versions.version_no
    FROM cases JOIN passport_versions ON passport_versions.id = cases.current_passport_version_id
    WHERE cases.id = ? AND passport_versions.id = ?
  `).get(caseId, recordId) as { payload_enc: string; workflow_state: string; version_no: number } | undefined;
  if (!row) throw new AdminPassportEditError('NOT_FOUND');
  const payload = parseEncryptedJson<unknown>(crypto, 'passport_versions', 'payload_enc', recordId, row.payload_enc);
  setPath(payload, field, value);
  const inspection = inspectPassportDocument({ passport_draft: payload });
  if (!inspection.canonical || !inspection.validation.ok) throw new AdminPassportEditError('INVALID_VALUE');
  const serialized = JSON.stringify(inspection.canonical);
  const hash = createHash('sha256').update(serialized).update(`\n${row.workflow_state}\n${row.version_no}`).digest('hex');
  grantCorrection(database, operationId, 'passport_versions', recordId);
  database.prepare('UPDATE passport_versions SET payload_enc = ?, content_sha256 = ? WHERE id = ?').run(
    encryptDatabaseText(crypto, 'passport_versions', 'payload_enc', recordId, serialized), hash, recordId,
  );
  revokeCorrection(database, operationId);
  rebuildPassportIndexes(database, recordId, inspection.canonical, idGenerator);
}

function updateOwnedSimpleRecord(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, resource: string, recordId: string, field: string, value: unknown): AdminDataFieldType {
  if (resource === 'case_tasks') {
    const owned = database.prepare('SELECT id FROM case_tasks WHERE id = ? AND case_id = ?').get(recordId, caseId);
    if (!owned) throw new AdminPassportEditError('NOT_FOUND');
    if (field === 'title') { database.prepare('UPDATE case_tasks SET title = ? WHERE id = ?').run(asText(value, 200), recordId); return 'text'; }
    if (field === 'instructions_enc') { const text = asText(value, 4_000); database.prepare('UPDATE case_tasks SET instructions_enc = ? WHERE id = ?').run(encryptDatabaseText(crypto, 'case_tasks', 'instructions_enc', recordId, text!), recordId); return 'text'; }
    if (field === 'due_at') { database.prepare('UPDATE case_tasks SET due_at = ? WHERE id = ?').run(asDateTime(value), recordId); return 'datetime'; }
    if (field === 'status') { if (typeof value !== 'string' || !TASK_STATUSES.has(value)) throw new AdminPassportEditError('INVALID_VALUE'); database.prepare('UPDATE case_tasks SET status = ? WHERE id = ?').run(value, recordId); return 'status'; }
  }
  if (resource === 'alerts') {
    const owned = database.prepare('SELECT id FROM alerts WHERE id = ? AND case_id = ?').get(recordId, caseId);
    if (!owned) throw new AdminPassportEditError('NOT_FOUND');
    if (field === 'public_summary' || field === 'public_guidance') { database.prepare(`UPDATE alerts SET ${field === 'public_summary' ? 'public_summary' : 'public_guidance'} = ? WHERE id = ?`).run(asText(value, 1_000), recordId); return 'text'; }
    if (field === 'status') { if (typeof value !== 'string' || !ALERT_STATUSES.has(value)) throw new AdminPassportEditError('INVALID_VALUE'); database.prepare('UPDATE alerts SET status = ? WHERE id = ?').run(value, recordId); return 'status'; }
    if (field === 'resolved_at') { database.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?').run(asDateTime(value), recordId); return 'datetime'; }
  }
  if (resource === 'documents') {
    const owned = database.prepare('SELECT id FROM documents WHERE id = ? AND case_id = ?').get(recordId, caseId);
    if (!owned) throw new AdminPassportEditError('NOT_FOUND');
    if (field === 'original_name_enc') { const text = asText(value, 255); database.prepare('UPDATE documents SET original_name_enc = ? WHERE id = ?').run(encryptDatabaseText(crypto, 'documents', 'original_name_enc', recordId, text!), recordId); return 'text'; }
  }
  throw new AdminPassportEditError('LOCKED_FIELD');
}

function recalculateSubsidy(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, now: string, idGenerator: () => string): boolean {
  const source = database.prepare(`
    SELECT cases.current_passport_version_id, cases.program_rule_version_id,
           program_rule_versions.subsidy_rate_bps, program_rule_versions.per_case_cap_twd,
           program_rule_versions.rounding_mode, case_purchase_details.details_enc
    FROM cases
    JOIN program_rule_versions ON program_rule_versions.id = cases.program_rule_version_id
    LEFT JOIN case_purchase_details ON case_purchase_details.case_id = cases.id
    WHERE cases.id = ?
  `).get(caseId) as { current_passport_version_id: string | null; program_rule_version_id: string; subsidy_rate_bps: number; per_case_cap_twd: number; rounding_mode: 'floor' | 'half_up'; details_enc: string | null } | undefined;
  if (!source?.details_enc) return false;
  const details = PurchaseDetailsSchema.parse(parseEncryptedJson<PurchaseDetails>(crypto, 'case_purchase_details', 'details_enc', caseId, source.details_enc));
  const calculation = calculateSubsidy({ eligiblePurchaseTwd: details.convertedTwd, rateBps: source.subsidy_rate_bps, capTwd: source.per_case_cap_twd, roundingMode: source.rounding_mode });
  const inputSnapshotHash = createHash('sha256').update(JSON.stringify({ caseId, details, ruleVersionId: source.program_rule_version_id })).digest('hex');
  const evaluation = persistRuleEvaluation(database, {
    caseId, passportVersionId: source.current_passport_version_id, ruleVersionId: source.program_rule_version_id, evaluationKind: 'subsidy',
    evaluation: {
      ruleCode: 'admin_data_recalculation',
      outcome: 'pass',
      reasonCode: calculation.reasonCode,
      explanation: '依校正後資料重新試算。',
      ruleVersionId: source.program_rule_version_id,
      inputSnapshotHash,
      evaluatedAt: now,
      steps: subsidyDerivationSteps(calculation),
    },
    actorType: 'admin', actorId: 'admin-data-management', createdAt: now, idGenerator,
  });
  persistSubsidyCalculation(database, { caseId, ruleEvaluationId: evaluation.id, calculation, createdAt: now, idGenerator });
  database.prepare('UPDATE cases SET requested_amount_twd = ?, calculated_amount_twd = ? WHERE id = ?').run(details.convertedTwd, calculation.calculatedAmountTwd, caseId);
  return true;
}

export function editAdminPassportField(input: AdminPassportEditInput): AdminFieldPatchResult {
  const now = (input.now ?? new Date()).toISOString();
  const idGenerator = input.idGenerator ?? uuidv7;
  const result = input.database.transaction(() => {
    const caseRow = input.database.prepare('SELECT id, row_version FROM cases WHERE id = ? AND deleted_at IS NULL').get(input.caseId) as { id: string; row_version: number } | undefined;
    if (!caseRow) throw new AdminPassportEditError('NOT_FOUND');
    if (caseRow.row_version !== input.expectedRowVersion) throw new AdminPassportEditError('ROW_CONFLICT');
    let fieldType: AdminDataFieldType = 'text';
    let requiresAiRefresh = false;
    const recalculated: string[] = [];

    if (input.resource === 'cases') {
      if (input.recordId !== input.caseId) throw new AdminPassportEditError('NOT_FOUND');
      fieldType = updateCaseField(input.database, input.crypto, input.caseId, input.field, input.value);
    } else if (input.resource === 'answer_versions') {
      updateAnswer(input.database, input.crypto, input.caseId, input.recordId, input.field, input.value, input.requestId);
      requiresAiRefresh = true;
    } else if (input.resource === 'case_purchase_details') {
      updatePurchase(input.database, input.crypto, input.caseId, input.recordId, input.field, input.value);
      requiresAiRefresh = true;
      fieldType = input.field === 'convertedTwd' ? 'money' : typeof input.value === 'boolean' ? 'boolean' : typeof input.value === 'number' ? 'integer' : 'text';
    } else if (input.resource === 'passport_versions') {
      updatePassport(input.database, input.crypto, input.caseId, input.recordId, input.field, input.value, idGenerator, input.requestId);
      requiresAiRefresh = true;
    } else {
      fieldType = updateOwnedSimpleRecord(input.database, input.crypto, input.caseId, input.resource, input.recordId, input.field, input.value);
    }

    if (requiresAiRefresh && recalculateSubsidy(input.database, input.crypto, input.caseId, now, idGenerator)) recalculated.push('補助金額');
    if (input.resource === 'passport_versions') recalculated.push('護照索引');
    const changed = input.database.prepare('UPDATE cases SET updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?').run(now, input.caseId, input.expectedRowVersion);
    if (changed.changes !== 1) throw new AdminPassportEditError('ROW_CONFLICT');
    input.database.prepare(`
      INSERT INTO admin_data_edit_audits (
        id, admin_user_id, case_id, resource, record_id, field_name, field_type,
        outcome, requires_ai_refresh, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)
    `).run(idGenerator(), input.adminId, input.caseId, input.resource, input.recordId, input.field, fieldType, requiresAiRefresh ? 1 : 0, input.requestId, now);
    return { rowVersion: input.expectedRowVersion + 1, requiresAiRefresh, recalculated };
  })();
  return result;
}
