import { afterEach, describe, expect, it } from 'vitest';
import { createAdminApp } from './app';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { bootstrapAdminAccount } from './auth/admin-account';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe('createAdminApp', () => {
  it('exposes local dependency health', async () => {
    const response = await createAdminApp().request('http://127.0.0.1/healthz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      dependencies: { database: 'pending', keychain: 'pending' },
    });
  });

  it('rejects a login origin outside the exact admin loopback origin', async () => {
    const response = await createAdminApp({} as never).request('http://127.0.0.1:38101/admin/v1/sessions', { method: 'POST', headers: { origin: 'https://flowpass.luecat.com', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('authenticates the one-time bootstrap password and reports forced change', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database).request('http://127.0.0.1:38101/admin/v1/sessions', {
      method: 'POST',
      headers: { host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'admin', password: 'admin' }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { mustChangePassword: true } });
  });

  it('uses the fixed admin identity when browser autofill clears the account field', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database).request('http://127.0.0.1:38101/admin/v1/sessions', {
      method: 'POST',
      headers: { host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin' }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { mustChangePassword: true } });
  });

  it('rejects a wrong password with the generic response', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database).request('http://127.0.0.1:38101/admin/v1/sessions', {
      method: 'POST',
      headers: { host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'admin', password: 'not-it' }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: 'UNAUTHENTICATED', message: '帳號或密碼錯誤。' } });
  });

  it('accepts the exact remote host only after a valid Access assertion', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database, {
      verifyAccessToken: async () => ({ email: 'daniel0104.sung@gmail.com', issuedAt: Math.floor(Date.now() / 1000) }),
    }).request('https://admin.luecat.com/admin/v1/sessions', {
      method: 'POST',
      headers: { host: 'admin.luecat.com', origin: 'https://admin.luecat.com', 'cf-access-jwt-assertion': 'signed-access-token', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'admin', password: 'admin' }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('requires a freshly issued Access identity for password recovery', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database, {
      verifyAccessToken: async () => ({ email: 'daniel0104.sung@gmail.com', issuedAt: Math.floor(Date.now() / 1000) - 601 }),
    }).request('https://admin.luecat.com/admin/v1/password-recovery/start', {
      method: 'POST',
      headers: { host: 'admin.luecat.com', origin: 'https://admin.luecat.com', 'cf-access-jwt-assertion': 'stale-access-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACCESS_REQUIRED' } });
  });

  it('applies the Access boundary to mounted admin routes too', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const response = await createAdminApp(database).request('https://admin.luecat.com/admin/v1/tools', { headers: { host: 'admin.luecat.com' } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACCESS_REQUIRED' } });
  });

  it('changes the bootstrap password only with the session CSRF token', async () => {
    const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
    const app = createAdminApp(database);
    const login = await app.request('http://127.0.0.1:38101/admin/v1/sessions', {
      method: 'POST',
      headers: { host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'admin', password: 'admin' }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    const session = setCookie.match(/flowpass_admin_session=([^;,]+)/)?.[1];
    const csrf = setCookie.match(/flowpass_admin_csrf=([^;,]+)/)?.[1];
    expect(session).toBeTruthy(); expect(csrf).toBeTruthy();
    const changed = await app.request('http://127.0.0.1:38101/admin/v1/password/change', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json',
        cookie: `flowpass_admin_session=${session}; flowpass_admin_csrf=${csrf}`,
        'x-csrf-token': decodeURIComponent(csrf!),
      },
      body: JSON.stringify({ currentPassword: 'admin', newPassword: 'Flow!Pass9' }),
    });
    expect(changed.status).toBe(200);
    const oldLogin = await app.request('http://127.0.0.1:38101/admin/v1/sessions', {
      method: 'POST', headers: { host: '127.0.0.1:38101', origin: 'http://127.0.0.1:38101', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'admin', password: 'admin' }),
    });
    expect(oldLogin.status).toBe(401);
    // Six scrypt derivations at the production N=131072 cost overrun the 5s default.
  }, 60_000);
});
