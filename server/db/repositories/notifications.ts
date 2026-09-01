import type { FlowPassDatabase } from '../connection';
import { requireAdminScope, requireSystemScope, type AdminScope, type SystemScope } from './scopes';

interface NotificationJobRow {
  id: string;
  case_id: string;
  task_id: string | null;
  alert_id: string | null;
  business_key: string;
  channel: 'line_push';
  template: string;
  status: string;
  provider_message_id: string | null;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  failure_code: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Internal notification-outbox projection; available only from admin-scoped functions. */
export interface AdminNotificationJobRecord {
  id: string;
  caseId: string;
  taskId: string | null;
  alertId: string | null;
  businessKey: string;
  channel: 'line_push';
  template: string;
  status: string;
  providerMessageId: string | null;
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  failureCode: string | null;
  createdAt: string;
  sentAt: string | null;
}

function mapNotificationJob(row: NotificationJobRow): AdminNotificationJobRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    taskId: row.task_id,
    alertId: row.alert_id,
    businessKey: row.business_key,
    channel: row.channel,
    template: row.template,
    status: row.status,
    providerMessageId: row.provider_message_id,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseUntil: row.lease_until,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export function listNotificationJobsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminNotificationJobRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT id, case_id, task_id, alert_id, business_key, channel, template, status,
              provider_message_id, attempts, available_at, lease_until, failure_code, created_at, sent_at
       FROM notification_jobs
       WHERE case_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(caseId) as NotificationJobRow[];

  return rows.map(mapNotificationJob);
}

const PUBLIC_NOTIFICATION_TEMPLATE_PAYLOADS = {
  task_ready: {
    notificationType: 'task',
    messageCode: 'task_ready',
    publicPath: '/app/tasks',
  },
  submission_acknowledged: {
    notificationType: 'submission',
    messageCode: 'submission_acknowledged',
    publicPath: '/app/passports',
  },
  review_updated: {
    notificationType: 'review',
    messageCode: 'review_updated',
    publicPath: '/app/tasks',
  },
  security_alert: {
    notificationType: 'security',
    messageCode: 'security_alert',
    publicPath: '/app/passports',
  },
} as const;
const PUBLIC_NOTIFICATION_LOCALES = new Set(['zh-TW', 'en-US']);
const PUBLIC_NOTIFICATION_KEYS = ['notificationType', 'messageCode', 'locale', 'publicPath'];

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Notification templates own their copy. Payloads therefore contain only fixed
 * public routing/message codes, never free text that could conceal a LINE subject,
 * invoice, prompt, attachment, bearer token, or decryptable field.
 */
function assertPublicSafeNotificationPayload(template: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error('Notification payload is not public-safe');
  }

  const expected = PUBLIC_NOTIFICATION_TEMPLATE_PAYLOADS[
    template as keyof typeof PUBLIC_NOTIFICATION_TEMPLATE_PAYLOADS
  ];
  const payload = value as Record<string, unknown>;
  if (
    !expected ||
    !hasExactKeys(payload, PUBLIC_NOTIFICATION_KEYS) ||
    payload.notificationType !== expected.notificationType ||
    payload.messageCode !== expected.messageCode ||
    payload.publicPath !== expected.publicPath ||
    typeof payload.locale !== 'string' ||
    !PUBLIC_NOTIFICATION_LOCALES.has(payload.locale)
  ) {
    throw new Error('Notification payload is not public-safe');
  }
}

export function insertPublicNotificationJobForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  input: {
    id: string;
    caseId: string;
    taskId: string | null;
    alertId: string | null;
    businessKey: string;
    template: string;
    payload: unknown;
    providerRetryKey: string;
    status: 'pending' | 'leased' | 'sent_confirmed' | 'unknown_delivery' | 'failed_terminal';
    attempts: number;
    availableAt: string;
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  assertPublicSafeNotificationPayload(input.template, input.payload);
  database
    .prepare(
      `INSERT INTO notification_jobs (
        id, case_id, task_id, alert_id, business_key, channel, template, payload_json,
        provider_retry_key, status, provider_message_id, attempts, available_at, lease_until,
        failure_code, created_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, 'line_push', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, NULL)`,
    )
    .run(
      input.id,
      input.caseId,
      input.taskId,
      input.alertId,
      input.businessKey,
      input.template,
      JSON.stringify(input.payload),
      input.providerRetryKey,
      input.status,
      input.attempts,
      input.availableAt,
      input.createdAt,
    );
}
