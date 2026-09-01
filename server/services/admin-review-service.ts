import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { appendEncryptedAuditLog } from '../db/repositories/audit';
import {
  encryptCaseSensitiveFields,
  getCaseForAdmin,
  insertEncryptedCaseStateTransitionForAdmin,
  type AdminCaseRecord,
} from '../db/repositories/cases';
import { insertPublicNotificationJobForSystem } from '../db/repositories/notifications';
import { insertEncryptedCaseTaskForAdmin } from '../db/repositories/tasks';
import { parseUtcRfc3339Timestamp } from '../db/timestamps';
import type { AdminScope, SystemScope } from '../db/repositories/scopes';
import {
  assertCaseTransition,
  CaseStateMachineError,
  type CaseState,
  type CaseTransitionAction,
} from '../domain/case-state-machine';
import { parseQuotedEtag } from '../../shared/api-contract';
import {
  deleteExpiredIdempotencyResponses,
  readEncryptedIdempotencyResponse,
  storeEncryptedIdempotencyResponse,
  updateEncryptedIdempotencyResponse,
} from '../db/repositories/idempotency';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SYSTEM_SCOPE: SystemScope = { systemId: 'admin-review' };
type NotificationInput = Parameters<typeof insertPublicNotificationJobForSystem>[2];

export type AdminReviewErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'ETAG_MISMATCH'
  | 'INVALID_STATE'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'FORBIDDEN_TRANSITION'
  | 'REASON_REQUIRED'
  | 'INVALID_APPROVED_AMOUNT'
  | 'APPROVED_AMOUNT_EXCEEDS_CAP'
  | 'INVALID_DISBURSED_AMOUNT';

export class AdminReviewError extends Error {
  constructor(readonly code: AdminReviewErrorCode, message: string = code) {
    super(message);
    this.name = 'AdminReviewError';
  }
}

export interface SupplementRequest {
  title: string;
  instructions: string;
  acceptedDocumentTypes?: readonly string[];
  dueAt?: string | null;
  passportReconfirmationRequired?: boolean;
}

export interface AdminReviewDecision {
  adminId: string;
  caseId: string;
  ifMatch: string;
  idempotencyKey: string;
  action: CaseTransitionAction;
  toState: CaseState;
  reason?: string;
  approvedAmountTwd?: number;
  disbursedAmountTwd?: number;
  overrideReason?: string;
  passportVersionId?: string | null;
  supplement?: SupplementRequest;
  requestId?: string;
}

export interface AdminReviewResult {
  case: AdminCaseRecord;
  transition: {
    id: string;
    fromState: CaseState;
    toState: CaseState;
    sequenceNo: number;
    reasonCode: string;
  };
  taskIds: string[];
  notificationJobId: string;
}

export interface AdminReviewServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  clock?: () => Date;
  idGenerator?: () => string;
  requestIdGenerator?: () => string;
  notificationWriter?: (input: NotificationInput) => void;
}

type ReservedMutation = {
  kind: 'reserved';
  scope: string;
  requestHash: string;
  expiresAt: string;
};

function idempotencyScope(crypto: FieldCrypto, adminId: string, caseId: string): string {
  return crypto.hmacLookup(
    `${adminId}\nPOST\n/admin/v1/cases/${caseId}/review`,
    'api-idempotency-scope',
  );
}

function idempotencyRequestHash(crypto: FieldCrypto, projection: unknown): string {
  return crypto.hmacLookup(JSON.stringify(projection), 'admin-review-request');
}

function reserveMutation(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: AdminReviewDecision,
  projection: unknown,
  now: Date,
): ReservedMutation | { kind: 'replay'; body: string } {
  const scope = idempotencyScope(crypto, input.adminId, input.caseId);
  const requestHash = idempotencyRequestHash(crypto, projection);
  const nowIso = now.toISOString();
  deleteExpiredIdempotencyResponses(database, nowIso);
  const existing = readEncryptedIdempotencyResponse(database, crypto, scope, input.idempotencyKey, nowIso);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.responseStatus === 503) {
      throw new AdminReviewError('IDEMPOTENCY_KEY_REUSED');
    }
    return { kind: 'replay', body: existing.response };
  }
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  try {
    storeEncryptedIdempotencyResponse(database, crypto, {
      scope,
      key: input.idempotencyKey,
      requestHash,
      responseStatus: 503,
      response: JSON.stringify({ pending: true }),
      expiresAt,
      createdAt: nowIso,
    });
  } catch {
    const raced = readEncryptedIdempotencyResponse(database, crypto, scope, input.idempotencyKey, nowIso);
    if (raced && raced.requestHash === requestHash && raced.responseStatus !== 503) {
      return { kind: 'replay', body: raced.response };
    }
    throw new AdminReviewError('IDEMPOTENCY_KEY_REUSED');
  }
  return { kind: 'reserved', scope, requestHash, expiresAt };
}

