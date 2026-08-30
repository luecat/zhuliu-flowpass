import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  apiFailure,
  type ApiFailure,
} from '../../shared/api-contract';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import {
  readEncryptedIdempotencyResponse,
  storeEncryptedIdempotencyResponse,
  updateEncryptedIdempotencyResponse,
} from '../db/repositories/idempotency';

const DAY_MILLISECONDS = 24 * 60 * 60_000;

export type MutationReservation =
  | { kind: 'reserved'; scope: string; requestHash: string; expiresAt: string }
  | { kind: 'replay'; status: number; body: string }
  | { kind: 'conflict' };

export function readApplicantMutation(input: {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  applicantId: string;
  method: string;
  normalizedRoute: string;
  idempotencyKey: string;
  requestProjection: unknown;
  now: Date;
}): Extract<MutationReservation, { kind: 'replay' }> | { kind: 'conflict' } | null {
  const scope = input.crypto.hmacLookup(`${input.applicantId}\n${input.method}\n${input.normalizedRoute}`, 'api-idempotency-scope');
  const requestHash = input.crypto.hmacLookup(JSON.stringify(input.requestProjection), 'api-idempotency-request');
  const existing = readEncryptedIdempotencyResponse(input.database, input.crypto, scope, input.idempotencyKey, input.now.toISOString());
  if (!existing) return null;
  if (existing.requestHash !== requestHash || !safeReplay(existing.response)) return { kind: 'conflict' };
  return { kind: 'replay', status: existing.responseStatus, body: existing.response };
}

export function deleteApplicantMutationReservation(input: {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  reservation: Extract<MutationReservation, { kind: 'reserved' }>;
  idempotencyKey: string;
}): void {
  input.database.prepare('DELETE FROM api_idempotency_keys WHERE scope = ? AND key = ? AND request_hash = ?').run(input.reservation.scope, input.idempotencyKey, input.reservation.requestHash);
}

function safeReplay(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route-level reservation/replay for authenticated mutations. The encrypted cache
 * contains a public response only; caller-owned cookies/CSRF values never enter it.
 */
export function reserveApplicantMutation(input: {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  applicantId: string;
  method: string;
  normalizedRoute: string;
  idempotencyKey: string;
  requestProjection: unknown;
  now: Date;
}): MutationReservation {
  const scope = input.crypto.hmacLookup(
    `${input.applicantId}\n${input.method}\n${input.normalizedRoute}`,
    'api-idempotency-scope',
  );
  const requestHash = input.crypto.hmacLookup(
    JSON.stringify(input.requestProjection),
    'api-idempotency-request',
  );
  const now = input.now.toISOString();
  const existing = readEncryptedIdempotencyResponse(
    input.database,
    input.crypto,
    scope,
    input.idempotencyKey,
    now,
  );
  if (existing) {
    if (existing.requestHash !== requestHash || !safeReplay(existing.response)) {
      return { kind: 'conflict' };
    }
    return { kind: 'replay', status: existing.responseStatus, body: existing.response };
  }

  const expiresAt = new Date(input.now.getTime() + DAY_MILLISECONDS).toISOString();
  const provisional = apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, 'idempotency-reserved');
  try {
    storeEncryptedIdempotencyResponse(input.database, input.crypto, {
      scope,
      key: input.idempotencyKey,
      requestHash,
      responseStatus: provisional.status,
      response: JSON.stringify(provisional),
      expiresAt,
      createdAt: now,
    });
    return { kind: 'reserved', scope, requestHash, expiresAt };
  } catch {
    const raced = readEncryptedIdempotencyResponse(
      input.database,
      input.crypto,
      scope,
      input.idempotencyKey,
      now,
    );
    if (raced && raced.requestHash === requestHash && safeReplay(raced.response)) {
      return { kind: 'replay', status: raced.responseStatus, body: raced.response };
    }
    return { kind: 'conflict' };
  }
}

export function finalizeApplicantMutation(input: {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  reservation: Extract<MutationReservation, { kind: 'reserved' }>;
  idempotencyKey: string;
  status: number;
  publicBody: string;
  now: Date;
}): boolean {
  return updateEncryptedIdempotencyResponse(input.database, input.crypto, {
    scope: input.reservation.scope,
    key: input.idempotencyKey,
    requestHash: input.reservation.requestHash,
    responseStatus: input.status,
    response: input.publicBody,
    expiresAt: input.reservation.expiresAt,
    now: input.now.toISOString(),
  });
}

export function isValidMutationKey(value: string | null): value is string {
  return Boolean(value && value.trim().length > 0 && value.length <= 256);
}

/** Nonsecret deterministic route fingerprint utility for later mutation handlers. */
export function normalizedRouteFingerprint(method: string, route: string): string {
  return createHash('sha256').update(`${method}\n${route}`, 'utf8').digest('base64url');
}

export function mutationFailure(code: ApiErrorCode, requestId: string): ApiFailure {
  return apiFailure(code, requestId);
}
