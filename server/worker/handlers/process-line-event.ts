import type { DurableJob } from '../../db/repositories/jobs';
import type { FlowPassDatabase } from '../../db/connection';

export function processLineEvent(job: DurableJob, input: { database: FlowPassDatabase; now?: string }): void {
  if (job.jobType !== 'line_webhook') throw new Error('wrong job type');
  const providerEventId = typeof (job.payload as Record<string, unknown>)?.providerEventId === 'string' ? (job.payload as { providerEventId: string }).providerEventId : null;
  if (!providerEventId) throw new Error('webhook payload is invalid');
  const now = input.now ?? new Date().toISOString();
  input.database.prepare(`UPDATE line_webhook_events SET processing_state = 'ignored', processed_at = ? WHERE provider_event_id = ? AND processing_state = 'queued'`).run(now, providerEventId);
}
