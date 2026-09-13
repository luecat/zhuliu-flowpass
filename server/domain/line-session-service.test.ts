import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LineLoginError,
  LineLoginVerificationError,
  type LineLoginClient,
} from '../adapters/line/line-login-client';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createSessionRepository } from '../db/repositories/sessions';
import { SessionService } from './session-service';
import {
  AiDraftAdmissionGuard,
  RATE_LIMIT_POLICIES,
  RateLimitAction,
  RateLimiter,
  createLineSessionService,
} from './line-session-service';

const NOW = '2026-08-30T00:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:38100';
const SUBJECT = 'verified-subject-sentinel';

class FakeClock {
  private instant = new Date(NOW);

  now = (): Date => new Date(this.instant.getTime());

  advanceMilliseconds(value: number): void {
    this.instant = new Date(this.instant.getTime() + value);
  }
}

function createIds(): () => string {
  let sequence = 1;
  return () => `0198f050-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

function createTokens(): () => string {
  let sequence = 1;
  return () => Buffer.alloc(32, sequence++).toString('base64url');
}

function createCrypto(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey: (keyId) => (keyId === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined),
  };
  return new FieldCrypto(keyring);
}

function verifiedLineClient(): LineLoginClient {
  return {
    verifyIdToken: async () => ({
      subject: SUBJECT,
      audience: 'test-channel',
      issuer: 'https://access.line.me',
      expiresAt: '2026-08-30T00:01:00.000Z',
    }),
  };
}

describe('LineSessionService', () => {
  let directory: string;
  let database: Database.Database;
  let clock: FakeClock;
  let crypto: FieldCrypto;
  let service: ReturnType<typeof createLineSessionService>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-line-session-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    clock = new FakeClock();
    crypto = createCrypto();
    const ids = createIds();
    const sessionService = new SessionService({
      repository: createSessionRepository(database),
      clock: clock.now,
      idGenerator: ids,
      tokenFactory: createTokens(),
      ipHasher: (value) => crypto.hmacLookup(value, 'applicant-session-ip'),
    });
    service = createLineSessionService({
      database,
      crypto,
      sessionService,
      lineLoginClient: verifiedLineClient(),
      publicOrigin: ORIGIN,
      clock: clock.now,
      idGenerator: ids,
      tokenFactory: createTokens(),
      clientIpResolver: () => '198.51.100.10',
      allowInsecureLoopbackTest: true,
      requestIdGenerator: () => 'request-1',
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('issues a five-minute hash-only bootstrap nonce with a matching HttpOnly cookie and no idempotency row', () => {
    const issued = service.issueBootstrap({ origin: ORIGIN });
    expect(issued.kind).toBe('success');
    if (issued.kind !== 'success') {
      throw new Error('bootstrap unexpectedly failed');
    }
    const row = database.prepare('SELECT nonce_hash, origin, issued_at, expires_at FROM login_exchange_nonces').get() as Record<string, string>;

    expect(Buffer.from(issued.nonce, 'base64url')).toHaveLength(32);
    expect(issued.cookie).toMatchObject({
      name: 'flowpass_login_bootstrap',
      value: issued.nonce,
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    expect(row).toMatchObject({ origin: ORIGIN, issued_at: NOW, expires_at: '2026-08-30T00:05:00.000Z' });
    expect(JSON.stringify(row)).not.toContain(issued.nonce);
    expect(database.prepare('SELECT COUNT(*) AS count FROM api_idempotency_keys').get()).toEqual({ count: 0 });
  });

  it('exchanges only a matching, origin-bound nonce for a server-verified identity and stores no raw subject', async () => {
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');

    const result = await service.exchange({
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'exchange-1',
    });

    if (result.kind !== 'success') throw new Error('exchange failed');
    expect(result.kind).toBe('success');
    expect(result.body).toEqual({ data: { session: { expiresAt: '2026-08-30T00:30:00.000Z' } }, meta: { requestId: 'request-1' } });
    expect(result.session.sessionToken).toHaveLength(43);
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 1 });
    const stored = database.prepare('SELECT line_subject_enc, line_subject_hmac FROM line_identities').get() as Record<string, string>;
    expect(JSON.stringify(stored)).not.toContain(SUBJECT);
    expect(JSON.stringify(result.body)).not.toContain('id-token-sentinel');
    expect(JSON.stringify(result.body)).not.toContain(SUBJECT);
    const cached = database.prepare('SELECT response_enc FROM api_idempotency_keys').get() as { response_enc: string };
    for (const secret of [bootstrap.nonce, 'id-token-sentinel', SUBJECT, result.session.sessionToken, result.session.csrfToken]) {
      expect(JSON.stringify(cached)).not.toContain(secret);
    }
  });

  it('replays an identical exchange without creating a second session and rejects a changed body under the same idempotency key', async () => {
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');
    const input = {
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'exchange-1',
    };

    const first = await service.exchange(input);
    const replay = await service.exchange(input);
    const mismatch = await service.exchange({ ...input, idToken: 'other-id-token-sentinel' });

    if (first.kind !== 'success') throw new Error('exchange failed');
    expect(first.kind).toBe('success');
    expect(replay).toMatchObject({ kind: 'replay', status: 201, body: first.body });
    expect(mismatch).toMatchObject({ kind: 'failure', status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 1 });
  });

  it('replays an existing idempotent exchange before charging a saturated exchange rate bucket', async () => {
    const firstBootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (firstBootstrap.kind !== 'success') throw new Error('bootstrap failed');
    const firstInput = {
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: firstBootstrap.nonce,
      bootstrapCookieNonce: firstBootstrap.nonce,
      idempotencyKey: 'exchange-replay',
    };
    await service.exchange(firstInput);
    for (let index = 0; index < 9; index += 1) {
      const bootstrap = service.issueBootstrap({ origin: ORIGIN });
      if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');
      await service.exchange({
        origin: ORIGIN,
        idToken: 'id-token-sentinel',
        nonce: bootstrap.nonce,
        bootstrapCookieNonce: bootstrap.nonce,
        idempotencyKey: `exchange-${index}`,
      });
    }

    await expect(service.exchange(firstInput)).resolves.toMatchObject({ kind: 'replay', status: 201 });
  });

  it('rolls back identity and session creation when final idempotency-cache encryption/update cannot commit', async () => {
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');
    database.exec(`
      CREATE TRIGGER reject_idempotency_finalization
      BEFORE UPDATE ON api_idempotency_keys
      BEGIN
        SELECT RAISE(ABORT, 'idempotency finalization rejected');
      END;
    `);

    const result = await service.exchange({
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'exchange-atomic',
    });

    expect(result).toMatchObject({ kind: 'failure', status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM line_identities').get()).toEqual({ count: 0 });
  });

  it('burns a nonce when LINE verification rejects it without creating a session', async () => {
    service = createLineSessionService({
      database,
      crypto,
      sessionService: new SessionService({
        repository: createSessionRepository(database),
        clock: clock.now,
        idGenerator: createIds(),
        tokenFactory: createTokens(),
        ipHasher: (value) => crypto.hmacLookup(value, 'applicant-session-ip'),
      }),
      lineLoginClient: { verifyIdToken: async () => { throw new Error('LINE identity token is invalid'); } },
      publicOrigin: ORIGIN,
      clock: clock.now,
      idGenerator: createIds(),
      tokenFactory: createTokens(),
      clientIpResolver: () => '198.51.100.10',
      allowInsecureLoopbackTest: true,
      requestIdGenerator: () => 'request-1',
    });
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');

    const result = await service.exchange({
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'exchange-1',
    });

    expect(result).toMatchObject({ kind: 'failure', status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT consumed_at FROM login_exchange_nonces').get()).toEqual({ consumed_at: NOW });
  });

  it('maps a verified-adapter invalid-token failure to 401 without exposing supplied sentinels', async () => {
    service = createLineSessionService({
      database,
      crypto,
      sessionService: new SessionService({ repository: createSessionRepository(database), clock: clock.now, idGenerator: createIds(), tokenFactory: createTokens() }),
      lineLoginClient: {
        verifyIdToken: async () => {
          throw new LineLoginError(LineLoginVerificationError.INVALID_TOKEN);
        },
      },
      publicOrigin: ORIGIN,
      clock: clock.now,
      idGenerator: createIds(),
      tokenFactory: createTokens(),
      clientIpResolver: () => '198.51.100.10',
      allowInsecureLoopbackTest: true,
      requestIdGenerator: () => 'request-1',
    });
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');

    const result = await service.exchange({
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'invalid-token',
    });

    expect(result).toMatchObject({ kind: 'failure', status: 401, code: 'LINE_TOKEN_INVALID' });
    expect(JSON.stringify(result)).not.toContain('id-token-sentinel');
    expect(JSON.stringify(result)).not.toContain(bootstrap.nonce);
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 0 });
  });

  it('lets exactly one concurrent exchange reserve and consume a nonce', async () => {
    let markVerificationStarted: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    let releaseVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    service = createLineSessionService({
      database,
      crypto,
      sessionService: new SessionService({
        repository: createSessionRepository(database),
        clock: clock.now,
        idGenerator: createIds(),
        tokenFactory: createTokens(),
        ipHasher: (value) => crypto.hmacLookup(value, 'applicant-session-ip'),
      }),
      lineLoginClient: {
        verifyIdToken: async () => {
          markVerificationStarted?.();
          await verificationGate;
          return {
            subject: SUBJECT,
            audience: 'test-channel',
            issuer: 'https://access.line.me',
            expiresAt: '2026-08-30T00:01:00.000Z',
          };
        },
      },
      publicOrigin: ORIGIN,
      clock: clock.now,
      idGenerator: createIds(),
      tokenFactory: createTokens(),
      clientIpResolver: () => '198.51.100.10',
      allowInsecureLoopbackTest: true,
      requestIdGenerator: () => 'request-1',
    });
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');
    const input = {
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: bootstrap.nonce,
      idempotencyKey: 'concurrent-key',
    };

    const first = service.exchange(input);
    await verificationStarted;
    const second = await service.exchange(input);
    releaseVerification?.();
    const firstResult = await first;

    expect(firstResult.kind).toBe('success');
    expect(second).toMatchObject({ kind: 'replay', status: 503, body: { error: { code: 'DEPENDENCY_UNAVAILABLE' } } });
    expect(database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM login_exchange_nonces WHERE consumed_at IS NOT NULL').get()).toEqual({ count: 1 });
  });

  it('persists exact reusable rate-limit policies across fresh limiter instances', () => {
    expect(RATE_LIMIT_POLICIES).toMatchObject({
      [RateLimitAction.CASE_CREATE]: { limit: 30, window: 'taipei-day' },
      [RateLimitAction.AI_DRAFT]: { limit: 20, window: 'taipei-day' },
      [RateLimitAction.UPLOAD_BYTES]: { limit: 60 * 1024 * 1024, window: 'taipei-day' },
      [RateLimitAction.INVALID_WEBHOOK]: { limit: 120, window: 'utc-minute' },
    });
    const first = new RateLimiter(database, crypto, clock.now);
    for (let index = 0; index < 30; index += 1) {
      expect(first.consume({ action: RateLimitAction.CASE_CREATE, scope: 'applicant-a' }).allowed).toBe(true);
    }
    const second = new RateLimiter(database, crypto, clock.now);
    expect(second.consume({ action: RateLimitAction.CASE_CREATE, scope: 'applicant-a' })).toMatchObject({
      allowed: false,
      // 00:00Z is 08:00 in Taipei, so the next local calendar bucket starts
      // after sixteen hours rather than after a UTC calendar day.
      retryAfter: 16 * 60 * 60,
    });
    clock.advanceMilliseconds(16 * 60 * 60_000);
    expect(second.consume({ action: RateLimitAction.CASE_CREATE, scope: 'applicant-a' }).allowed).toBe(true);
  });

  it('keeps the AI daily guard durable while blocking an active case and a ten-second retry interval', () => {
    const applicantId = '0198f050-0000-7000-8000-000000000901';
    const programId = '0198f050-0000-7000-8000-000000000902';
    const ruleId = '0198f050-0000-7000-8000-000000000903';
    const caseId = '0198f050-0000-7000-8000-000000000904';
    const jobId = '0198f050-0000-7000-8000-000000000905';
    database.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, 'sealed', 'active', ?, ?, 1)`,
    ).run(applicantId, NOW, NOW);
    database.prepare(
      `INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version)
       VALUES (?, 'AI-GUARD', 'AI Guard', 2026, 'active', '{}', ?, ?, 1)`,
    ).run(programId, NOW, NOW);
    database.prepare(
      `INSERT INTO program_rule_versions (
        id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd,
        rounding_mode, required_documents_json, rules_json, created_at
      ) VALUES (?, ?, 1, 'draft', 5000, 10000, 'floor', '[]', '{}', ?)`,
    ).run(ruleId, programId, NOW);
    database.prepare(
      `INSERT INTO cases (
        id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state,
        created_at, updated_at, row_version
      ) VALUES (?, 'AI-GUARD-CASE', ?, ?, ?, 'draft', ?, ?, 1)`,
    ).run(caseId, applicantId, programId, ruleId, NOW, NOW);
    database.prepare(
      `INSERT INTO jobs (
        id, job_type, payload_json, state, unique_key, attempts, max_attempts,
        available_at, lease_owner, lease_until, last_error_code, created_at, completed_at
      ) VALUES (?, 'ai_draft', ?, 'queued', 'ai-guard-key', 0, 5, ?, NULL, NULL, NULL, ?, NULL)`,
    ).run(jobId, JSON.stringify({ caseId }), NOW, NOW);

    const guard = new AiDraftAdmissionGuard(database, crypto, clock.now);
    expect(guard.admit({ applicantId, caseId })).toEqual({ allowed: false, retryAfter: 10 });
    database.prepare("UPDATE jobs SET state = 'completed', completed_at = ? WHERE id = ?").run(NOW, jobId);
    expect(guard.admit({ applicantId, caseId })).toEqual({ allowed: false, retryAfter: 10 });
    clock.advanceMilliseconds(10_000);
    expect(guard.admit({ applicantId, caseId }).allowed).toBe(true);
  });

  it('limits the eleventh bootstrap in a UTC minute without issuing a nonce', () => {
    for (let index = 0; index < 10; index += 1) {
      expect(service.issueBootstrap({ origin: ORIGIN }).kind).toBe('success');
    }
    const rejected = service.issueBootstrap({ origin: ORIGIN });

    expect(rejected).toMatchObject({ kind: 'failure', status: 429, code: 'RATE_LIMITED', retryAfter: 60 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM login_exchange_nonces').get()).toEqual({ count: 10 });
  });

  it('requires matching body and cookie nonce values before consuming a nonce', async () => {
    const bootstrap = service.issueBootstrap({ origin: ORIGIN });
    if (bootstrap.kind !== 'success') throw new Error('bootstrap failed');
    const result = await service.exchange({
      origin: ORIGIN,
      idToken: 'id-token-sentinel',
      nonce: bootstrap.nonce,
      bootstrapCookieNonce: Buffer.alloc(32, 9).toString('base64url'),
      idempotencyKey: 'exchange-1',
    });

    expect(result).toMatchObject({ kind: 'failure', status: 403, code: 'CSRF_FAILED' });
    expect(database.prepare('SELECT consumed_at FROM login_exchange_nonces').get()).toEqual({ consumed_at: null });
  });
});
