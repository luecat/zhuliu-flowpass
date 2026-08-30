import { describe, expect, it } from 'vitest';
import {
  LineLoginVerificationError,
  createLineLoginClient,
  type LineVerificationTransport,
} from './line-login-client';

const NOW = new Date('2026-08-30T00:00:00.000Z');

function verifiedResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    redirected: false,
    json: async () => ({
      iss: 'https://access.line.me',
      aud: 'flowpass-channel',
      exp: Math.floor(NOW.getTime() / 1000) + 60,
      sub: 'verified-line-subject',
      ...overrides,
    }),
  };
}

describe('LINE ID token verifier', () => {
  it('posts exactly the token and configured client id to the fixed LINE verifier', async () => {
    let request: Request | undefined;
    const transport: LineVerificationTransport = async (input) => {
      request = input;
      return verifiedResponse();
    };
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      transport,
      clock: () => NOW,
    });

    const identity = await client.verifyIdToken('id-token-sentinel');

    expect(request?.url).toBe('https://api.line.me/oauth2/v2.1/verify');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(await request?.text()).toBe('id_token=id-token-sentinel&client_id=flowpass-channel');
    expect(identity).toEqual({
      subject: 'verified-line-subject',
      audience: 'flowpass-channel',
      issuer: 'https://access.line.me',
      expiresAt: '2026-08-30T00:01:00.000Z',
    });
  });

  it.each([
    ['wrong audience', { aud: 'different-channel' }],
    ['wrong issuer', { iss: 'https://other.example' }],
    ['expired token', { exp: Math.floor(NOW.getTime() / 1000) }],
    ['non-numeric expiry', { exp: 'tomorrow' }],
    ['missing subject', { sub: '   ' }],
  ])('fails closed for %s', async (_label, body) => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      transport: async () => verifiedResponse(body),
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).rejects.toMatchObject({
      code: LineLoginVerificationError.INVALID_TOKEN,
    });
  });

  it('uses trim only to reject blank subjects and preserves the verified subject bytes for the server identity boundary', async () => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      transport: async () => verifiedResponse({ sub: ' verified subject with spaces ' }),
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).resolves.toMatchObject({
      subject: ' verified subject with spaces ',
    });
  });

  it('aborts an injected verification transport at its finite timeout without exposing token material', async () => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      timeoutMilliseconds: 1,
      transport: async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('id-token-sentinel aborted')));
        }),
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).rejects.toMatchObject({
      code: LineLoginVerificationError.DEPENDENCY_UNAVAILABLE,
      message: 'LINE verification is unavailable',
    });
  });

  it('enforces the timeout even when an injected transport ignores AbortSignal', async () => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      timeoutMilliseconds: 1,
      transport: async () => new Promise(() => undefined),
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).rejects.toMatchObject({
      code: LineLoginVerificationError.DEPENDENCY_UNAVAILABLE,
      message: 'LINE verification is unavailable',
    });
  });

  it.each([
    ['provider 4xx', { status: 400, redirected: false, json: async () => ({ error: 'id-token-sentinel' }) }],
    ['malformed provider JSON', { status: 200, redirected: false, json: async () => { throw new Error('id-token-sentinel'); } }],
  ])('maps %s to a redacted invalid-token result', async (_label, response) => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      transport: async () => response,
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).rejects.toMatchObject({
      code: LineLoginVerificationError.INVALID_TOKEN,
      message: 'LINE identity token is invalid',
    });
  });

  it('maps network and server failures to a redacted dependency error', async () => {
    const client = createLineLoginClient({
      channelId: 'flowpass-channel',
      transport: async () => {
        throw new Error('id-token-sentinel upstream-subject should never escape');
      },
      clock: () => NOW,
    });

    await expect(client.verifyIdToken('id-token-sentinel')).rejects.toMatchObject({
      code: LineLoginVerificationError.DEPENDENCY_UNAVAILABLE,
      message: 'LINE verification is unavailable',
    });
  });
});
