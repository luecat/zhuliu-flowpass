import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface ApplicantSessionRow {
  id: string;
  applicant_id: string;
  token_hash: string;
  csrf_secret_hash: string;
  issued_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  created_ip_hmac: string | null;
}

export interface ApplicantSessionRecord {
  id: string;
  applicantId: string;
  issuedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

interface AdminSessionRow {
  id: string;
  admin_user_id: string;
  token_hash: string;
  csrf_secret_hash: string;
  issued_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
  reauthenticated_at: string | null;
  revoked_at: string | null;
}

export interface ApplicantSessionPersistenceInput {
  id: string;
  applicantId: string;
  tokenHash: string;
  csrfSecretHash: string;
  issuedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
  createdIpHmac: string | null;
}

export interface AdminSessionPersistenceInput {
  id: string;
  adminUserId: string;
  tokenHash: string;
  csrfSecretHash: string;
  issuedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
}

/** Server-only session projection. It is deliberately never returned by route-facing reads. */
export interface ApplicantSessionPersistenceRecord extends ApplicantSessionPersistenceInput {
  revokedAt: string | null;
}

/** Server-only session projection. It is deliberately never returned by route-facing reads. */
export interface AdminSessionPersistenceRecord extends AdminSessionPersistenceInput {
  reauthenticatedAt: string | null;
  revokedAt: string | null;
}

export interface LoginExchangeNoncePersistenceInput {
  id: string;
  nonceHash: string;
  origin: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SessionRepository {
  insertApplicantSession(input: ApplicantSessionPersistenceInput): void;
  insertAdminSession(input: AdminSessionPersistenceInput): void;
  findApplicantSessionByTokenHash(tokenHash: string): ApplicantSessionPersistenceRecord | null;
  findAdminSessionByTokenHash(tokenHash: string): AdminSessionPersistenceRecord | null;
  touchApplicantSession(sessionId: string, now: string, idleExpiresAt: string): boolean;
  touchAdminSession(sessionId: string, now: string, idleExpiresAt: string): boolean;
  revokeApplicantSession(sessionId: string, revokedAt: string): boolean;
  revokeAdminSession(sessionId: string, revokedAt: string): boolean;
  replaceApplicantSession(
    revokedSessionId: string,
    now: string,
    replacement: ApplicantSessionPersistenceInput,
  ): boolean;
  replaceAdminSession(
    revokedSessionId: string,
    now: string,
    replacement: AdminSessionPersistenceInput,
  ): boolean;
  insertLoginExchangeNonce(input: LoginExchangeNoncePersistenceInput): void;
  consumeLoginExchangeNonce(nonceHash: string, expectedOrigin: string, consumedAt: string): boolean;
}

export interface AdminSessionRecord {
  id: string;
  adminUserId: string;
  issuedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
  reauthenticatedAt: string | null;
  revokedAt: string | null;
}

function mapApplicantSession(row: ApplicantSessionRow): ApplicantSessionRecord {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    issuedAt: row.issued_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function mapApplicantSessionPersistence(
  row: ApplicantSessionRow,
): ApplicantSessionPersistenceRecord {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    tokenHash: row.token_hash,
    csrfSecretHash: row.csrf_secret_hash,
    issuedAt: row.issued_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    createdIpHmac: row.created_ip_hmac,
    revokedAt: row.revoked_at,
  };
}

function mapAdminSession(row: AdminSessionRow): AdminSessionRecord {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    issuedAt: row.issued_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    reauthenticatedAt: row.reauthenticated_at,
    revokedAt: row.revoked_at,
  };
}

function mapAdminSessionPersistence(row: AdminSessionRow): AdminSessionPersistenceRecord {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    tokenHash: row.token_hash,
    csrfSecretHash: row.csrf_secret_hash,
    issuedAt: row.issued_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    reauthenticatedAt: row.reauthenticated_at,
    revokedAt: row.revoked_at,
  };
}

