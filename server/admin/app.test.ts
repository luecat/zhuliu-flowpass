import { describe, expect, it } from 'vitest';
import { createAdminApp } from './app';

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
});
