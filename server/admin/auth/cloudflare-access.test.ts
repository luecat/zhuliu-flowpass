import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCloudflareAccessVerifier } from './cloudflare-access';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(payload: Record<string, unknown>) {
  const protectedHeader = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = encode(payload);
  const input = `${protectedHeader}.${body}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const fetchKeys = async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));

describe('Cloudflare Access verifier', () => {
  it('accepts only a signed token with the configured issuer and audience', async () => {
    const now = 1_788_192_000;
    const verify = createCloudflareAccessVerifier({ teamDomain: 'team.cloudflareaccess.com', audience: 'admin-aud', fetchImpl: fetchKeys, now: () => now * 1000 });
    const valid = token({ iss: 'https://team.cloudflareaccess.com', aud: ['admin-aud'], email: 'daniel0104.sung@gmail.com', iat: now - 30, nbf: now - 30, exp: now + 300 });
    await expect(verify(valid)).resolves.toEqual({ email: 'daniel0104.sung@gmail.com', issuedAt: now - 30 });
    const wrongAudience = token({ iss: 'https://team.cloudflareaccess.com', aud: ['wrong'], email: 'daniel0104.sung@gmail.com', iat: now - 30, exp: now + 300 });
    await expect(verify(wrongAudience)).resolves.toBeNull();
  });

  it('rejects tampering and expired assertions', async () => {
    const now = 1_788_192_000;
    const verify = createCloudflareAccessVerifier({ teamDomain: 'team.cloudflareaccess.com', audience: 'admin-aud', fetchImpl: fetchKeys, now: () => now * 1000 });
    const expired = token({ iss: 'https://team.cloudflareaccess.com', aud: 'admin-aud', email: 'daniel0104.sung@gmail.com', iat: now - 600, exp: now - 1 });
    await expect(verify(expired)).resolves.toBeNull();
    await expect(verify(expired.slice(0, -2) + 'aa')).resolves.toBeNull();
  });
});
