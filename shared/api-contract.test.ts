import { describe, expect, it } from 'vitest';
import {
  ApiErrorCode,
  LineExchangeRequestSchema,
  apiFailure,
  apiSuccess,
  parseQuotedEtag,
  quotedEtag,
} from './api-contract';

describe('public API contract', () => {
  it('emits only the documented success and failure envelopes', () => {
    expect(apiSuccess({ id: 'case-public-id' }, 'request-1', '12')).toEqual({
      data: { id: 'case-public-id' },
      meta: { requestId: 'request-1', etag: '"12"' },
    });
    expect(apiFailure(ApiErrorCode.NOT_FOUND, 'request-2')).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found', requestId: 'request-2' },
    });
  });

  it('maps Task 5 errors to their public HTTP status without sensitive details', () => {
    expect(apiFailure(ApiErrorCode.LINE_TOKEN_INVALID, 'request-1').status).toBe(401);
    expect(apiFailure(ApiErrorCode.CSRF_FAILED, 'request-1').status).toBe(403);
    expect(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, 'request-1').status).toBe(409);
    expect(apiFailure(ApiErrorCode.RATE_LIMITED, 'request-1', { retryAfter: 7 })).toMatchObject({
      status: 429,
      headers: { 'Retry-After': '7' },
    });
    expect(JSON.stringify(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, 'request-1'))).not.toMatch(
      /token|nonce|cookie|subject|ciphertext|keyId/i,
    );
  });

  it('rejects untrusted exchange properties before an adapter can receive them', () => {
    expect(LineExchangeRequestSchema.safeParse({ idToken: 'id-token', nonce: 'nonce' }).success).toBe(true);
    expect(
      LineExchangeRequestSchema.safeParse({
        idToken: 'id-token',
        nonce: 'nonce',
        subject: 'client-controlled-subject',
      }).success,
    ).toBe(false);
  });

  it('round-trips only quoted non-negative decimal ETags', () => {
    expect(quotedEtag(12)).toBe('"12"');
    expect(parseQuotedEtag('"12"')).toBe(12);
    for (const invalid of ['12', '"-1"', '"01"', '"1.0"', '"12" trailing']) {
      expect(parseQuotedEtag(invalid)).toBeNull();
    }
  });
});
