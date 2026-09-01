import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LineNotificationPush } from '../../adapters/line/messaging-client';
import { FieldCrypto, type Keyring } from '../../crypto/field-crypto';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { insertLineIdentityWithEncryptedSubject } from '../../db/repositories/identities';
import { insertPublicNotificationJobForSystem } from '../../db/repositories/notifications';
import type { DurableJob } from '../../db/repositories/jobs';
import { sendLineNotification } from './send-line-notification';

const NOW = '2026-09-01T02:02:00.000Z';
const IDS = {
  applicant: '0198f080-0000-7000-8000-000000000001',
  identity: '0198f080-0000-7000-8000-000000000002',
  cycle: '0198f080-0000-7000-8000-000000000003',
  rule: '0198f080-0000-7000-8000-000000000004',
  case: '0198f080-0000-7000-8000-000000000005',
  notification: '0198f080-0000-7000-8000-000000000006',
  submissionNotification: '0198f080-0000-7000-8000-000000000007',
};

function cryptoForTests(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey: (id) => (id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined),
  };
  return new FieldCrypto(keyring);
}

describe('LINE notification worker', () => {
  let dir: string;
  let database: ReturnType<typeof openDatabase>;
  let crypto: FieldCrypto;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-line-notification-'));
    database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    crypto = cryptoForTests();

    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
    database.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, submitted_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.case, 'FP-20260901-00000001', IDS.applicant, IDS.cycle, IDS.rule, 'under_review', NOW, NOW, NOW, 1);
    insertLineIdentityWithEncryptedSubject(database, crypto, {
      id: IDS.identity,
      applicantId: IDS.applicant,
      lineSubject: 'U-flowpass-test',
      linkedAt: NOW,
      pushState: 'enabled',
      rowVersion: 1,
    });
    insertPublicNotificationJobForSystem(database, { systemId: 'test-worker' }, {
      id: IDS.notification,
      caseId: IDS.case,
      taskId: null,
      alertId: null,
      businessKey: `case:${IDS.case}:review`,
      template: 'review_updated',
      payload: { notificationType: 'review', messageCode: 'review_updated', locale: 'zh-TW', publicPath: '/app/tasks' },
      providerRetryKey: `case-${IDS.case}-review`,
      status: 'pending',
      attempts: 0,
      availableAt: NOW,
      createdAt: NOW,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns a review update into a safe actionable card and confirms delivery', async () => {
    const pushed: LineNotificationPush[] = [];
    const job: DurableJob = {
      id: 'job-1',
      jobType: 'line_notification',
      payload: { notificationJobId: IDS.notification },
      state: 'leased',
      uniqueKey: 'line-notification:test',
      attempts: 1,
      maxAttempts: 3,
      availableAt: NOW,
      leaseOwner: 'worker-1',
      leaseUntil: null,
      lastErrorCode: null,
      createdAt: NOW,
      completedAt: null,
    };

    await sendLineNotification(job, {
      database,
      crypto,
      client: { push: async (input) => { pushed.push(input); } },
      liffId: 'flowpass-liff',
      now: '2026-09-01T02:03:00.000Z',
    });

    expect(pushed).toEqual([
      expect.objectContaining({
        to: 'U-flowpass-test',
        title: '案件狀態更新',
        actionLabel: '查看申請紀錄',
        updatedAtLabel: '2026/09/01 10:02',
        uri: 'https://liff.line.me/flowpass-liff/passports',
      }),
    ]);
    expect(database.prepare('SELECT status, sent_at FROM notification_jobs WHERE id = ?').get(IDS.notification)).toEqual({
      status: 'sent_confirmed',
      sent_at: '2026-09-01T02:03:00.000Z',
    });
  });

  it('turns an approval into an amount-first card and uses the notification UUID as its retry key', async () => {
    database.prepare("UPDATE cases SET state = 'approved', approved_amount_twd = 2000 WHERE id = ?").run(IDS.case);
    const pushed: LineNotificationPush[] = [];
    const job: DurableJob = {
      id: 'job-approved',
      jobType: 'line_notification',
      payload: { notificationJobId: IDS.notification },
      state: 'leased',
      uniqueKey: 'line-notification:approved',
      attempts: 1,
      maxAttempts: 3,
      availableAt: NOW,
      leaseOwner: 'worker-1',
      leaseUntil: null,
      lastErrorCode: null,
      createdAt: NOW,
      completedAt: null,
    };

    await sendLineNotification(job, {
      database,
      crypto,
      client: { push: async (input) => { pushed.push(input); } },
      liffId: 'flowpass-liff',
    });

    expect(pushed).toEqual([
      expect.objectContaining({
        text: '核定通知：核定金額 NT$2,000，請開啟查看。',
        title: '核定通知',
        body: '您的案件已核定。',
        amountLabel: '核定金額',
        amountValue: 'NT$2,000',
        retryKey: IDS.notification,
      }),
    ]);
  });

  it('turns a completed transfer into an amount-first card using the stored transfer amount', async () => {
    database.prepare("UPDATE cases SET state = 'disbursed', approved_amount_twd = 2000, disbursed_amount_twd = 1850 WHERE id = ?").run(IDS.case);
    const pushed: LineNotificationPush[] = [];
    const job: DurableJob = {
      id: 'job-disbursed',
      jobType: 'line_notification',
      payload: { notificationJobId: IDS.notification },
      state: 'leased',
      uniqueKey: 'line-notification:disbursed',
      attempts: 1,
      maxAttempts: 3,
      availableAt: NOW,
      leaseOwner: 'worker-1',
      leaseUntil: null,
      lastErrorCode: null,
      createdAt: NOW,
      completedAt: null,
    };

    await sendLineNotification(job, {
      database,
      crypto,
      client: { push: async (input) => { pushed.push(input); } },
      liffId: 'flowpass-liff',
    });

    expect(pushed).toEqual([
      expect.objectContaining({
        text: '轉帳成功：匯款金額 NT$1,850，請開啟查看。',
        title: '轉帳成功',
        body: '款項已完成轉帳。',
        amountLabel: '匯款金額',
        amountValue: 'NT$1,850',
      }),
    ]);
  });

  it('accepts the existing passport list as the submission notification destination', () => {
    expect(() => insertPublicNotificationJobForSystem(database, { systemId: 'test-worker' }, {
      id: IDS.submissionNotification,
      caseId: IDS.case,
      taskId: null,
      alertId: null,
      businessKey: `case:${IDS.case}:submitted`,
      template: 'submission_acknowledged',
      payload: { notificationType: 'submission', messageCode: 'submission_acknowledged', locale: 'zh-TW', publicPath: '/app/passports' },
      providerRetryKey: `case-${IDS.case}-submitted`,
      status: 'pending',
      attempts: 0,
      availableAt: NOW,
      createdAt: NOW,
    })).not.toThrow();
  });
});