function discardMutation(database: FlowPassDatabase, reservation: ReservedMutation, key: string): void {
  database
    .prepare('DELETE FROM api_idempotency_keys WHERE scope = ? AND key = ? AND request_hash = ?')
    .run(reservation.scope, key, reservation.requestHash);
}

function finalizeMutation(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  reservation: ReservedMutation,
  input: AdminReviewDecision,
  body: string,
  now: Date,
): void {
  if (!updateEncryptedIdempotencyResponse(database, crypto, {
    scope: reservation.scope,
    key: input.idempotencyKey,
    requestHash: reservation.requestHash,
    responseStatus: 201,
    response: body,
    expiresAt: reservation.expiresAt,
    now: now.toISOString(),
  })) {
    throw new Error('Idempotency response finalization failed');
  }
}

function replayResult(body: string): AdminReviewResult {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('case' in parsed)) {
      throw new Error('invalid');
    }
    return parsed as AdminReviewResult;
  } catch {
    throw new AdminReviewError('IDEMPOTENCY_KEY_REUSED', 'Stored idempotency response is invalid');
  }
}

function mapMachineError(error: CaseStateMachineError): AdminReviewError {
  const code: Record<CaseStateMachineError['code'], AdminReviewErrorCode> = {
    INVALID_STATE: 'INVALID_STATE',
    FORBIDDEN_TRANSITION: 'FORBIDDEN_TRANSITION',
    REASON_REQUIRED: 'REASON_REQUIRED',
    INVALID_APPROVED_AMOUNT: 'INVALID_APPROVED_AMOUNT',
    APPROVED_AMOUNT_EXCEEDS_CAP: 'APPROVED_AMOUNT_EXCEEDS_CAP',
    INVALID_DISBURSED_AMOUNT: 'INVALID_DISBURSED_AMOUNT',
    INVALID_ACTION: 'INVALID_REQUEST',
  };
  return new AdminReviewError(code[error.code], error.message);
}

function validateSupplement(input: SupplementRequest): { dueAt: string | null; accepted: string } {
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 200) {
    throw new AdminReviewError('INVALID_REQUEST', 'Supplement title is invalid');
  }
  if (typeof input.instructions !== 'string' || input.instructions.trim().length === 0 || input.instructions.length > 10_000) {
    throw new AdminReviewError('INVALID_REQUEST', 'Supplement instructions are invalid');
  }
  const accepted = input.acceptedDocumentTypes ?? [];
  if (!Array.isArray(accepted) || accepted.length > 20 || accepted.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 64)) {
    throw new AdminReviewError('INVALID_REQUEST', 'Accepted document types are invalid');
  }
  let dueAt: string | null = null;
  if (input.dueAt != null) {
    try {
      dueAt = parseUtcRfc3339Timestamp(input.dueAt, 'dueAt');
    } catch {
      throw new AdminReviewError('INVALID_REQUEST', 'dueAt is invalid');
    }
  }
  return { dueAt, accepted: JSON.stringify(accepted) };
}

function reasonCode(action: CaseTransitionAction, toState: CaseState): string {
  if (action === 'manual_override') return 'manual_override';
  if (action === 'request_documents') return 'documents_requested';
  if (action === 'return_correction') return 'returned_for_correction';
  if (action === 'start_review') return 'under_review';
  if (action === 'submit') return 'submitted';
  return toState;
}

function timelineEventType(toState: CaseState): string {
  if (toState === 'awaiting_documents') return 'documents_requested';
  if (toState === 'returned_for_correction') return 'correction_requested';
  if (toState === 'resubmitted') return 'documents_resubmitted';
  if (toState === 'under_review') return 'review_started';
  return toState;
}

function timelineSummary(toState: CaseState): string {
  const values: Record<CaseState, string> = {
    draft: '申請草稿已建立',
    submitted: '申請已送出',
    under_review: '已開始審查',
    awaiting_documents: '需要補充文件',
    returned_for_correction: '需要修正資料',
    resubmitted: '補充文件已收到',
    approved: '案件已核准',
    rejected: '案件已結束審查',
    awaiting_disbursement: '等待撥款',
    disbursed: '已完成撥款',
    closed: '案件已結案',
  };
  return values[toState];
}

function hashCase(caseId: string, state: string, version: number): string {
  return createHash('sha256').update(`${caseId}\n${state}\n${version}`, 'utf8').digest('hex');
}

function defaultNotificationWriter(input: NotificationInput, database: FlowPassDatabase): void {
  insertPublicNotificationJobForSystem(database, SYSTEM_SCOPE, input);
}

