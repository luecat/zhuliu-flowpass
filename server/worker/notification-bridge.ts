import type { FlowPassDatabase } from '../db/connection';

/** Durable-queue unique key that links a notification row to its bridged job. */
export function lineNotificationUniqueKey(notificationJobId: string): string {
  return `line-notification:${notificationJobId}`;
}

/**
 * Pending notifications that still need a durable job.
 *
 * Rows whose job already exists are skipped. Without that guard a notification
 * left `pending` while its job row says `completed` — the state the 2026-09-18
 * restore produced — sits at the head of the `created_at` ordering forever:
 * `JobRepository.enqueue` hits `ON CONFLICT DO NOTHING`, re-reads the existing
 * completed job, reports success, and every later notification stays invisible
 * behind the same batch.
 */
export function selectBridgeablePendingNotifications(database: FlowPassDatabase, limit = 20): string[] {
  const rows = database.prepare(`
    SELECT n.id FROM notification_jobs n
    WHERE n.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.unique_key = 'line-notification:' || n.id)
    ORDER BY n.created_at ASC
    LIMIT ?
  `).all(limit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
