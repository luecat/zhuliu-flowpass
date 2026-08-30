import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as bootstrap } from './bootstrap/route';
import { POST as exchange } from './route';
import { DELETE as logout } from '../current/route';
import { FieldCrypto, type Keyring } from '../../../../../server/crypto/field-crypto';
import { openDatabase } from '../../../../../server/db/connection';
import { migrateDatabase } from '../../../../../server/db/migrate';
import { createSessionRepository } from '../../../../../server/db/repositories/sessions';
import { createLineSessionService } from '../../../../../server/domain/line-session-service';
import { SessionService } from '../../../../../server/domain/session-service';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../server/public/runtime';

const ORIGIN = 'http://127.0.0.1:38100';
const NOW = '2026-08-30T00:00:00.000Z';

function createIds(): () => string {
  let sequence = 1;
  return () => `0198f052-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

function createTokens(): () => string {
  let sequence = 1;
  return () => Buffer.alloc(32, sequence++).toString('base64url');
}

function crypto(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey: (id) => (id === 'test-v1' ? Buffer.alloc(32, 0x41) : undefined),
  };
  return new FieldCrypto(keyring);
}

describe('public LINE session routes', () => {
  let directory: string;
  let database: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-line-route-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    const fieldCrypto = crypto();
    const ids = createIds();
    const lineSessions = createLineSessionService({
      database,
      crypto: fieldCrypto,
      sessionService: new SessionService({
        repository: createSessionRepository(database),
        clock: () => new Date(NOW),
        idGenerator: ids,
        tokenFactory: createTokens(),
        ipHasher: (value) => fieldCrypto.hmacLookup(value, 'session-ip'),
      }),
      lineLoginClient: {
        verifyIdToken: async () => ({
          subject: 'route-subject-sentinel',
          audience: 'channel',
          issuer: 'https://access.line.me',
          expiresAt: '2026-08-30T00:01:00.000Z',
        }),
      },
      publicOrigin: ORIGIN,
      allowInsecureLoopbackTest: true,
      clock: () => new Date(NOW),
      idGenerator: ids,
      tokenFactory: createTokens(),
      clientIpResolver: () => '198.51.100.11',
      requestIdGenerator: () => 'request-route',
    });
    configurePublicRuntime({
      database,
      crypto: fieldCrypto,
      lineSessions,
      publicOrigin: ORIGIN,
      requestIdGenerator: () => 'request-route',
      clock: () => new Date(NOW),
    });
  });

  afterEach(() => {
    clearPublicRuntime();
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('boots, exchanges, then logs out using route guards without exposing credentials in JSON', async () => {
    const bootstrapResponse = await bootstrap(new Request(`${ORIGIN}/api/v1/sessions/line/bootstrap`, {
      method: 'POST', headers: { origin: ORIGIN },
    }));
    expect(bootstrapResponse.status).toBe(201);
    const bootstrapBody = await bootstrapResponse.json() as { data: { nonce: string } };
    const bootstrapCookie = bootstrapResponse.headers.get('set-cookie') ?? '';
    expect(bootstrapCookie).toContain('HttpOnly');

    const exchangeResponse = await exchange(new Request(`${ORIGIN}/api/v1/sessions/line`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `flowpass_login_bootstrap=${bootstrapBody.data.nonce}`,
        'idempotency-key': 'login-route-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idToken: 'route-id-token-sentinel', nonce: bootstrapBody.data.nonce }),
    }));
    expect(exchangeResponse.status).toBe(201);
    const exchangeBody = await exchangeResponse.json();
    const sessionCookies = exchangeResponse.headers.get('set-cookie') ?? '';
    expect(JSON.stringify(exchangeBody)).not.toMatch(/token|subject|nonce|csrf/i);
    expect(sessionCookies).toContain('flowpass_session=');
    expect(sessionCookies).toContain('flowpass_csrf=');

    const session = /flowpass_session=([^;]+)/.exec(sessionCookies)?.[1];
    const csrf = /flowpass_csrf=([^;]+)/.exec(sessionCookies)?.[1];
    const logoutResponse = await logout(new Request(`${ORIGIN}/api/v1/sessions/current`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        cookie: `flowpass_session=${session}; flowpass_csrf=${csrf}`,
        'x-flowpass-csrf': csrf ?? '',
        'idempotency-key': 'logout-route-key',
      },
    }));
    expect(logoutResponse.status).toBe(204);
    expect(logoutResponse.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects untrusted exchange JSON before consuming its bootstrap nonce', async () => {
    const bootstrapResponse = await bootstrap(new Request(`${ORIGIN}/api/v1/sessions/line/bootstrap`, {
      method: 'POST', headers: { origin: ORIGIN },
    }));
    const { data } = await bootstrapResponse.json() as { data: { nonce: string } };
    const response = await exchange(new Request(`${ORIGIN}/api/v1/sessions/line`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `flowpass_login_bootstrap=${data.nonce}`,
        'idempotency-key': 'bad-request-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idToken: 'route-id-token-sentinel', nonce: data.nonce, applicantId: 'attacker' }),
    }));

    expect(response.status).toBe(400);
    expect(database.prepare('SELECT consumed_at FROM login_exchange_nonces').get()).toEqual({ consumed_at: null });
  });

  it('requires an idempotency key before consuming a bootstrap nonce', async () => {
    const bootstrapResponse = await bootstrap(new Request(`${ORIGIN}/api/v1/sessions/line/bootstrap`, {
      method: 'POST', headers: { origin: ORIGIN },
    }));
    const { data } = await bootstrapResponse.json() as { data: { nonce: string } };

    const response = await exchange(new Request(`${ORIGIN}/api/v1/sessions/line`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `flowpass_login_bootstrap=${data.nonce}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idToken: 'route-id-token-sentinel', nonce: data.nonce }),
    }));

    expect(response.status).toBe(400);
    expect(database.prepare('SELECT consumed_at FROM login_exchange_nonces').get()).toEqual({ consumed_at: null });
  });

  it('requires matching applicant CSRF cookies and an idempotency key before logout state changes', async () => {
    const bootstrapResponse = await bootstrap(new Request(`${ORIGIN}/api/v1/sessions/line/bootstrap`, {
      method: 'POST', headers: { origin: ORIGIN },
    }));
    const { data } = await bootstrapResponse.json() as { data: { nonce: string } };
    const exchangeResponse = await exchange(new Request(`${ORIGIN}/api/v1/sessions/line`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `flowpass_login_bootstrap=${data.nonce}`,
        'idempotency-key': 'logout-guard-login',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idToken: 'route-id-token-sentinel', nonce: data.nonce }),
    }));
    const cookies = exchangeResponse.headers.get('set-cookie') ?? '';
    const session = /flowpass_session=([^;]+)/.exec(cookies)?.[1];
    const csrf = /flowpass_csrf=([^;]+)/.exec(cookies)?.[1];
    const cookie = `flowpass_session=${session}; flowpass_csrf=${csrf}`;

    const rejected = await logout(new Request(`${ORIGIN}/api/v1/sessions/current`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, cookie, 'idempotency-key': 'logout-guard-key' },
    }));
    expect(rejected.status).toBe(403);
    expect(database.prepare('SELECT revoked_at FROM applicant_sessions').get()).toEqual({ revoked_at: null });

    const first = await logout(new Request(`${ORIGIN}/api/v1/sessions/current`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        cookie,
        'x-flowpass-csrf': csrf ?? '',
        'idempotency-key': 'logout-guard-key',
      },
    }));
    const replay = await logout(new Request(`${ORIGIN}/api/v1/sessions/current`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        cookie,
        'x-flowpass-csrf': csrf ?? '',
        'idempotency-key': 'logout-guard-key',
      },
    }));
    expect(first.status).toBe(204);
    // Replays are recognized after the session is revoked because idempotency is
    // checked only after the original session/CSRF guard has proven its actor.
    // A browser that has already lost its cookie cannot revive that session.
    expect(replay.status).toBe(403);
    expect(database.prepare('SELECT COUNT(*) AS count FROM api_idempotency_keys').get()).toEqual({ count: 2 });
  });
});
