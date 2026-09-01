import { timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  ApiErrorCode,
  apiFailure,
  apiSuccess,
  type ApiFailure,
  type ApiSuccess,
} from '../../shared/api-contract';
import {
  LineLoginError,
  LineLoginVerificationError,
  type LineLoginClient,
} from '../adapters/line/line-login-client';
import type { FieldCrypto } from '../crypto/field-crypto';
import { createSecretToken, hashToken } from '../crypto/token-hash';
import type { FlowPassDatabase } from '../db/connection';
import {
  findLineIdentityForSystemBySubject,
  insertApplicantWithEncryptedDisplayLabel,
  insertLineIdentityWithEncryptedSubject,
} from '../db/repositories/identities';
import {
  readEncryptedIdempotencyResponse,
  storeEncryptedIdempotencyResponse,
  updateEncryptedIdempotencyResponse,
} from '../db/repositories/idempotency';
import { createSessionRepository } from '../db/repositories/sessions';
import { type IssuedSession, type SessionService } from './session-service';

const BOOTSTRAP_TTL_MILLISECONDS = 5 * 60_000;
const IDEMPOTENCY_TTL_MILLISECONDS = 24 * 60 * 60_000;
const PRODUCTION_PUBLIC_ORIGIN = 'https://flowpass.luecat.com';

export const RateLimitAction = {
  LOGIN_BOOTSTRAP: 'login_bootstrap',
  LOGIN_EXCHANGE: 'login_exchange',
  CASE_CREATE: 'case_create',
  AI_DRAFT: 'ai_draft',
  UPLOAD_BYTES: 'upload_bytes',
  INVALID_WEBHOOK: 'invalid_webhook',
} as const;

export type RateLimitAction = (typeof RateLimitAction)[keyof typeof RateLimitAction];

export interface RateLimitPolicy {
  action: RateLimitAction;
  limit: number;
  window: 'utc-minute' | 'taipei-day';
}

export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitAction, RateLimitPolicy>> = {
  [RateLimitAction.LOGIN_BOOTSTRAP]: { action: RateLimitAction.LOGIN_BOOTSTRAP, limit: 10, window: 'utc-minute' },
  [RateLimitAction.LOGIN_EXCHANGE]: { action: RateLimitAction.LOGIN_EXCHANGE, limit: 10, window: 'utc-minute' },
  [RateLimitAction.CASE_CREATE]: { action: RateLimitAction.CASE_CREATE, limit: 5, window: 'taipei-day' },
  [RateLimitAction.AI_DRAFT]: { action: RateLimitAction.AI_DRAFT, limit: 20, window: 'taipei-day' },
  [RateLimitAction.UPLOAD_BYTES]: { action: RateLimitAction.UPLOAD_BYTES, limit: 60 * 1024 * 1024, window: 'taipei-day' },
  [RateLimitAction.INVALID_WEBHOOK]: { action: RateLimitAction.INVALID_WEBHOOK, limit: 120, window: 'utc-minute' },
};

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

function taipeiWindowStart(now: Date): Date {
  // Taiwan has no daylight-saving transition. Build calendar fields explicitly instead of relying on host locale.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')) - 8 * 60 * 60_000);
}

function rateWindow(now: Date, policy: RateLimitPolicy): { start: Date; end: Date } {
  if (policy.window === 'utc-minute') {
    const start = new Date(now.getTime());
    start.setUTCSeconds(0, 0);
    return { start, end: new Date(start.getTime() + 60_000) };
  }
  const start = taipeiWindowStart(now);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

/** Persisted, HMAC-scoped limiter. Its caller controls which already-validated scope becomes a bucket key. */
export class RateLimiter {
  constructor(
    private readonly database: FlowPassDatabase,
    private readonly crypto: FieldCrypto,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  consume(input: { action: RateLimitAction; scope: string; amount?: number }): RateLimitResult {
    const policy = RATE_LIMIT_POLICIES[input.action];
    const amount = input.amount ?? 1;
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('Rate limit amount is invalid');
    }
    const now = this.clock();
    const { start, end } = rateWindow(now, policy);
    const scopeKeyHmac = this.crypto.hmacLookup(input.scope, `rate-limit:${policy.action}`);
    const row = this.database
      .prepare(
        `INSERT INTO rate_limit_buckets (scope_key_hmac, action, window_start_at, count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key_hmac, action, window_start_at) DO UPDATE SET count = count + excluded.count
         WHERE rate_limit_buckets.count + excluded.count <= ?
         RETURNING count`,
      )
      .get(scopeKeyHmac, policy.action, start.toISOString(), amount, policy.limit) as
      | { count: number }
      | undefined;
    return {
      allowed: Boolean(row),
      retryAfter: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 1000)),
    };
  }
}

