import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../../db/connection';
import type { DurableJob } from '../../db/repositories/jobs';
import { decryptDatabaseText } from '../../db/repositories/encrypted-fields';
import { notificationText, notificationUri, type NotificationTemplate } from '../../domain/notification-template';
import { LineMessagingError, type LineMessagingClient } from '../../adapters/line/messaging-client';

export async function sendLineNotification(job: DurableJob, input: { database: FlowPassDatabase; crypto: FieldCrypto; client: LineMessagingClient; liffId: string; now?: string }): Promise<void> {
  if (job.jobType !== 'line_notification') throw new Error('wrong job type');
  const payload = job.payload as Record<string, unknown>;
  const notificationJobId = typeof payload.notificationJobId === 'string' ? payload.notificationJobId : null;
  if (!notificationJobId) throw new Error('notification payload is invalid');
  const row = input.database.prepare(`SELECT n.template, n.provider_retry_key, n.status, n.attempts, li.line_subject_enc, li.id AS identity_id FROM notification_jobs n JOIN cases c ON c.id = n.case_id JOIN line_identities li ON li.applicant_id = c.applicant_id AND li.push_state = 'enabled' WHERE n.id = ? ORDER BY li.linked_at DESC LIMIT 1`).get(notificationJobId) as { template: string; provider_retry_key: string; status: string; attempts: number; line_subject_enc: string; identity_id: string } | undefined;
  if (!row || row.status === 'sent_confirmed') return;
  if (row.status === 'unknown_delivery' && row.attempts >= 2) return;
  const subject = decryptDatabaseText(input.crypto, 'line_identities', 'line_subject_enc', row.identity_id, row.line_subject_enc);
  try {
    await input.client.push({ to: subject, text: notificationText(row.template as NotificationTemplate), uri: notificationUri(row.template as NotificationTemplate, input.liffId), retryKey: row.provider_retry_key });
    input.database.prepare(`UPDATE notification_jobs SET status = 'sent_confirmed', sent_at = ?, attempts = attempts + 1, provider_message_id = COALESCE(provider_message_id, 'line-accepted') WHERE id = ? AND status IN ('pending','leased','unknown_delivery')`).run(input.now ?? new Date().toISOString(), notificationJobId);
  } catch (error) {
    const status = error instanceof LineMessagingError ? error.status : 0;
    const nextStatus = status === 429 || status >= 500 ? 'pending' : row.status === 'unknown_delivery' ? 'failed_terminal' : 'unknown_delivery';
    input.database.prepare('UPDATE notification_jobs SET status = ?, attempts = attempts + 1, failure_code = ? WHERE id = ? AND status IN (\'pending\', \'leased\', \'unknown_delivery\')').run(nextStatus, status === 429 ? 'LINE_RATE_LIMITED' : status >= 500 ? 'LINE_SERVER_ERROR' : 'LINE_UNKNOWN_DELIVERY', notificationJobId);
    throw error;
  }
}