function insertApplicantSession(
  database: FlowPassDatabase,
  input: ApplicantSessionPersistenceInput,
): void {
  database
    .prepare(
      `INSERT INTO applicant_sessions (
        id, applicant_id, token_hash, csrf_secret_hash, issued_at, idle_expires_at,
        absolute_expires_at, last_seen_at, revoked_at, created_ip_hmac
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      input.id,
      input.applicantId,
      input.tokenHash,
      input.csrfSecretHash,
      input.issuedAt,
      input.idleExpiresAt,
      input.absoluteExpiresAt,
      input.lastSeenAt,
      input.createdIpHmac,
    );
}

function insertAdminSession(database: FlowPassDatabase, input: AdminSessionPersistenceInput): void {
  database
    .prepare(
      `INSERT INTO admin_sessions (
        id, admin_user_id, token_hash, csrf_secret_hash, issued_at, idle_expires_at,
        absolute_expires_at, last_seen_at, reauthenticated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      input.id,
      input.adminUserId,
      input.tokenHash,
      input.csrfSecretHash,
      input.issuedAt,
      input.idleExpiresAt,
      input.absoluteExpiresAt,
      input.lastSeenAt,
    );
}

export function createSessionRepository(database: FlowPassDatabase): SessionRepository {
  return {
    insertApplicantSession(input) {
      insertApplicantSession(database, input);
    },
    insertAdminSession(input) {
      insertAdminSession(database, input);
    },
    findApplicantSessionByTokenHash(tokenHash) {
      const row = database
        .prepare(
          `SELECT id, applicant_id, token_hash, csrf_secret_hash, issued_at, idle_expires_at,
                  absolute_expires_at, last_seen_at, revoked_at, created_ip_hmac
           FROM applicant_sessions WHERE token_hash = ?`,
        )
        .get(tokenHash) as ApplicantSessionRow | undefined;
      return row ? mapApplicantSessionPersistence(row) : null;
    },
    findAdminSessionByTokenHash(tokenHash) {
      const row = database
        .prepare(
          `SELECT id, admin_user_id, token_hash, csrf_secret_hash, issued_at, idle_expires_at,
                  absolute_expires_at, last_seen_at, reauthenticated_at, revoked_at
           FROM admin_sessions WHERE token_hash = ?`,
        )
        .get(tokenHash) as AdminSessionRow | undefined;
      return row ? mapAdminSessionPersistence(row) : null;
    },
    touchApplicantSession(sessionId, now, idleExpiresAt) {
      const result = database
        .prepare(
          `UPDATE applicant_sessions
           SET last_seen_at = ?, idle_expires_at = ?
           WHERE id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?`,
        )
        .run(now, idleExpiresAt, sessionId, now, now);
      return result.changes === 1;
    },
    touchAdminSession(sessionId, now, idleExpiresAt) {
      const result = database
        .prepare(
          `UPDATE admin_sessions
           SET last_seen_at = ?, idle_expires_at = ?
           WHERE id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?`,
        )
        .run(now, idleExpiresAt, sessionId, now, now);
      return result.changes === 1;
    },
    revokeApplicantSession(sessionId, revokedAt) {
      const result = database
        .prepare('UPDATE applicant_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, sessionId);
      return result.changes === 1;
    },
    revokeAdminSession(sessionId, revokedAt) {
      const result = database
        .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, sessionId);
      return result.changes === 1;
    },
    replaceApplicantSession(revokedSessionId, now, replacement) {
      return database.transaction(() => {
        const revoked = database
          .prepare(
            `UPDATE applicant_sessions
             SET revoked_at = ?
             WHERE id = ?
               AND revoked_at IS NULL
               AND idle_expires_at > ?
               AND absolute_expires_at > ?`,
          )
          .run(now, revokedSessionId, now, now);
        if (revoked.changes !== 1) {
          return false;
        }
        insertApplicantSession(database, replacement);
        return true;
      })();
    },
    replaceAdminSession(revokedSessionId, now, replacement) {
      return database.transaction(() => {
        const revoked = database
          .prepare(
            `UPDATE admin_sessions
             SET revoked_at = ?
             WHERE id = ?
               AND revoked_at IS NULL
               AND idle_expires_at > ?
               AND absolute_expires_at > ?`,
          )
          .run(now, revokedSessionId, now, now);
        if (revoked.changes !== 1) {
          return false;
        }
        insertAdminSession(database, replacement);
        return true;
      })();
    },
    insertLoginExchangeNonce(input) {
      database
        .prepare(
          `INSERT INTO login_exchange_nonces (
            id, nonce_hash, origin, issued_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(input.id, input.nonceHash, input.origin, input.issuedAt, input.expiresAt);
    },
    consumeLoginExchangeNonce(nonceHash, expectedOrigin, consumedAt) {
      const result = database
        .prepare(
          `UPDATE login_exchange_nonces
           SET consumed_at = ?
           WHERE nonce_hash = ? AND origin = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(consumedAt, nonceHash, expectedOrigin, consumedAt);
      return result.changes === 1;
    },
  };
}

export function getApplicantSessionForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  sessionId: string,
): ApplicantSessionRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT id, applicant_id, issued_at, idle_expires_at, absolute_expires_at, last_seen_at, revoked_at
       FROM applicant_sessions WHERE id = ? AND applicant_id = ?`,
    )
    .get(sessionId, scope.applicantId) as ApplicantSessionRow | undefined;

  return row ? mapApplicantSession(row) : null;
}

export function getAdminSessionForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  sessionId: string,
): AdminSessionRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare(
      `SELECT id, admin_user_id, issued_at, idle_expires_at, absolute_expires_at, last_seen_at,
              reauthenticated_at, revoked_at
       FROM admin_sessions WHERE id = ? AND admin_user_id = ?`,
    )
    .get(sessionId, scope.adminId) as AdminSessionRow | undefined;

  return row ? mapAdminSession(row) : null;
}