/**
 * Reusable Task 7 admission guard. It keeps the durable AI policy beside the
 * persisted rate limiter so a later route cannot accidentally implement a
 * browser-only cooldown. The Task 7 enqueue must call this in the same short
 * SQLite transaction that inserts its `ai_draft` job.
 */
export class AiDraftAdmissionGuard {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly database: FlowPassDatabase,
    crypto: FieldCrypto,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.limiter = new RateLimiter(database, crypto, clock);
  }

  admit(input: { applicantId: string; caseId: string }): RateLimitResult {
    const now = this.clock();
    const active = this.database
      .prepare(
        `SELECT 1
         FROM jobs
         JOIN cases
           ON cases.id = json_extract(jobs.payload_json, '$.caseId')
          AND cases.applicant_id = ?
         WHERE jobs.job_type = 'ai_draft'
           AND json_type(jobs.payload_json, '$.caseId') = 'text'
           AND json_extract(jobs.payload_json, '$.caseId') = ?
           AND jobs.state IN ('queued', 'leased')
         LIMIT 1`,
      )
      .get(input.applicantId, input.caseId);
    if (active) {
      return { allowed: false, retryAfter: 10 };
    }

    const mostRecent = this.database
      .prepare(
        `SELECT jobs.created_at
         FROM jobs
         JOIN cases
           ON cases.id = json_extract(jobs.payload_json, '$.caseId')
          AND cases.applicant_id = ?
         WHERE jobs.job_type = 'ai_draft'
           AND json_type(jobs.payload_json, '$.caseId') = 'text'
           AND json_extract(jobs.payload_json, '$.caseId') = ?
         ORDER BY jobs.created_at DESC, jobs.id DESC
         LIMIT 1`,
      )
      .get(input.applicantId, input.caseId) as { created_at: string } | undefined;
    if (mostRecent) {
      const nextAllowedAt = Date.parse(mostRecent.created_at) + 10_000;
      if (Number.isFinite(nextAllowedAt) && nextAllowedAt > now.getTime()) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((nextAllowedAt - now.getTime()) / 1000)) };
      }
    }

    return this.limiter.consume({
      action: RateLimitAction.AI_DRAFT,
      scope: input.applicantId,
    });
  }
}

export interface CookieValue {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge?: number;
}

export interface BootstrapSuccess {
  kind: 'success';
  nonce: string;
  cookie: CookieValue;
  expiresAt: string;
  requestId: string;
}

export interface ServiceFailure {
  kind: 'failure';
  status: number;
  code: ApiErrorCode;
  retryAfter?: number;
  body: ApiFailure;
}

export interface ExchangeSuccess {
  kind: 'success';
  status: 201;
  body: ApiSuccess<{ session: { expiresAt: string } }>;
  session: IssuedSession;
  sessionCookies: readonly CookieValue[];
}

export interface ExchangeReplay {
  kind: 'replay';
  status: number;
  body: ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure;
}

export interface LineSessionService {
  issueBootstrap(input: { origin: string | null }): BootstrapSuccess | ServiceFailure;
  exchange(input: {
    origin: string | null;
    idToken: string;
    nonce: string;
    bootstrapCookieNonce: string | null;
    idempotencyKey: string | null;
  }): Promise<ExchangeSuccess | ExchangeReplay | ServiceFailure>;
  authenticateApplicant(rawSessionToken: string | null): ReturnType<SessionService['authenticateApplicant']>;
  verifyApplicantCsrf(input: {
    sessionToken: string | null;
    csrfCookie: string | null;
    csrfHeader: string | null;
  }): ReturnType<SessionService['verifyApplicantCsrf']>;
  revokeApplicant(rawSessionToken: string | null): boolean;
  getApplicantCookieNames(): { bootstrap: string; session: string; csrf: string };
  isPublicOrigin(origin: string | null): boolean;
}

export interface LineSessionServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  sessionService: SessionService;
  lineLoginClient: LineLoginClient;
  publicOrigin: string;
  clock?: () => Date;
  idGenerator?: () => string;
  tokenFactory?: () => string;
  clientIpResolver?: () => string;
  requestIdGenerator?: () => string;
  allowInsecureLoopbackTest?: boolean;
}

