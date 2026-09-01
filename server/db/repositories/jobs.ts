import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../connection';
import { parseUtcRfc3339Timestamp } from '../timestamps';
import { requireApplicantScope, requireSystemScope, type ApplicantScope, type SystemScope } from './scopes';

export type JobType = 'ai_draft' | 'ocr' | 'line_webhook' | 'line_notification' | 'retention';
export type JobState = 'queued' | 'leased' | 'completed' | 'failed_terminal';

export interface WorkerScope {
  workerId: string;
}

export type { SystemScope } from './scopes';

export interface EnqueueJobInput {
  jobType: JobType;
  payload: unknown;
  uniqueKey: string;
  maxAttempts?: number;
  availableAt?: string;
  createdAt?: string;
}

export interface LeaseNextJobInput extends WorkerScope {
  now: string;
  leaseDurationMs: number;
  jobType?: JobType;
}

export interface CompleteJobInput extends WorkerScope {
  jobId: string;
  completedAt: string;
}

export interface FailJobInput extends WorkerScope {
  jobId: string;
  errorCode: string;
  now: string;
  terminal?: boolean;
}

interface JobRow {
  id: string;
  job_type: JobType;
  payload_json: string;
  state: JobState;
  unique_key: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  last_error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DurableJob {
  id: string;
  jobType: JobType;
  payload: unknown;
  state: JobState;
  uniqueKey: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Public-safe job projection: payloads, lease data, keys, and worker errors stay server-only. */
export interface ApplicantVisibleJob {
  id: string;
  state: JobState;
  createdAt: string;
  completedAt: string | null;
}

export function getApplicantVisibleJob(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  jobId: string,
): ApplicantVisibleJob | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT jobs.id, jobs.state, jobs.created_at, jobs.completed_at
       FROM jobs
       JOIN cases
         ON cases.id = json_extract(jobs.payload_json, '$.caseId')
        AND cases.applicant_id = ?
        AND cases.deleted_at IS NULL
       WHERE jobs.id = ?
         AND jobs.job_type = 'ai_draft'
         AND json_type(jobs.payload_json, '$.caseId') = 'text'`,
    )
    .get(scope.applicantId, jobId) as
    | { id: string; state: JobState; created_at: string; completed_at: string | null }
    | undefined;
  return row
    ? { id: row.id, state: row.state, createdAt: row.created_at, completedAt: row.completed_at }
    : null;
}

/** Lets an applicant reconnect to their own in-flight AI draft without exposing job internals. */
export function getApplicantActiveAiDraftJob(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantVisibleJob | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT jobs.id, jobs.state, jobs.created_at, jobs.completed_at
       FROM jobs
       JOIN cases
         ON cases.id = json_extract(jobs.payload_json, '$.caseId')
        AND cases.applicant_id = ?
        AND cases.deleted_at IS NULL
       WHERE jobs.job_type = 'ai_draft'
         AND json_type(jobs.payload_json, '$.caseId') = 'text'
         AND json_extract(jobs.payload_json, '$.caseId') = ?
         AND jobs.state IN ('queued', 'leased')
       ORDER BY jobs.created_at DESC, jobs.id DESC
       LIMIT 1`,
    )
    .get(scope.applicantId, caseId) as
    | { id: string; state: JobState; created_at: string; completed_at: string | null }
    | undefined;
  return row
    ? { id: row.id, state: row.state, createdAt: row.created_at, completedAt: row.completed_at }
    : null;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MILLISECONDS = 1_000;
const RETRY_MAX_MILLISECONDS = 60_000;

function mapJob(row: JobRow): DurableJob {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    uniqueKey: row.unique_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function serializePayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);

  if (serialized === undefined) {
    throw new Error('job payload must be JSON-serializable');
  }

  return serialized;
}

function transactionally<T>(database: FlowPassDatabase, callback: () => T): T {
  let transactionOpen = false;

  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const result = callback();
    database.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      database.exec('ROLLBACK');
    }
    throw error;
  }
}

export function retryDelayMilliseconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_MILLISECONDS * 2 ** exponent, RETRY_MAX_MILLISECONDS);
}

export class JobRepository {
  public constructor(private readonly database: FlowPassDatabase) {}

  public enqueue(scope: SystemScope, input: EnqueueJobInput): DurableJob {
    requireSystemScope(scope);

    const createdAt = parseUtcRfc3339Timestamp(input.createdAt ?? new Date().toISOString(), 'createdAt');
    const availableAt = parseUtcRfc3339Timestamp(input.availableAt ?? createdAt, 'availableAt');
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }

