import type { FlowPassDatabase } from '../connection';
import { requireSystemScope, type SystemScope } from './scopes';

interface WebhookEventRow {
  id: string;
  provider_event_id: string;
  event_type: string;
  line_identity_id: string | null;
  payload_hash: string;
  processing_state: string;
  received_at: string;
  processed_at: string | null;
}

/** Internal webhook-event projection; available only from system-scoped functions. */
export interface SystemWebhookEventRecord {
  id: string;
  providerEventId: string;
  eventType: string;
  lineIdentityId: string | null;
  payloadHash: string;
  processingState: string;
  receivedAt: string;
  processedAt: string | null;
}

function mapWebhookEvent(row: WebhookEventRow): SystemWebhookEventRecord {
  return {
    id: row.id,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    lineIdentityId: row.line_identity_id,
    payloadHash: row.payload_hash,
    processingState: row.processing_state,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

export function getWebhookEventForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  providerEventId: string,
): SystemWebhookEventRecord | null {
  requireSystemScope(scope);
  const row = database
    .prepare('SELECT * FROM line_webhook_events WHERE provider_event_id = ?')
    .get(providerEventId) as WebhookEventRow | undefined;

  return row ? mapWebhookEvent(row) : null;
}