function addMilliseconds(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function exactOrigin(value: string | null, expected: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== expected ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function safelyCompareSecret(left: string | null, right: string): boolean {
  if (!left) {
    return false;
  }
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function secretCookie(
  input: Omit<CookieValue, 'value'> & { value: string },
): CookieValue {
  const cookie = { ...input } as CookieValue;
  Object.defineProperty(cookie, 'value', { value: input.value, enumerable: false, writable: false });
  return cookie;
}

function secretResult<T extends object, K extends string, V>(
  result: T,
  field: K,
  value: V,
): T & Record<K, V> {
  Object.defineProperty(result, field, { value, enumerable: false, writable: false });
  return result as T & Record<K, V>;
}

function isValidIdempotencyKey(value: string | null): value is string {
  return Boolean(value && value.trim().length > 0 && value.length <= 256);
}

function publicFailure(
  code: ApiErrorCode,
  requestId: string,
  retryAfter?: number,
): ServiceFailure {
  const body = apiFailure(code, requestId, { retryAfter });
  return {
    kind: 'failure',
    status: body.status,
    code,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    body,
  };
}

function parseReplayBody(value: string): ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure;
  } catch {
    return null;
  }
}

function publicOriginCookieSettings(
  origin: string,
  allowInsecureLoopbackTest: boolean,
): { secure: boolean; bootstrapName: string } {
  if (origin === PRODUCTION_PUBLIC_ORIGIN) {
    return { secure: true, bootstrapName: '__Host-flowpass_login_bootstrap' };
  }
  if (allowInsecureLoopbackTest && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    return { secure: false, bootstrapName: 'flowpass_login_bootstrap' };
  }
  throw new Error('Public cookie origin is invalid');
}

function makeRequestHash(crypto: FieldCrypto, idToken: string, nonce: string): string {
  return crypto.hmacLookup(JSON.stringify({ idToken, nonce }), 'line-exchange-request');
}

function makeIdempotencyScope(crypto: FieldCrypto, nonceHash: string): string {
  return crypto.hmacLookup(nonceHash, 'line-exchange-idempotency');
}

/**
 * Server-only LIFF exchange. Raw nonce/token/session values are deliberately
 * non-enumerable return fields and never enter persisted public responses.
 */
export function createLineSessionService(options: LineSessionServiceOptions): LineSessionService {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const tokenFactory = options.tokenFactory ?? (() => createSecretToken().token);
  const requestIdGenerator = options.requestIdGenerator ?? uuidv7;
  const clientIpResolver = options.clientIpResolver ?? (() => '127.0.0.1');
  const allowInsecureLoopbackTest = options.allowInsecureLoopbackTest === true;
  const exactConfiguredOrigin = exactOrigin(options.publicOrigin, options.publicOrigin);
  if (!exactConfiguredOrigin) {
    throw new Error('Public origin is invalid');
  }
  const cookieSettings = publicOriginCookieSettings(exactConfiguredOrigin, allowInsecureLoopbackTest);
  const sessionRepository = createSessionRepository(options.database);
  const limiter = new RateLimiter(options.database, options.crypto, clock);

  const failure = (code: ApiErrorCode, retryAfter?: number) =>
    publicFailure(code, requestIdGenerator(), retryAfter);

  const reserveOrReplay = (
    scope: string,
    key: string,
    requestHash: string,
    now: string,
  ):
    | { kind: 'reserved'; expiresAt: string }
    | { kind: 'replay'; status: number; body: ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure }
    | { kind: 'conflict' } => {
    const existing = readEncryptedIdempotencyResponse(options.database, options.crypto, scope, key, now);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { kind: 'conflict' };
      }
      const body = parseReplayBody(existing.response);
      return body ? { kind: 'replay', status: existing.responseStatus, body } : { kind: 'conflict' };
    }
    const provisional = apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestIdGenerator());
    const expiresAt = addMilliseconds(new Date(now), IDEMPOTENCY_TTL_MILLISECONDS);
    try {
      storeEncryptedIdempotencyResponse(options.database, options.crypto, {
        scope,
        key,
        requestHash,
        responseStatus: provisional.status,
        response: JSON.stringify(provisional),
        expiresAt,
        createdAt: now,
      });
      return { kind: 'reserved', expiresAt };
    } catch {
      const raced = readEncryptedIdempotencyResponse(options.database, options.crypto, scope, key, now);
      if (raced && raced.requestHash === requestHash) {
        const body = parseReplayBody(raced.response);
        if (body) {
          return { kind: 'replay', status: raced.responseStatus, body };
        }
      }
      return { kind: 'conflict' };
    }
  };

  const finalize = (
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: string,
    response: ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure,
  ): boolean => {
    return updateEncryptedIdempotencyResponse(options.database, options.crypto, {
      scope,
      key,
      requestHash,
      responseStatus: 'error' in response ? response.status : 201,
      response: JSON.stringify(response),
      expiresAt,
      now: clock().toISOString(),
    });
  };

  const finalizeSafely = (
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: string,
    response: ApiSuccess<{ session: { expiresAt: string } }> | ApiFailure,
  ): void => {
    try {
      finalize(scope, key, requestHash, expiresAt, response);
    } catch {
      // The provisional response remains public-safe; never turn a cache write error into a secret-bearing error.
    }
  };

  return {
    issueBootstrap(input) {
      if (!exactOrigin(input.origin, exactConfiguredOrigin)) {
        return failure(ApiErrorCode.CSRF_FAILED);
      }
      const rate = limiter.consume({
        action: RateLimitAction.LOGIN_BOOTSTRAP,
        scope: clientIpResolver(),
      });
      if (!rate.allowed) {
        return failure(ApiErrorCode.RATE_LIMITED, rate.retryAfter);
      }
      const now = clock();
      const nonce = tokenFactory();
      let nonceHash: string;
      try {
        nonceHash = hashToken(nonce);
      } catch {
        throw new Error('Bootstrap token factory returned an invalid secret');
      }
      const expiresAt = addMilliseconds(now, BOOTSTRAP_TTL_MILLISECONDS);
      sessionRepository.insertLoginExchangeNonce({
        id: idGenerator(),
        nonceHash,
        origin: exactConfiguredOrigin,
        issuedAt: now.toISOString(),
        expiresAt,
      });
      const cookie = secretCookie({
        name: cookieSettings.bootstrapName,
        value: nonce,
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSettings.secure,
        path: '/',
        maxAge: BOOTSTRAP_TTL_MILLISECONDS / 1000,
      });
      const result = {
        kind: 'success' as const,
        expiresAt,
        cookie,
        requestId: requestIdGenerator(),
      } as BootstrapSuccess;
      return secretResult(result, 'nonce', nonce);
    },

    async exchange(input) {
      if (!exactOrigin(input.origin, exactConfiguredOrigin)) {
        return failure(ApiErrorCode.CSRF_FAILED);
      }
      if (!isValidIdempotencyKey(input.idempotencyKey)) {
        return failure(ApiErrorCode.INVALID_REQUEST);
      }
      const idempotencyKey = input.idempotencyKey;
      if (!safelyCompareSecret(input.bootstrapCookieNonce, input.nonce)) {
        return failure(ApiErrorCode.CSRF_FAILED);
      }
      let nonceHash: string;
      try {
        nonceHash = hashToken(input.nonce);
      } catch {
        return failure(ApiErrorCode.CSRF_FAILED);
      }
      const now = clock().toISOString();
      const scope = makeIdempotencyScope(options.crypto, nonceHash);
      const requestHash = makeRequestHash(options.crypto, input.idToken, input.nonce);
      // A completed/provisional same-request replay is a pure read and must not burn
      // an extra rate-limit unit on browser retry.
      const existing = readEncryptedIdempotencyResponse(
        options.database,
        options.crypto,
        scope,
        idempotencyKey,
        now,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return failure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
        }
        const body = parseReplayBody(existing.response);
        return body
          ? { kind: 'replay' as const, status: existing.responseStatus, body }
          : failure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
      }
      const rate = limiter.consume({ action: RateLimitAction.LOGIN_EXCHANGE, scope: clientIpResolver() });
      if (!rate.allowed) {
        return failure(ApiErrorCode.RATE_LIMITED, rate.retryAfter);
      }
      const reservation = reserveOrReplay(scope, idempotencyKey, requestHash, now);
      if (reservation.kind === 'conflict') {
        return failure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
      }
      if (reservation.kind === 'replay') {
        return { kind: 'replay' as const, status: reservation.status, body: reservation.body };
      }
      if (!sessionRepository.consumeLoginExchangeNonce(nonceHash, exactConfiguredOrigin, now)) {
        const response = apiFailure(ApiErrorCode.CSRF_FAILED, requestIdGenerator());
        finalizeSafely(scope, idempotencyKey, requestHash, reservation.expiresAt, response);
        return {
          kind: 'failure' as const,
          status: response.status,
          code: ApiErrorCode.CSRF_FAILED,
          body: response,
        };
      }

      let identity;
      try {
        identity = await options.lineLoginClient.verifyIdToken(input.idToken);
      } catch (error) {
        const code = error instanceof LineLoginError && error.code === LineLoginVerificationError.INVALID_TOKEN
          ? ApiErrorCode.LINE_TOKEN_INVALID
          : ApiErrorCode.DEPENDENCY_UNAVAILABLE;
        const response = apiFailure(code, requestIdGenerator());
        finalizeSafely(scope, idempotencyKey, requestHash, reservation.expiresAt, response);
        return { kind: 'failure' as const, status: response.status, code, body: response };
      }

      const issuedAt = clock().toISOString();
      let completed: { session: IssuedSession; body: ApiSuccess<{ session: { expiresAt: string } }> };
      try {
        completed = options.database.transaction(() => {
          const existing = findLineIdentityForSystemBySubject(
            options.database,
            { systemId: 'line-login-exchange' },
            options.crypto,
            identity.subject,
          );
          const applicantId = existing?.applicantId ?? idGenerator();
          if (!existing) {
            insertApplicantWithEncryptedDisplayLabel(options.database, options.crypto, {
              id: applicantId,
              displayLabel: 'FlowPass applicant',
              status: 'active',
              createdAt: issuedAt,
              updatedAt: issuedAt,
              rowVersion: 1,
            });
            insertLineIdentityWithEncryptedSubject(options.database, options.crypto, {
              id: idGenerator(),
              applicantId,
              lineSubject: identity.subject,
              linkedAt: issuedAt,
              pushState: 'enabled',
              rowVersion: 1,
            });
          }
          const session = options.sessionService.issueApplicant({ applicantId, createdIp: clientIpResolver() });
          const body = apiSuccess({ session: { expiresAt: session.expiresAt } }, requestIdGenerator());
          if (!finalize(scope, idempotencyKey, requestHash, reservation.expiresAt, body)) {
            throw new Error('Idempotency response finalization failed');
          }
          return { session, body };
        })();
      } catch {
        const response = apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestIdGenerator());
        finalizeSafely(scope, idempotencyKey, requestHash, reservation.expiresAt, response);
        return { kind: 'failure' as const, status: response.status, code: ApiErrorCode.DEPENDENCY_UNAVAILABLE, body: response };
      }

      const sessionCookies = [
        secretCookie({
          name: 'flowpass_session',
          value: completed.session.sessionToken,
          httpOnly: true,
          sameSite: 'lax',
          secure: cookieSettings.secure,
          path: '/',
        }),
        secretCookie({
          name: 'flowpass_csrf',
          value: completed.session.csrfToken,
          httpOnly: false,
          sameSite: 'lax',
          secure: cookieSettings.secure,
          path: '/',
        }),
      ];
      const result = secretResult({
        kind: 'success' as const,
        status: 201 as const,
        body: completed.body,
        sessionCookies,
      }, 'session', completed.session);
      return result;
    },

    authenticateApplicant(rawSessionToken) {
      return rawSessionToken ? options.sessionService.authenticateApplicant(rawSessionToken) : null;
    },

    verifyApplicantCsrf(input) {
      if (!input.sessionToken || !input.csrfCookie || !input.csrfHeader) {
        return null;
      }
      return options.sessionService.verifyApplicantCsrf({
        sessionToken: input.sessionToken,
        csrfCookie: input.csrfCookie,
        csrfHeader: input.csrfHeader,
      });
    },

    revokeApplicant(rawSessionToken) {
      return rawSessionToken ? options.sessionService.revokeApplicant(rawSessionToken) : false;
    },

    getApplicantCookieNames() {
      return {
        bootstrap: cookieSettings.bootstrapName,
        session: 'flowpass_session',
        csrf: 'flowpass_csrf',
      };
    },

    isPublicOrigin(origin) {
      return Boolean(exactOrigin(origin, exactConfiguredOrigin));
    },
  };
}
