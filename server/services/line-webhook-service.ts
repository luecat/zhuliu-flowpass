import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../db/connection';
import { JobRepository } from '../db/repositories/jobs';

export interface LineWebhookServiceOptions { database: FlowPassDatabase; clock?: () => Date; idGenerator?: () => string; }

export function acceptLineWebhookEvents(options: LineWebhookServiceOptions, events: unknown[]): { accepted: number; duplicates: number } {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const idGenerator = options.idGenerator ?? uuidv7;
  const jobs = new JobRepository(options.database);
  let accepted = 0; let duplicates = 0;
  options.database.transaction(() => {
    for (const event of events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      const value = event as Record<string, unknown>;
      const providerEventId = typeof value.webhookEventId === 'string' ? value.webhookEventId : null;
      const eventType = typeof value.type === 'string' ? value.type : 'unknown';
      if (!providerEventId || providerEventId.length > 256) continue;
      const inserted = options.database.prepare(`INSERT OR IGNORE INTO line_webhook_events (id, provider_event_id, event_type, line_identity_id, payload_hash, processing_state, received_at, processed_at) VALUES (?, ?, ?, NULL, ?, 'queued', ?, NULL)`).run(idGenerator(), providerEventId, eventType, createHash('sha256').update(JSON.stringify(value)).digest('hex'), now);
      if (inserted.changes !== 1) { duplicates += 1; continue; }
      jobs.enqueue({ systemId: 'line-webhook' }, { jobType: 'line_webhook', payload: { providerEventId }, uniqueKey: `line-webhook:${providerEventId}`, maxAttempts: 5, createdAt: now, availableAt: now });
      accepted += 1;
    }
  })();
  return { accepted, duplicates };
}
