import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface NewSecretToken {
  token: string;
  hash: string;
}

export type TokenComparator = (left: Uint8Array, right: Uint8Array) => boolean;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SECRET_TOKEN_LENGTH = 32;

function decodeCanonicalBase64url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function decodeSecretToken(value: string): Buffer | null {
  const decoded = decodeCanonicalBase64url(value);
  return decoded?.length === SECRET_TOKEN_LENGTH ? decoded : null;
}

function digest(value: Uint8Array): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hashToken(token: string): string {
  const rawToken = decodeSecretToken(token);
  if (!rawToken) {
    throw new Error('Invalid secret token');
  }

  return digest(rawToken).toString('base64url');
}

export function createSecretToken(): NewSecretToken {
  const token = randomBytes(SECRET_TOKEN_LENGTH).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function verifyToken(
  token: string,
  storedHash: string,
  comparator: TokenComparator = timingSafeEqual,
): boolean {
  const rawToken = decodeSecretToken(token);
  const expectedHash = decodeCanonicalBase64url(storedHash);
  if (!rawToken || !expectedHash || expectedHash.length !== SECRET_TOKEN_LENGTH) {
    return false;
  }

  const actualHash = digest(rawToken);
  if (actualHash.length !== expectedHash.length) {
    return false;
  }

  try {
    return comparator(actualHash, expectedHash);
  } catch {
    return false;
  }
}
