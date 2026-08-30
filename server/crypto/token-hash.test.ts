import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createSecretToken, hashToken, verifyToken } from './token-hash';

describe('secret-token hashing', () => {
  it('creates unique canonical 32-byte delivery secrets with SHA-256 persistence hashes', () => {
    const first = createSecretToken();
    const second = createSecretToken();

    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32);
    expect(Buffer.from(first.hash, 'base64url')).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).toBe(hashToken(first.token));
  });

  it('verifies only the original secret and rejects malformed or wrong-length digests', () => {
    const expected = createSecretToken();
    const wrong = createSecretToken();

    expect(verifyToken(expected.token, expected.hash)).toBe(true);
    expect(verifyToken(wrong.token, expected.hash)).toBe(false);
    expect(verifyToken(expected.token, '!not-base64url')).toBe(false);
    expect(verifyToken(expected.token, Buffer.alloc(31).toString('base64url'))).toBe(false);
    expect(verifyToken('not-a-token', expected.hash)).toBe(false);
  });

  it('calls the constant-time comparator only after both canonical digests have the same length', () => {
    const expected = createSecretToken();
    let calls = 0;
    const comparator = (left: Uint8Array, right: Uint8Array) => {
      calls += 1;
      return Buffer.from(left).equals(Buffer.from(right));
    };

    expect(verifyToken(expected.token, expected.hash, comparator)).toBe(true);
    expect(calls).toBe(1);
    expect(verifyToken(expected.token, 'short', comparator)).toBe(false);
    expect(calls).toBe(1);
  });

  it('keeps the raw delivery secret out of serialized persistence input', () => {
    const issued = createSecretToken();
    const storedRow = JSON.stringify({ token_hash: issued.hash });

    expect(storedRow).toContain(issued.hash);
    expect(storedRow).not.toContain(issued.token);
  });
});
