import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { CloudflareAccessIdentity } from '../app';

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  email?: unknown;
  iat?: unknown;
  nbf?: unknown;
  exp?: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export function createCloudflareAccessVerifier(input: {
  teamDomain: string;
  audience: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): (token: string) => Promise<CloudflareAccessIdentity | null> {
  const teamDomain = input.teamDomain.replace(/^https?:\/\//u, '').replace(/\/$/u, '').toLowerCase();
  const issuer = `https://${teamDomain}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  let cached: { expiresAt: number; keys: Map<string, Jwk> } | null = null;

  async function keys(): Promise<Map<string, Jwk>> {
    if (cached && cached.expiresAt > now()) return cached.keys;
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('Cloudflare Access JWKS unavailable');
    const body = await response.json() as { keys?: Jwk[] };
    const map = new Map((body.keys ?? []).filter((key) => key.kid).map((key) => [key.kid!, key]));
    if (!map.size) throw new Error('Cloudflare Access JWKS empty');
    cached = { keys: map, expiresAt: now() + 5 * 60_000 };
    return map;
  }

  return async (token: string) => {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown; kid?: unknown };
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as AccessClaims;
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
      const jwk = (await keys()).get(header.kid);
      if (!jwk || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) return null;
      const signatureOk = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
      if (!signatureOk) return null;
      const current = Math.floor(now() / 1000);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer || !audiences.includes(input.audience) || typeof claims.email !== 'string' || typeof claims.exp !== 'number' || claims.exp <= current) return null;
      if (typeof claims.nbf === 'number' && claims.nbf > current + 30) return null;
      if (typeof claims.iat !== 'number' || claims.iat > current + 30) return null;
      return { email: claims.email, issuedAt: claims.iat };
    } catch {
      return null;
    }
  };
}
