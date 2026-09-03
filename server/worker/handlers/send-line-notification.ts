import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../../db/connection';
import type { DurableJob } from '../../db/repositories/jobs';
import { decryptDatabaseText } from '../../db/repositories/encrypted-fields';
import { notificationPresentation, type NotificationTemplate } from '../../domain/notification-template';
import { LineMessagingError, type LineMessagingClient } from '../../adapters/line/messaging-client';

function reviewTransitionContext(database: FlowPassDatabase, crypto: FieldCrypto, caseId: string, businessKey: string): { state: string; reason: string | null } | null {
  const prefix = `case:${caseId}:transition:`;
  if (!businessKey.startsWith(prefix)) return null;
  const transitionId = businessKey.slice(prefix.length);
  if (!transitionId) return null;
  const row = database.prepare('SELECT id, to_state, reason_enc FROM case_state_transitions WHERE id = ? AND case_id = ?').get(transitionId, caseId) as { id: string; to_state: string; reason_enc: string | null } | undefined;
  if (!row) return null;
  return {
    state: row.to_state,
    reason: row.reason_enc ? decryptDatabaseText(crypto, 'case_state_transitions', 'reason_enc', row.id, row.reason_enc) : null,
  };
}

export async function sendLineNotification(job: DurableJob, input: { database: FlowPassDatabase; crypto: FieldCrypto; client: LineMessagingClient; liffId: string; now?: string }): Promise<void> {
  if (job.jobType !== 'line_notification') throw new Error('wrong job type');
  const payload = job.payload as Record<string, unknown>;
  const notificationJobId = typeof payload.notificationJobId === 'string' ? payload.notificationJobId : null;
  if (!notificationJobId) throw new Error('notification payload is invalid');
  const row = input.database.prepare(`SELECT n.template, n.status, n.attempts, n.created_at, n.business_key, n.case_id, c.state AS case_state, c.approved_amount_twd, c.disbursed_amount_twd, li.line_subject_enc, li.id AS identity_id FROM notification_jobs n JOIN cases c ON c.id = n.case_id JOIN line_identities li ON li.applicant_id = c.applicant_id AND li.push_state = 'enabled' WHERE n.id = ? ORDER BY li.linked_at DESC LIMIT 1`).get(notificationJobId) as { template: string; status: string; attempts: number; created_at: string; business_key: string; case_id: string; case_state: string; approved_amount_twd: number | null; disbursed_amount_twd: number | null; line_subject_enc: string; identity_id: string } | undefined;
  if (!row || row.status === 'sent_confirmed') return;
  if (row.status === 'unknown_delivery' && row.attempts >= 2) return;
  const subject = decryptDatabaseText(input.crypto, 'line_identities', 'line_subject_enc', row.identity_id, row.line_subject_enc);
  try {
    const transition = reviewTransitionContext(input.database, input.crypto, row.case_id, row.business_key);
    const presentation = notificationPresentation(row.template as NotificationTemplate, input.liffId, row.created_at, {
      state: transition?.state ?? row.case_state,
      reason: transition?.reason ?? null,
      approvedAmountTwd: row.approved_amount_twd,
      disbursedAmountTwd: row.disbursed_amount_twd,
    });
    await input.client.push({ to: subject, retryKey: notificationJobId, ...presentation });
    input.database.prepare(`UPDATE notification_jobs SET status = 'sent_confirmed', sent_at = ?, attempts = attempts + 1, provider_message_id = COALESCE(provider_message_id, 'line-accepted') WHERE id = ? AND status IN ('pending','leased','unknown_delivery')`).run(input.now ?? new Date().toISOString(), notificationJobId);
  } catch (error) {
    const status = error instanceof LineMessagingError ? error.status : 0;
    const nextStatus = status === 429 || status >= 500 ? 'pending' : row.status === 'unknown_delivery' ? 'failed_terminal' : 'unknown_delivery';
    input.database.prepare('UPDATE notification_jobs SET status = ?, attempts = attempts + 1, failure_code = ? WHERE id = ? AND status IN (\'pending\', \'leased\', \'unknown_delivery\')').run(nextStatus, status === 429 ? 'LINE_RATE_LIMITED' : status >= 500 ? 'LINE_SERVER_ERROR' : 'LINE_UNKNOWN_DELIVERY', notificationJobId);
    throw error;
  }
}
