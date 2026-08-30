import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { encryptDatabaseText } from './encrypted-fields';
import { requireAdminScope, type AdminScope } from './scopes';

interface AuditLogRow {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_hash: string | null;
  after_hash: string | null;
  request_id: string;
  created_at: string;
}

/** Internal audit projection; available only from admin-scoped functions. */
export interface AdminAuditLogRecord {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeHash: string | null;
  afterHash: string | null;
  requestId: string;
  createdAt: string;
}

function mapAuditLog(row: AuditLogRow): AdminAuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export function listAuditLogsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  entityType: string,
  entityId: string,
): AdminAuditLogRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id, before_hash, after_hash,
              request_id, created_at
       FROM audit_logs
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(entityType, entityId) as AuditLogRow[];

  return rows.map(mapAuditLog);
}

const AUDIT_OPERATIONS = ['create', 'update', 'delete', 'link', 'unlink', 'issue', 'revoke'] as const;
const AUDIT_OUTCOMES = ['ok', 'denied', 'failed', 'rejected', 'noop'] as const;
const AUDIT_REASON_CODES = [
  'created',
  'updated',
  'submitted',
  'under_review',
  'documents_requested',
  'returned_for_correction',
  'approved',
  'rejected',
  'awaiting_disbursement',
  'disbursed',
  'closed',
  'manual_override',
  'withdrawn',
  'invalid',
  'expired',
  'duplicate',
  'missing',
] as const;
const AUDIT_STATES = [
  'draft',
  'submitted',
  'under_review',
  'awaiting_documents',
  'returned_for_correction',
  'resubmitted',
  'approved',
  'rejected',
  'awaiting_disbursement',
  'disbursed',
  'closed',
  'needs_info',
  'withdrawn',
  'archived',
] as const;
const AUDIT_FIELDS = [
  'status',
  'answer',
  'passport',
  'document',
  'task',
  'notification',
] as const;

type AuditOperation = (typeof AUDIT_OPERATIONS)[number];
type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];
type AuditState = (typeof AUDIT_STATES)[number];
type AuditField = (typeof AUDIT_FIELDS)[number];

/**
 * Audit detail deliberately uses fixed metadata codes rather than free-form text.
 * Human explanations, prompts, source excerpts, document data, identifiers, and
 * tokens are not audit-detail values and must use their dedicated encrypted owners.
 */
export type PublicSafeAuditDetail =
  | { kind: 'operation'; operation: AuditOperation; outcome: AuditOutcome }
  | {
      kind: 'transition';
      previousState: AuditState;
      nextState: AuditState;
      reasonCode?: AuditReasonCode;
    }
  | { kind: 'field-change'; field: AuditField; fieldCount: number; outcome: AuditOutcome };

function auditDetailFailure(): never {
  throw new Error('Audit detail is not public-safe');
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAllowedCode(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function serializePublicSafeAuditDetail(detail: PublicSafeAuditDetail): string {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return auditDetailFailure();
  }

  const value = detail as Record<string, unknown>;
  if (value.kind === 'operation') {
    if (
      !hasExactKeys(value, ['kind', 'operation', 'outcome']) ||
      !isAllowedCode(value.operation, AUDIT_OPERATIONS) ||
      !isAllowedCode(value.outcome, AUDIT_OUTCOMES)
    ) {
      return auditDetailFailure();
    }
    return JSON.stringify({ kind: 'operation', operation: value.operation, outcome: value.outcome });
  }

  if (value.kind === 'transition') {
    if (
      !hasExactKeys(value, ['kind', 'previousState', 'nextState']) &&
      !hasExactKeys(value, ['kind', 'previousState', 'nextState', 'reasonCode'])
    ) {
      return auditDetailFailure();
    }
    if (
      !isAllowedCode(value.previousState, AUDIT_STATES) ||
      !isAllowedCode(value.nextState, AUDIT_STATES) ||
      ('reasonCode' in value && !isAllowedCode(value.reasonCode, AUDIT_REASON_CODES))
    ) {
      return auditDetailFailure();
    }
    return JSON.stringify({
      kind: 'transition',
      previousState: value.previousState,
      nextState: value.nextState,
      ...('reasonCode' in value ? { reasonCode: value.reasonCode } : {}),
    });
  }

  if (value.kind === 'field-change') {
    if (
      !hasExactKeys(value, ['kind', 'field', 'fieldCount', 'outcome']) ||
      !isAllowedCode(value.field, AUDIT_FIELDS) ||
      typeof value.fieldCount !== 'number' ||
      !Number.isSafeInteger(value.fieldCount) ||
      value.fieldCount < 1 ||
      value.fieldCount > 100 ||
      !isAllowedCode(value.outcome, AUDIT_OUTCOMES)
    ) {
      return auditDetailFailure();
    }
    return JSON.stringify({
      kind: 'field-change',
      field: value.field,
      fieldCount: value.fieldCount,
      outcome: value.outcome,
    });
  }

  return auditDetailFailure();
}

/**
 * The only audit-detail write path stores a constrained, public-safe detail object
 * inside an envelope. Immutable triggers continue to prohibit later edits.
 */
export function appendEncryptedAuditLog(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: {
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeHash: string | null;
    afterHash: string | null;
    detail: PublicSafeAuditDetail;
    requestId: string;
    createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO audit_logs (
        id, actor_type, actor_id, action, entity_type, entity_id, before_hash, after_hash,
        detail_enc, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.actorType,
      input.actorId,
      input.action,
      input.entityType,
      input.entityId,
      input.beforeHash,
      input.afterHash,
      encryptDatabaseText(
        crypto,
        'audit_logs',
        'detail_enc',
        input.id,
        serializePublicSafeAuditDetail(input.detail),
      ),
      input.requestId,
      input.createdAt,
    );
}
