import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { AdminReviewError, createAdminReviewService } from './admin-review-service';

const NOW = '2026-08-30T00:00:00.000Z';
const ADMIN_ID = '0198f050-0000-7000-8000-000000000001';
const APPLICANT_ID = '0198f050-0000-7000-8000-000000000002';
const CYCLE_ID = '0198f050-0000-7000-8000-000000000003';
const RULE_ID = '0198f050-0000-7000-8000-000000000004';
const CASE_ID = '0198f050-0000-7000-8000-000000000005';

function cryptoForTests(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey: (id) => (id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined),
  };
  return new FieldCrypto(keyring);
}

describe('admin review service', () => {
  let dir: string;
  let database: ReturnType<typeof openDatabase>;
  let crypto: FieldCrypto;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task14-'));
    database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    crypto = cryptoForTests();
    database.prepare('INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(ADMIN_ID, 'reviewer', 'hash', 'active', NOW, 1);
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(APPLICANT_ID, 'enc', 'active', NOW, NOW, 1);
    database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(CYCLE_ID, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, published_by_admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(RULE_ID, CYCLE_ID, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, ADMIN_ID, NOW);
    database.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, submitted_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(CASE_ID, 'FP-20260830-00000005', APPLICANT_ID, CYCLE_ID, RULE_ID, 'submitted', NOW, NOW, NOW, 3);
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function service(extra: Partial<Parameters<typeof createAdminReviewService>[0]> = {}) {
    return createAdminReviewService({
      database,
      crypto,
      clock: () => new Date(NOW),
      idGenerator: uuidv7,
      requestIdGenerator: () => 'request-14',
      ...extra,
    });
  }

  it('executes a supplement decision atomically and records task, timeline, audit, and notification', () => {
    service().decide({
      adminId: ADMIN_ID,
      caseId: CASE_ID,
      ifMatch: '"3"',
      idempotencyKey: 'start-before-supplement',
      action: 'start_review',
      toState: 'under_review',
      reason: '開始審查',
    });
    const result = service().decide({
      adminId: ADMIN_ID,
      caseId: CASE_ID,
      ifMatch: '"4"',
      idempotencyKey: 'request-docs-1',
      action: 'request_documents',
      toState: 'awaiting_documents',
      reason: '發票影像不足，請補件',
      supplement: {
        title: '補上發票',
        instructions: '請上傳完整發票影像',
        acceptedDocumentTypes: ['invoice'],
        dueAt: '2026-09-05T00:00:00.000Z',
        passportReconfirmationRequired: false,
      },
    });

    expect(result.case).toMatchObject({ id: CASE_ID, state: 'awaiting_documents', rowVersion: 5 });
    expect(result.taskIds).toHaveLength(1);
    expect((database.prepare('SELECT task_type, title, accepted_document_types_json, due_at, status FROM case_tasks WHERE id = ?').get(result.taskIds[0]) as Record<string, unknown>)).toMatchObject({ task_type: 'provide_document', title: '補上發票', accepted_document_types_json: '["invoice"]', due_at: '2026-09-05T00:00:00.000Z', status: 'open' });
    expect((database.prepare('SELECT from_state, to_state, reason_enc, actor_type, actor_id FROM case_state_transitions WHERE case_id = ? AND sequence_no = 2').get(CASE_ID) as Record<string, unknown>)).toMatchObject({ from_state: 'under_review', to_state: 'awaiting_documents', actor_type: 'admin', actor_id: ADMIN_ID });
    expect((database.prepare('SELECT event_type, public_data_json FROM timeline_events WHERE case_id = ? ORDER BY sequence_no DESC LIMIT 1').get(CASE_ID) as Record<string, unknown>)).toMatchObject({ event_type: 'documents_requested', public_data_json: '{"state":"awaiting_documents"}' });
    expect((database.prepare('SELECT template, task_id, payload_json FROM notification_jobs WHERE case_id = ? AND task_id = ?').get(CASE_ID, result.taskIds[0]) as Record<string, unknown>)).toMatchObject({ template: 'task_ready', task_id: result.taskIds[0], payload_json: expect.stringContaining('"publicPath":"/app/tasks"') });
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = \'case\' AND entity_id = ?').get(CASE_ID)).toMatchObject({ count: 2 });
  });

  it('replays the same admin command on double click without a second transition', () => {
    const input = {
      adminId: ADMIN_ID,
      caseId: CASE_ID,
      ifMatch: '"3"',
      idempotencyKey: 'double-click',
      action: 'start_review' as const,
      toState: 'under_review' as const,
      reason: '開始審查',
    };
    const first = service().decide(input);
    const replay = service().decide(input);
    expect(replay).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) AS count FROM case_state_transitions WHERE case_id = ?').get(CASE_ID)).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM notification_jobs WHERE case_id = ?').get(CASE_ID)).toMatchObject({ count: 1 });
  });

  it('rejects stale etags, missing reasons, invalid amounts, and forbidden transitions', () => {
    const review = service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"3"', idempotencyKey: 'review', action: 'start_review', toState: 'under_review', reason: '已開始審查申請資料' });
    expect(review.case.rowVersion).toBe(4);
    expect(() => service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"3"', idempotencyKey: 'stale', action: 'request_documents', toState: 'awaiting_documents', reason: '補件' })).toThrowError(expect.objectContaining({ code: 'ETAG_MISMATCH' }));
    expect(() => service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"4"', idempotencyKey: 'bad-reason', action: 'approve', toState: 'approved', reason: ' ', approvedAmountTwd: 1 })).toThrowError(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(() => service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"4"', idempotencyKey: 'bad-amount', action: 'approve', toState: 'approved', reason: '核准', approvedAmountTwd: 10001 })).toThrowError(expect.objectContaining({ code: 'APPROVED_AMOUNT_EXCEEDS_CAP' }));
    expect(() => service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"4"', idempotencyKey: 'bad-state', action: 'await_disbursement', toState: 'awaiting_disbursement', reason: '撥款' })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_TRANSITION' }));
  });

  it('records the actual transfer amount when a case is marked as disbursed', () => {
    database.prepare("UPDATE cases SET state = 'awaiting_disbursement', approved_amount_twd = 2000, row_version = 4 WHERE id = ?").run(CASE_ID);

    const result = service().decide({
      adminId: ADMIN_ID,
      caseId: CASE_ID,
      ifMatch: '"4"',
      idempotencyKey: 'disburse-actual-amount',
      action: 'disburse',
      toState: 'disbursed',
      reason: '已完成匯款作業',
      disbursedAmountTwd: 1850,
    });

    expect(result.case).toMatchObject({
      state: 'disbursed',
      approvedAmountTwd: 2000,
      disbursedAmountTwd: 1850,
    });
    expect(database.prepare('SELECT disbursed_amount_twd FROM cases WHERE id = ?').get(CASE_ID)).toEqual({
      disbursed_amount_twd: 1850,
    });
  });

  it('rolls back the complete command when the notification outbox cannot be written', () => {
    const failing = service({ notificationWriter: () => { throw new Error('queue unavailable'); } });
    expect(() => failing.decide({
      adminId: ADMIN_ID,
      caseId: CASE_ID,
      ifMatch: '"3"',
      idempotencyKey: 'notification-failure',
      action: 'start_review',
      toState: 'under_review',
      reason: '開始審查',
    })).toThrow('queue unavailable');
    expect(database.prepare('SELECT state, row_version FROM cases WHERE id = ?').get(CASE_ID)).toMatchObject({ state: 'submitted', row_version: 3 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM case_state_transitions WHERE case_id = ?').get(CASE_ID)).toMatchObject({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = \'case\' AND entity_id = ?').get(CASE_ID)).toMatchObject({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM api_idempotency_keys').get()).toMatchObject({ count: 0 });
  });

  it('requires an authenticated admin scope and valid idempotency key', () => {
    expect(() => service().decide({ adminId: '', caseId: CASE_ID, ifMatch: '"3"', idempotencyKey: 'x', action: 'start_review', toState: 'under_review' })).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(() => service().decide({ adminId: ADMIN_ID, caseId: CASE_ID, ifMatch: '"3"', idempotencyKey: ' ', action: 'start_review', toState: 'under_review' })).toThrowError(AdminReviewError);
  });
});
