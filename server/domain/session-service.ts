import { v7 as uuidv7 } from 'uuid';
import { createSecretToken, hashToken, verifyToken } from '../crypto/token-hash';
import type {
  AdminSessionPersistenceInput,
  AdminSessionPersistenceRecord,
  ApplicantSessionPersistenceInput,
  ApplicantSessionPersistenceRecord,
  SessionRepository,
} from '../db/repositories/sessions';

export type SessionKind = 'applicant' | 'admin';

export interface IssuedSession {
  readonly sessionToken: string;
  readonly csrfToken: string;
  sessionId: string;
  expiresAt: string;
}

export interface AuthenticatedApplicantSession {
  sessionId: string;
  applicantId: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface AuthenticatedAdminSession {
  sessionId: string;
  adminUserId: string;
  reauthenticatedAt: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface SessionServiceOptions {
  repository: SessionRepository;
  clock?: () => Date;
  idGenerator?: () => string;
  tokenFactory?: () => string;
  ipHasher?: (value: string) => string;
}

export interface CsrfCheckInput {
  sessionToken: string;
  csrfCookie: string;
  csrfHeader: string;
}

export interface SessionCookieOptions {
  name: string;
  httpOnly: boolean;
  sameSite: 'lax' | 'strict';
  secure: boolean;
  path: '/';
}

export interface SessionCookiePolicy {
  session: SessionCookieOptions;
  csrf: SessionCookieOptions;
}

export interface SessionCookiePolicyInput {
  kind: SessionKind;
  origin: string;
  allowInsecureLoopbackTest?: boolean;
}

const APPLICANT_IDLE_MINUTES = 30;
const ADMIN_IDLE_MINUTES = 15;
const ABSOLUTE_HOURS = 8;
const PRODUCTION_PUBLIC_ORIGIN = 'https://flowpass.luecat.com';
const ADMIN_LOOPBACK_ORIGIN = 'http://127.0.0.1:38101';

function nowIso(clock: () => Date): string {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Session clock is invalid');
  }
  return now.toISOString();
}

function addMinutes(isoTimestamp: string, minutes: number): string {
  return new Date(new Date(isoTimestamp).getTime() + minutes * 60_000).toISOString();
}

function addHours(isoTimestamp: string, hours: number): string {
  return new Date(new Date(isoTimestamp).getTime() + hours * 60 * 60_000).toISOString();
}

function cappedIdleExpiry(now: string, absoluteExpiresAt: string, idleMinutes: number): string {
  const requested = addMinutes(now, idleMinutes);
  return requested < absoluteExpiresAt ? requested : absoluteExpiresAt;
}

function isExpired(now: string, idleExpiresAt: string, absoluteExpiresAt: string): boolean {
  return now >= idleExpiresAt || now >= absoluteExpiresAt;
}

function createIssuedSession(
  sessionId: string,
  expiresAt: string,
  sessionToken: string,
  csrfToken: string,
): IssuedSession {
  const issued = { sessionId, expiresAt } as IssuedSession;
  Object.defineProperties(issued, {
    sessionToken: { value: sessionToken, enumerable: false, writable: false },
    csrfToken: { value: csrfToken, enumerable: false, writable: false },
  });
  return issued;
}

function applicantResult(
  row: ApplicantSessionPersistenceRecord,
  idleExpiresAt: string,
): AuthenticatedApplicantSession {
  return {
    sessionId: row.id,
    applicantId: row.applicantId,
    idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

function adminResult(
  row: AdminSessionPersistenceRecord,
  idleExpiresAt: string,
): AuthenticatedAdminSession {
  return {
    sessionId: row.id,
    adminUserId: row.adminUserId,
    reauthenticatedAt: row.reauthenticatedAt,
    idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

function tokenHashOrNull(token: string): string | null {
  try {
    return hashToken(token);
  } catch {
    return null;
  }
}

function isLoopbackHttp(origin: URL): boolean {
  return origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port.length > 0;
}

function isBareOrigin(origin: URL): boolean {
  return (
    origin.username.length === 0 &&
    origin.password.length === 0 &&
    origin.pathname === '/' &&
    origin.search.length === 0 &&
    origin.hash.length === 0
  );
}

export function createSessionCookiePolicy(input: SessionCookiePolicyInput): SessionCookiePolicy {
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error('Session cookie origin is invalid');
  }
  if (!isBareOrigin(origin)) {
    throw new Error('Session cookie origin is invalid');
  }

  let sameSite: 'lax' | 'strict';
  let secure: boolean;
  let sessionName: string;
  let csrfName: string;

  if (input.kind === 'applicant') {
    sameSite = 'lax';
    sessionName = 'flowpass_session';
    csrfName = 'flowpass_csrf';

    if (origin.origin === PRODUCTION_PUBLIC_ORIGIN) {
      secure = true;
    } else if (input.allowInsecureLoopbackTest === true && isLoopbackHttp(origin)) {
      secure = false;
    } else {
      throw new Error('Insecure applicant cookie origin is not allowed');
    }
  } else {
    sameSite = 'strict';
    sessionName = 'flowpass_admin_session';
    csrfName = 'flowpass_admin_csrf';

    if (origin.origin !== ADMIN_LOOPBACK_ORIGIN) {
      throw new Error('Insecure admin cookie origin is not allowed');
    }
    secure = false;
  }

  return {
    session: { name: sessionName, httpOnly: true, sameSite, secure, path: '/' },
    csrf: { name: csrfName, httpOnly: false, sameSite, secure, path: '/' },
  };
}

export class SessionService {
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly tokenFactory: () => string;

  constructor(private readonly options: SessionServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? uuidv7;
    this.tokenFactory = options.tokenFactory ?? (() => createSecretToken().token);
  }

  issueApplicant(input: { applicantId: string; createdIp?: string }): IssuedSession {
    const now = nowIso(this.clock);
    const absoluteExpiresAt = addHours(now, ABSOLUTE_HOURS);
    const sessionToken = this.tokenFactory();
    const csrfToken = this.tokenFactory();
    const createdIpHmac = input.createdIp
      ? this.options.ipHasher?.(input.createdIp) ?? null
      : null;
    if (input.createdIp && !createdIpHmac) {
      throw new Error('Session IP hashing is unavailable');
    }

    const row: ApplicantSessionPersistenceInput = {
      id: this.idGenerator(),
      applicantId: input.applicantId,
      tokenHash: hashToken(sessionToken),
      csrfSecretHash: hashToken(csrfToken),
      issuedAt: now,
      idleExpiresAt: cappedIdleExpiry(now, absoluteExpiresAt, APPLICANT_IDLE_MINUTES),
      absoluteExpiresAt,
      lastSeenAt: now,
      createdIpHmac,
    };
    this.options.repository.insertApplicantSession(row);
    return createIssuedSession(row.id, row.idleExpiresAt, sessionToken, csrfToken);
  }

  issueAdmin(input: { adminUserId: string }): IssuedSession {
    const now = nowIso(this.clock);
    const absoluteExpiresAt = addHours(now, ABSOLUTE_HOURS);
    const sessionToken = this.tokenFactory();
    const csrfToken = this.tokenFactory();
    const row: AdminSessionPersistenceInput = {
      id: this.idGenerator(),
      adminUserId: input.adminUserId,
      tokenHash: hashToken(sessionToken),
      csrfSecretHash: hashToken(csrfToken),
      issuedAt: now,
      idleExpiresAt: cappedIdleExpiry(now, absoluteExpiresAt, ADMIN_IDLE_MINUTES),
      absoluteExpiresAt,
      lastSeenAt: now,
    };
    this.options.repository.insertAdminSession(row);
    return createIssuedSession(row.id, row.idleExpiresAt, sessionToken, csrfToken);
  }

  authenticateApplicant(sessionToken: string): AuthenticatedApplicantSession | null {
    const authenticated = this.authenticateApplicantRow(sessionToken);
    return authenticated ? applicantResult(authenticated.row, authenticated.idleExpiresAt) : null;
  }

  authenticateAdmin(sessionToken: string): AuthenticatedAdminSession | null {
    const authenticated = this.authenticateAdminRow(sessionToken);
    return authenticated ? adminResult(authenticated.row, authenticated.idleExpiresAt) : null;
  }

  rotateApplicant(sessionToken: string): IssuedSession | null {
    const current = this.authenticateApplicantRow(sessionToken);
    if (!current) {
      return null;
    }

    const absoluteExpiresAt = current.row.absoluteExpiresAt;
    const newSessionToken = this.tokenFactory();
    const newCsrfToken = this.tokenFactory();
    const replacementId = this.idGenerator();
    const now = nowIso(this.clock);
    if (now >= absoluteExpiresAt) {
      return null;
    }
    const replacement: ApplicantSessionPersistenceInput = {
      id: replacementId,
      applicantId: current.row.applicantId,
      tokenHash: hashToken(newSessionToken),
      csrfSecretHash: hashToken(newCsrfToken),
      issuedAt: now,
      idleExpiresAt: cappedIdleExpiry(now, absoluteExpiresAt, APPLICANT_IDLE_MINUTES),
      absoluteExpiresAt,
      lastSeenAt: now,
      createdIpHmac: current.row.createdIpHmac,
    };

    if (!this.options.repository.replaceApplicantSession(current.row.id, now, replacement)) {
      return null;
    }
    return createIssuedSession(replacement.id, replacement.idleExpiresAt, newSessionToken, newCsrfToken);
  }

  rotateAdmin(sessionToken: string): IssuedSession | null {
    const current = this.authenticateAdminRow(sessionToken);
    if (!current) {
      return null;
    }

    const absoluteExpiresAt = current.row.absoluteExpiresAt;
    const newSessionToken = this.tokenFactory();
    const newCsrfToken = this.tokenFactory();
    const replacementId = this.idGenerator();
    const now = nowIso(this.clock);
    if (now >= absoluteExpiresAt) {
      return null;
    }
    const replacement: AdminSessionPersistenceInput = {
      id: replacementId,
      adminUserId: current.row.adminUserId,
      tokenHash: hashToken(newSessionToken),
      csrfSecretHash: hashToken(newCsrfToken),
      issuedAt: now,
      idleExpiresAt: cappedIdleExpiry(now, absoluteExpiresAt, ADMIN_IDLE_MINUTES),
      absoluteExpiresAt,
      lastSeenAt: now,
    };

    if (!this.options.repository.replaceAdminSession(current.row.id, now, replacement)) {
      return null;
    }
    return createIssuedSession(replacement.id, replacement.idleExpiresAt, newSessionToken, newCsrfToken);
  }

  revokeApplicant(sessionToken: string): boolean {
    const tokenHash = tokenHashOrNull(sessionToken);
    if (!tokenHash) {
      return false;
    }
    const row = this.options.repository.findApplicantSessionByTokenHash(tokenHash);
    return row ? this.options.repository.revokeApplicantSession(row.id, nowIso(this.clock)) : false;
  }

  revokeAdmin(sessionToken: string): boolean {
    const tokenHash = tokenHashOrNull(sessionToken);
    if (!tokenHash) {
      return false;
    }
    const row = this.options.repository.findAdminSessionByTokenHash(tokenHash);
    return row ? this.options.repository.revokeAdminSession(row.id, nowIso(this.clock)) : false;
  }

  verifyApplicantCsrf(input: CsrfCheckInput): AuthenticatedApplicantSession | null {
    const authenticated = this.authenticateApplicantRow(input.sessionToken);
    if (
      !authenticated ||
      input.csrfCookie !== input.csrfHeader ||
      !verifyToken(input.csrfCookie, authenticated.row.csrfSecretHash)
    ) {
      return null;
    }
    return applicantResult(authenticated.row, authenticated.idleExpiresAt);
  }

  verifyAdminCsrf(input: CsrfCheckInput): AuthenticatedAdminSession | null {
    const authenticated = this.authenticateAdminRow(input.sessionToken);
    if (
      !authenticated ||
      input.csrfCookie !== input.csrfHeader ||
      !verifyToken(input.csrfCookie, authenticated.row.csrfSecretHash)
    ) {
      return null;
    }
    return adminResult(authenticated.row, authenticated.idleExpiresAt);
  }

  private authenticateApplicantRow(
    sessionToken: string,
  ): { row: ApplicantSessionPersistenceRecord; idleExpiresAt: string } | null {
    const tokenHash = tokenHashOrNull(sessionToken);
    if (!tokenHash) {
      return null;
    }
    const row = this.options.repository.findApplicantSessionByTokenHash(tokenHash);
    const now = nowIso(this.clock);
    if (!row || row.revokedAt || isExpired(now, row.idleExpiresAt, row.absoluteExpiresAt)) {
      return null;
    }

    const idleExpiresAt = cappedIdleExpiry(now, row.absoluteExpiresAt, APPLICANT_IDLE_MINUTES);
    if (!this.options.repository.touchApplicantSession(row.id, now, idleExpiresAt)) {
      return null;
    }
    return { row, idleExpiresAt };
  }

  private authenticateAdminRow(
    sessionToken: string,
  ): { row: AdminSessionPersistenceRecord; idleExpiresAt: string } | null {
    const tokenHash = tokenHashOrNull(sessionToken);
    if (!tokenHash) {
      return null;
    }
    const row = this.options.repository.findAdminSessionByTokenHash(tokenHash);
    const now = nowIso(this.clock);
    if (!row || row.revokedAt || isExpired(now, row.idleExpiresAt, row.absoluteExpiresAt)) {
      return null;
    }

    const idleExpiresAt = cappedIdleExpiry(now, row.absoluteExpiresAt, ADMIN_IDLE_MINUTES);
    if (!this.options.repository.touchAdminSession(row.id, now, idleExpiresAt)) {
      return null;
    }
    return { row, idleExpiresAt };
  }
}
