import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { QueueDispatcher } from './queue-dispatcher';

describe('QueueDispatcher', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-dispatcher-'));
    db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('leases AI and notification classes independently', async () => {
    const now = '2026-08-30T00:00:00.000Z';
    const add = (type: 'ai_draft' | 'line_notification', key: string) => db.prepare(`INSERT INTO jobs (id, job_type, payload_json, state, unique_key, attempts, max_attempts, available_at, created_at) VALUES (?, ?, '{}', 'queued', ?, 0, 2, ?, ?)`).run(uuidv7(), type, key, now, now);
    add('ai_draft', 'ai-1');
    for (let index = 0; index < 5; index += 1) add('line_notification', `line-${index}`);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = new QueueDispatcher({ database: db, workerId: 'worker-1', clock: () => new Date(now), handlers: {
      ai_draft: async () => blocked,
      line_notification: async () => undefined,
    } });
    expect(dispatcher.dispatchOnce()).toBe(5);
    expect(dispatcher.activeCount('ai_draft')).toBe(1);
    expect(dispatcher.activeCount('line_notification')).toBe(4);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatcher.activeCount('ai_draft')).toBe(0);
    expect(dispatcher.activeCount('line_notification')).toBe(0);
  });
});
