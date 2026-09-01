import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { DurableJobRunner } from './job-runner';

const INITIAL_TIME = '2026-08-30T00:00:00.000Z';

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

describe('DurableJobRunner', () => {
  let databaseDirectory: string;
  let databasePath: string;
  let db: Database.Database;
  let otherDb: Database.Database;

  beforeEach(() => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'flowpass-jobs-'));
    databasePath = join(databaseDirectory, 'flowpass.sqlite');
    db = openDatabase(databasePath);
    migrateDatabase(db);
    otherDb = openDatabase(databasePath);
  });

  afterEach(() => {
    otherDb.close();
    db.close();
    rmSync(databaseDirectory, { force: true, recursive: true });
  });

  it('leases a ready job to only one worker', () => {
    const firstRunner = new DurableJobRunner(db);
    const secondRunner = new DurableJobRunner(otherDb);
    const job = firstRunner.enqueue({
      jobType: 'ai_draft',
      payload: { caseId: 'lease-case-1' },
      uniqueKey: 'ai_draft:lease-case-1',
      availableAt: INITIAL_TIME,
    });

    expect(
      firstRunner.leaseNext({
        workerId: 'worker-a',
        now: INITIAL_TIME,
        leaseDurationMs: 5_000,
      }),
    ).toMatchObject({ id: job.id, state: 'leased', leaseOwner: 'worker-a' });
    expect(
      secondRunner.leaseNext({
        workerId: 'worker-b',
        now: INITIAL_TIME,
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
  });

  it('reclaims a lease after its expiry', () => {
    const firstRunner = new DurableJobRunner(db);
    const secondRunner = new DurableJobRunner(otherDb);
    const job = firstRunner.enqueue({
      jobType: 'ai_draft',
      payload: { caseId: 'case-1' },
      uniqueKey: 'ai_draft:case-1',
      availableAt: INITIAL_TIME,
    });

    firstRunner.leaseNext({ workerId: 'worker-a', now: INITIAL_TIME, leaseDurationMs: 1_000 });

    expect(
      secondRunner.leaseNext({
        workerId: 'worker-b',
        now: addMilliseconds(INITIAL_TIME, 1_001),
        leaseDurationMs: 5_000,
      }),
    ).toMatchObject({ id: job.id, state: 'leased', leaseOwner: 'worker-b', attempts: 2 });
  });

  it('returns the existing job for the same unique key', () => {
    const runner = new DurableJobRunner(db);
    const first = runner.enqueue({
      jobType: 'line_notification',
      payload: { caseId: 'case-1' },
      uniqueKey: 'line_notification:case-1:approved',
      availableAt: INITIAL_TIME,
    });
    const replay = runner.enqueue({
      jobType: 'line_notification',
      payload: { caseId: 'case-2' },
      uniqueKey: 'line_notification:case-1:approved',
      availableAt: addMilliseconds(INITIAL_TIME, 1_000),
    });

    expect(replay).toEqual(first);
  });

  it('normalizes RFC3339 timestamps to UTC before comparing ready jobs', () => {
    const runner = new DurableJobRunner(db);
    const job = runner.enqueue({
      jobType: 'line_webhook',
      payload: { eventId: 'event-offset' },
      uniqueKey: 'line_webhook:event-offset',
      createdAt: '2026-08-30T08:00:00+08:00',
      availableAt: '2026-08-30T08:00:00+08:00',
    });

    expect(job.availableAt).toBe(INITIAL_TIME);
    expect(
      runner.leaseNext({ workerId: 'worker-a', now: INITIAL_TIME, leaseDurationMs: 5_000 }),
    ).toMatchObject({ id: job.id, state: 'leased' });
  });

  it('completes a job idempotently', () => {
    const runner = new DurableJobRunner(db);
    const job = runner.enqueue({
      jobType: 'line_webhook',
      payload: { eventId: 'event-complete' },
      uniqueKey: 'line_webhook:event-complete',
      availableAt: INITIAL_TIME,
    });
    runner.leaseNext({ workerId: 'worker-a', now: INITIAL_TIME, leaseDurationMs: 5_000 });

    const firstCompletion = runner.complete({
      jobId: job.id,
      workerId: 'worker-a',
      completedAt: addMilliseconds(INITIAL_TIME, 100),
    });
    const replayCompletion = runner.complete({
      jobId: job.id,
      workerId: 'worker-a',
      completedAt: addMilliseconds(INITIAL_TIME, 200),
    });

    expect(firstCompletion).toMatchObject({ id: job.id, state: 'completed' });
    expect(replayCompletion).toEqual(firstCompletion);
  });

  it('retries with bounded exponential backoff', () => {
    const runner = new DurableJobRunner(db);
    const job = runner.enqueue({
      jobType: 'line_notification',
      payload: { caseId: 'backoff-case-1' },
      uniqueKey: 'line_notification:backoff-case-1',
      maxAttempts: 10,
      availableAt: INITIAL_TIME,
    });
    let now = INITIAL_TIME;
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];

    for (const expectedDelay of expectedDelays) {
      const leased = runner.leaseNext({ workerId: 'worker-a', now, leaseDurationMs: 5_000 });
      expect(leased).toMatchObject({ id: job.id, state: 'leased' });

      const retried = runner.fail({
        jobId: job.id,
        workerId: 'worker-a',
        errorCode: 'AI_UNAVAILABLE',
        now,
      });
      if (!retried) {
        throw new Error('expected the leased job to be queued for retry');
      }
      expect(retried).toMatchObject({ id: job.id, state: 'queued' });
      expect(Date.parse(retried.availableAt) - Date.parse(now)).toBe(expectedDelay);
      now = retried.availableAt;
    }
  });

  it('does not retry terminal errors', () => {
    const runner = new DurableJobRunner(db);
    const job = runner.enqueue({
      jobType: 'line_webhook',
      payload: { eventId: 'event-1' },
      uniqueKey: 'line_webhook:event-1',
      availableAt: INITIAL_TIME,
    });
    runner.leaseNext({ workerId: 'worker-a', now: INITIAL_TIME, leaseDurationMs: 5_000 });

    expect(
      runner.fail({
        jobId: job.id,
        workerId: 'worker-a',
        errorCode: 'LINE_WEBHOOK_SIGNATURE_INVALID',
        now: addMilliseconds(INITIAL_TIME, 100),
        terminal: true,
      }),
    ).toMatchObject({ id: job.id, state: 'failed_terminal' });
    expect(
      runner.leaseNext({
        workerId: 'worker-b',
        now: addMilliseconds(INITIAL_TIME, 61_000),
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
  });
});