    this.database
      .prepare(
        `INSERT INTO jobs (
          id, job_type, payload_json, state, unique_key, attempts, max_attempts,
          available_at, lease_owner, lease_until, last_error_code, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (unique_key) DO NOTHING`,
      )
      .run(
        uuidv7(),
        input.jobType,
        serializePayload(input.payload),
        'queued',
        input.uniqueKey,
        0,
        maxAttempts,
        availableAt,
        null,
        null,
        null,
        createdAt,
        null,
      );

    const row = this.database
      .prepare('SELECT * FROM jobs WHERE unique_key = ?')
      .get(input.uniqueKey) as JobRow | undefined;

    if (!row) {
      throw new Error('job enqueue did not return a persisted job');
    }

    return mapJob(row);
  }

  public leaseNext(scope: WorkerScope, input: Omit<LeaseNextJobInput, 'workerId'>): DurableJob | null {
    if (!scope.workerId) {
      throw new Error('worker scope is required to lease a job');
    }

    const now = parseUtcRfc3339Timestamp(input.now, 'now');
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be greater than zero');
    }

    const leaseUntil = new Date(Date.parse(now) + input.leaseDurationMs).toISOString();

    return transactionally(this.database, () => {
      this.database
        .prepare(
          `UPDATE jobs
           SET state = 'queued', lease_owner = NULL, lease_until = NULL
           WHERE state = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?`,
        )
        .run(now);

      const candidate = input.jobType
        ? this.database.prepare(
          `SELECT * FROM jobs
           WHERE state = 'queued' AND available_at <= ? AND job_type = ?
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1`,
        ).get(now, input.jobType) as JobRow | undefined
        : this.database.prepare(
          `SELECT * FROM jobs
           WHERE state = 'queued' AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1`,
        ).get(now) as JobRow | undefined;

      if (!candidate) {
        return null;
      }

      const leaseResult = this.database
        .prepare(
          `UPDATE jobs
           SET state = 'leased', attempts = attempts + 1, lease_owner = ?, lease_until = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(scope.workerId, leaseUntil, candidate.id);

      if (leaseResult.changes !== 1) {
        return null;
      }

      const leased = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.id) as JobRow;
      return mapJob(leased);
    });
  }

  public complete(scope: WorkerScope, input: Omit<CompleteJobInput, 'workerId'>): DurableJob | null {
    if (!scope.workerId) {
      throw new Error('worker scope is required to complete a job');
    }

    const completedAt = parseUtcRfc3339Timestamp(input.completedAt, 'completedAt');
    const completion = this.database
      .prepare(
        `UPDATE jobs
         SET state = 'completed', completed_at = ?, lease_owner = NULL, lease_until = NULL
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(completedAt, input.jobId, scope.workerId);

    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(input.jobId) as JobRow | undefined;
    if (!row || (completion.changes === 0 && row.state !== 'completed')) {
      return null;
    }

    return mapJob(row);
  }

  public fail(scope: WorkerScope, input: Omit<FailJobInput, 'workerId'>): DurableJob | null {
    if (!scope.workerId) {
      throw new Error('worker scope is required to fail a job');
    }

    const now = parseUtcRfc3339Timestamp(input.now, 'now');
    const leased = this.database
      .prepare('SELECT * FROM jobs WHERE id = ? AND state = ? AND lease_owner = ?')
      .get(input.jobId, 'leased', scope.workerId) as JobRow | undefined;

    if (!leased) {
      const existing = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(input.jobId) as
        | JobRow
        | undefined;
      return existing?.state === 'failed_terminal' ? mapJob(existing) : null;
    }

    const terminal = input.terminal === true || leased.attempts >= leased.max_attempts;
    if (terminal) {
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET state = 'failed_terminal', lease_owner = NULL, lease_until = NULL, last_error_code = ?
           WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
        )
        .run(input.errorCode, input.jobId, scope.workerId);

      if (result.changes !== 1) {
        return null;
      }
    } else {
      const availableAt = new Date(
        Date.parse(now) + retryDelayMilliseconds(leased.attempts),
      ).toISOString();
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET state = 'queued', available_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = ?
           WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
        )
        .run(availableAt, input.errorCode, input.jobId, scope.workerId);

      if (result.changes !== 1) {
        return null;
      }
    }

    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(input.jobId) as JobRow;
    return mapJob(row);
  }
}
