import { createHash } from 'node:crypto';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../connection';
import { decryptDatabaseText, encryptDatabaseText } from './encrypted-fields';

export function idempotencyRecordId(scope: string, key: string): string {
  // AAD needs a stable identifier but the composite primary key is not a UUID. Hash it
  // so the encryption context never stores the caller's idempotency key verbatim. The
  // fixed alphabetic prefix keeps the AAD record-id segment valid for every base64url digest.
  return `idem_${createHash('sha256')
    .update(scope, 'utf8')
    .update('\0')
    .update(key, 'utf8')
    .digest('base64url')}`;
}

export function storeEncryptedIdempotencyResponse(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    response: string;
    expiresAt: string;
    createdAt: string;
  },
): void {
  const recordId = idempotencyRecordId(input.scope, input.key);
  const responseEnc = encryptDatabaseText(
    crypto,
    'api_idempotency_keys',
    'response_enc',
    recordId,
    input.response,
  );

  database.transaction(() => {
    // A stale composite key must not permanently block a fresh request. Live replay
    // and request-hash conflict behavior remain owned by the Task 5 route/service.
    database
      .prepare('DELETE FROM api_idempotency_keys WHERE scope = ? AND key = ? AND expires_at <= ?')
      .run(input.scope, input.key, input.createdAt);
    database
      .prepare(
        `INSERT INTO api_idempotency_keys (
          scope, key, request_hash, response_status, response_enc, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope,
        input.key,
        input.requestHash,
        input.responseStatus,
        responseEnc,
        input.expiresAt,
        input.createdAt,
      );
  })();
}

/** Server-only replay helper. Route middleware must first prove the same actor scope. */
export function readEncryptedIdempotencyResponse(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  scope: string,
  key: string,
  now: string,
): { requestHash: string; responseStatus: number; response: string; expiresAt: string } | null {
  const row = database
    .prepare(
      `SELECT request_hash, response_status, response_enc, expires_at
       FROM api_idempotency_keys WHERE scope = ? AND key = ? AND expires_at > ?`,
    )
    .get(scope, key, now) as
    | {
        request_hash: string;
        response_status: number;
        response_enc: string;
        expires_at: string;
      }
    | undefined;
  if (!row) {
    return null;
  }

  return {
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    response: decryptDatabaseText(
      crypto,
      'api_idempotency_keys',
      'response_enc',
      idempotencyRecordId(scope, key),
      row.response_enc,
    ),
    expiresAt: row.expires_at,
  };
}

/**
 * Finalizes a pre-reserved public response without changing its request fingerprint.
 * The caller owns the reservation and must keep cookies/secrets out of `response`.
 */
export function updateEncryptedIdempotencyResponse(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    response: string;
    expiresAt: string;
    now: string;
  },
): boolean {
  const responseEnc = encryptDatabaseText(
    crypto,
    'api_idempotency_keys',
    'response_enc',
    idempotencyRecordId(input.scope, input.key),
    input.response,
  );
  const result = database
    .prepare(
      `UPDATE api_idempotency_keys
       SET response_status = ?, response_enc = ?, expires_at = ?
       WHERE scope = ? AND key = ? AND request_hash = ? AND expires_at > ?`,
    )
    .run(
      input.responseStatus,
      responseEnc,
      input.expiresAt,
      input.scope,
      input.key,
      input.requestHash,
      input.now,
    );
  return result.changes === 1;
}

/** Expiry cleanup intentionally reports a count only and never returns decrypted responses. */
export function deleteExpiredIdempotencyResponses(database: FlowPassDatabase, now: string): number {
  return database.prepare('DELETE FROM api_idempotency_keys WHERE expires_at <= ?').run(now).changes;
}
