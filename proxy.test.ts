import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

describe('public security-header proxy', () => {
  it('adds response hardening headers without making an authorization decision', () => {
    const response = proxy(new NextRequest('https://flowpass.luecat.com/app/cases'));

    // LIFF vendor/embedding origins are not configured yet, so a guessed CSP
    // must not accidentally break the authenticated container.
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('location')).toBeNull();
  });
});
