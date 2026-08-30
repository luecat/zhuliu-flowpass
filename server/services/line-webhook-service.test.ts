import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { acceptLineWebhookEvents } from './line-webhook-service';
describe('LINE webhook service', () => { it('deduplicates provider event IDs and queues accepted events', () => { const db = openDatabase(':memory:'); migrateDatabase(db); const event = { webhookEventId: 'evt-1', type: 'follow' }; expect(acceptLineWebhookEvents({ database: db }, [event, event])).toEqual({ accepted: 1, duplicates: 1 }); expect((db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE job_type=\'line_webhook\'').get() as { count: number }).count).toBe(1); db.close(); }); });
