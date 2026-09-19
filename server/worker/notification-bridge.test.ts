import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { insertPublicNotificationJobForSystem } from '../db/repositories/notifications';
import { lineNotificationUniqueKey, selectBridgeablePendingNotifications } from './notification-bridge';

const NOW = '2026-09-01T02:02:00.000Z';
const LATER = '2026-09-02T02:02:00.000Z';
const IDS = {
  applicant: '0198f080-0000-7000-8000-000000000001',
  cycle: '0198f080-0000-7000-8000-000000000003',
  rule: '0198f080-0000-7000-8000-000000000004',
  case: '0198f080-0000-7000-8000-000000000005',
  stranded: '0198f080-0000-7000-8000-000000000006',
  fresh: '0198f080-0000-7000-8000-000000000007',
  job: '0198f080-0000-7000-8000-000000000008',
};

describe('LINE notification bridge', () => {
  let dir: string;
  let database: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-notification-bridge-'));
    database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
    database.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, submitted_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.case, 'FP-20260901-00000001', IDS.applicant, IDS.cycle, IDS.rule, 'under_review', NOW, NOW, NOW, 1);
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function addPendingNotification(id: string, createdAt: string, suffix: string): void {
    insertPublicNotificationJobForSystem(database, { systemId: 'test-bridge' }, {
      id,
      caseId: IDS.case,
      taskId: null,
      alertId: null,
      businessKey: `case:${IDS.case}:${suffix}`,
      template: 'review_updated',
      payload: { notificationType: 'review', messageCode: 'review_updated', locale: 'zh-TW', publicPath: '/app/tasks' },
      providerRetryKey: `case-${IDS.case}-${suffix}`,
      status: 'pending',
      attempts: 0,
      availableAt: createdAt,
      createdAt,
    });
  }

  it('skips a pending notification whose durable job already exists', () => {
    // The 2026-09-18 restore left rows pending while their jobs stayed completed.
    addPendingNotification(IDS.stranded, NOW, 'stranded');
    addPendingNotification(IDS.fresh, LATER, 'fresh');
    database.prepare(`INSERT INTO jobs (id, job_type, payload_json, state, unique_key, attempts, max_attempts, available_at, lease_owner, lease_until, last_error_code, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      IDS.job,
      'line_notification',
      JSON.stringify({ notificationJobId: IDS.stranded }),
      'completed',
      lineNotificationUniqueKey(IDS.stranded),
      1,
      3,
      NOW,
      null,
      null,
      null,
      NOW,
      NOW,
    );

    // Without the guard the stranded row wins the created_at ordering forever
    // and the later notification is never reached.
    expect(selectBridgeablePendingNotifications(database)).toEqual([IDS.fresh]);
  });

  it('returns pending notifications in creation order when nothing is bridged yet', () => {
    addPendingNotification(IDS.fresh, LATER, 'fresh');
    addPendingNotification(IDS.stranded, NOW, 'stranded');
    expect(selectBridgeablePendingNotifications(database)).toEqual([IDS.stranded, IDS.fresh]);
  });

  it('honours the batch limit', () => {
    addPendingNotification(IDS.stranded, NOW, 'stranded');
    addPendingNotification(IDS.fresh, LATER, 'fresh');
    expect(selectBridgeablePendingNotifications(database, 1)).toEqual([IDS.stranded]);
  });
});