export function createAdminReviewService(options: AdminReviewServiceOptions) {
  const clock = options.clock ?? (() => new Date());
  const id = options.idGenerator ?? uuidv7;
  const requestId = options.requestIdGenerator ?? uuidv7;
  const notify = options.notificationWriter ?? ((input: NotificationInput) => defaultNotificationWriter(input, options.database));

  return {
    decide(input: AdminReviewDecision): AdminReviewResult {
      if (typeof input.adminId !== 'string' || input.adminId.trim().length === 0) {
        throw new AdminReviewError('UNAUTHENTICATED');
      }
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 256) {
        throw new AdminReviewError('INVALID_REQUEST', 'Idempotency-Key is required');
      }
      const expectedVersion = parseQuotedEtag(input.ifMatch);
      if (expectedVersion === null) throw new AdminReviewError('ETAG_MISMATCH');
      const now = clock();
      const projection = {
        caseId: input.caseId,
        action: input.action,
        toState: input.toState,
        reason: input.reason,
        approvedAmountTwd: input.approvedAmountTwd,
        disbursedAmountTwd: input.disbursedAmountTwd,
        overrideReason: input.overrideReason,
        passportVersionId: input.passportVersionId ?? null,
        supplement: input.supplement ?? null,
        ifMatch: input.ifMatch,
      };
      const reservation = reserveMutation(options.database, options.crypto, input, projection, now);
      if (reservation.kind === 'replay') return replayResult(reservation.body);

      try {
        let output!: AdminReviewResult;
        options.database.transaction(() => {
          const row = options.database.prepare('SELECT id, state, row_version, program_rule_version_id, decision_reason_enc FROM cases WHERE id = ?').get(input.caseId) as {
            id: string;
            state: string;
            row_version: number;
            program_rule_version_id: string;
            decision_reason_enc: string | null;
          } | undefined;
          if (!row) throw new AdminReviewError('NOT_FOUND');
          if (row.row_version !== expectedVersion) throw new AdminReviewError('ETAG_MISMATCH');

          const cap = input.toState === 'approved'
            ? (options.database.prepare('SELECT per_case_cap_twd FROM program_rule_versions WHERE id = ?').get(row.program_rule_version_id) as { per_case_cap_twd: number } | undefined)?.per_case_cap_twd
            : undefined;
          let fromState: CaseState;
          try {
            assertCaseTransition({
              from: row.state,
              to: input.toState,
              action: input.action,
              reason: input.reason,
              approvedAmountTwd: input.approvedAmountTwd,
              disbursedAmountTwd: input.disbursedAmountTwd,
              capTwd: cap,
              overrideReason: input.overrideReason,
              manualOverride: input.action === 'manual_override',
            });
            fromState = row.state as CaseState;
          } catch (error) {
            if (error instanceof CaseStateMachineError) throw mapMachineError(error);
            throw error;
          }

          if ((input.toState === 'awaiting_documents' || input.toState === 'returned_for_correction') && !input.supplement) {
            throw new AdminReviewError('INVALID_REQUEST', 'A supplement request is required');
          }
          const supplementInput = input.supplement;
          const supplement = supplementInput ? validateSupplement(supplementInput) : null;
          if (input.passportVersionId) {
            const passport = options.database.prepare('SELECT passport_versions.id FROM passport_versions JOIN passports ON passports.id = passport_versions.passport_id WHERE passport_versions.id = ? AND passports.case_id = ?').get(input.passportVersionId, input.caseId);
            if (!passport) throw new AdminReviewError('INVALID_REQUEST', 'Passport version does not belong to case');
          }

          const createdAt = now.toISOString();
          const transitionId = id();
          const transitionSequence = (options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS sequence FROM case_state_transitions WHERE case_id = ?').get(input.caseId) as { sequence: number }).sequence + 1;
          const nextVersion = row.row_version + 1;
          const decisionReason = input.overrideReason ? `${input.reason ?? ''}\n${input.overrideReason}` : input.reason;
          const decisionReasonEnc = decisionReason === undefined
            ? null
            : encryptCaseSensitiveFields(options.crypto, input.caseId, { decisionReason }).decisionReasonEnc;
          const update = options.database.prepare('UPDATE cases SET state = ?, decision_reason_enc = COALESCE(?, decision_reason_enc), approved_amount_twd = CASE WHEN ? = \'approved\' THEN ? ELSE approved_amount_twd END, approved_passport_version_id = CASE WHEN ? = \'approved\' THEN ? ELSE approved_passport_version_id END, disbursed_amount_twd = CASE WHEN ? = \'disbursed\' THEN ? ELSE disbursed_amount_twd END, closed_at = CASE WHEN ? = \'closed\' THEN ? ELSE closed_at END, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?').run(input.toState, decisionReasonEnc, input.toState, input.approvedAmountTwd ?? null, input.toState, input.toState === 'approved' ? input.passportVersionId ?? null : null, input.toState, input.disbursedAmountTwd ?? null, input.toState, input.toState === 'closed' ? createdAt : null, createdAt, input.caseId, expectedVersion);
          if (update.changes !== 1) throw new AdminReviewError('ETAG_MISMATCH');

          insertEncryptedCaseStateTransitionForAdmin(options.database, { adminId: input.adminId } satisfies AdminScope, options.crypto, {
            id: transitionId,
            caseId: input.caseId,
            sequenceNo: transitionSequence,
            fromState,
            toState: input.toState,
            reasonCode: reasonCode(input.action, input.toState),
            reason: input.reason ?? null,
            actorType: 'admin',
            actorId: input.adminId,
            createdAt,
          });

          const timelineSequence = (options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS sequence FROM timeline_events WHERE case_id = ?').get(input.caseId) as { sequence: number }).sequence + 1;
          options.database.prepare('INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, \'admin\', ?)').run(id(), input.caseId, timelineSequence, timelineEventType(input.toState), timelineSummary(input.toState), JSON.stringify({ state: input.toState }), createdAt);
          appendEncryptedAuditLog(options.database, options.crypto, {
            id: id(),
            actorType: 'admin',
            actorId: input.adminId,
            action: 'update',
            entityType: 'case',
            entityId: input.caseId,
            beforeHash: hashCase(input.caseId, fromState, row.row_version),
            afterHash: hashCase(input.caseId, input.toState, nextVersion),
            detail: {
              kind: 'transition',
              previousState: fromState as never,
              nextState: input.toState as never,
              reasonCode: reasonCode(input.action, input.toState) as never,
            },
            requestId: input.requestId ?? requestId(),
            createdAt,
          });

          const taskIds: string[] = [];
          if (supplement && (input.toState === 'awaiting_documents' || input.toState === 'returned_for_correction')) {
            const taskId = id();
            taskIds.push(taskId);
            insertEncryptedCaseTaskForAdmin(options.database, { adminId: input.adminId }, options.crypto, {
              id: taskId,
              caseId: input.caseId,
              alertId: null,
              taskType: input.toState === 'awaiting_documents' ? 'provide_document' : 'revise_passport',
              title: supplementInput!.title,
              instructions: supplementInput!.instructions,
              acceptedDocumentTypesJson: supplement.accepted,
              dueAt: supplement.dueAt,
              status: 'open',
              createdByType: 'admin',
              createdById: input.adminId,
              createdAt,
              rowVersion: 1,
            });
            if (input.toState === 'returned_for_correction' && supplementInput?.passportReconfirmationRequired) {
              const reconfirmTaskId = id();
              taskIds.push(reconfirmTaskId);
              insertEncryptedCaseTaskForAdmin(options.database, { adminId: input.adminId }, options.crypto, {
                id: reconfirmTaskId,
                caseId: input.caseId,
                alertId: null,
                taskType: 'reconfirm_passport',
                title: '重新確認護照內容',
                instructions: '請確認修正後的護照內容。',
                acceptedDocumentTypesJson: '[]',
                dueAt: supplement.dueAt,
                status: 'open',
                createdByType: 'admin',
                createdById: input.adminId,
                createdAt,
                rowVersion: 1,
              });
            }
          } else {
            options.database.prepare("UPDATE case_tasks SET status = 'cancelled', row_version = row_version + 1 WHERE case_id = ? AND status IN ('open', 'opened')").run(input.caseId);
          }

          const notificationJobId = id();
          const notification: NotificationInput = {
            id: notificationJobId,
            caseId: input.caseId,
            taskId: taskIds[0] ?? null,
            alertId: null,
            businessKey: `case:${input.caseId}:transition:${transitionId}`,
            template: taskIds.length > 0 ? 'task_ready' : 'review_updated',
            payload: taskIds.length > 0
              ? { notificationType: 'task', messageCode: 'task_ready', locale: 'zh-TW', publicPath: '/app/tasks' }
              : { notificationType: 'review', messageCode: 'review_updated', locale: 'zh-TW', publicPath: '/app/tasks' },
            providerRetryKey: `case:${input.caseId}:transition:${transitionId}`,
            status: 'pending',
            attempts: 0,
            availableAt: createdAt,
            createdAt,
          };
          notify(notification);

          const record = getCaseForAdmin(options.database, { adminId: input.adminId }, input.caseId);
          if (!record) throw new AdminReviewError('NOT_FOUND');
          output = {
            case: record,
            transition: {
              id: transitionId,
              fromState,
              toState: input.toState,
              sequenceNo: transitionSequence,
              reasonCode: reasonCode(input.action, input.toState),
            },
            taskIds,
            notificationJobId,
          };
          finalizeMutation(options.database, options.crypto, reservation, input, JSON.stringify(output), now);
        })();
        return output;
      } catch (error) {
        discardMutation(options.database, reservation, input.idempotencyKey);
        throw error;
      }
    },
  };
}
