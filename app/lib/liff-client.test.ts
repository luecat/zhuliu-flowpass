import { describe, expect, it, vi } from 'vitest';
import {
  LiffBrowserError,
  bootLineLiffSession,
  createLiffPublicConfig,
  type LiffBrowserSdk,
} from './liff-client';

function createLiffSdk(overrides: Partial<LiffBrowserSdk> = {}): LiffBrowserSdk {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    isLoggedIn: vi.fn().mockReturnValue(true),
    login: vi.fn(),
    getIDToken: vi.fn().mockReturnValue('short-lived-id-token'),
    ...overrides,
  };
}

describe('bootLineLiffSession', () => {
  it('initializes LIFF before requesting a short-lived bootstrap nonce and exchanges only the ID token', async () => {
    const events: string[] = [];
    const liff = createLiffSdk({
      init: vi.fn().mockImplementation(async () => {
        events.push('init');
      }),
      isLoggedIn: vi.fn().mockImplementation(() => {
        events.push('isLoggedIn');
        return true;
      }),
      getIDToken: vi.fn().mockImplementation(() => {
        events.push('getIDToken');
        return 'short-lived-id-token';
      }),
    });
    const api = {
      bootstrapLineLogin: vi.fn().mockImplementation(async () => {
        events.push('bootstrap');
        return { nonce: 'browser-only-nonce' };
      }),
      exchangeLineIdToken: vi.fn().mockImplementation(async (input) => {
        events.push('exchange');
        expect(input).toEqual({ idToken: 'short-lived-id-token', nonce: 'browser-only-nonce' });
        return { expiresAt: '2026-08-30T01:00:00.000Z' };
      }),
    };

    await expect(
      bootLineLiffSession({ liff, api, config: createLiffPublicConfig('public-liff-id') }),
    ).resolves.toEqual({ kind: 'authenticated', expiresAt: '2026-08-30T01:00:00.000Z' });
    expect(events).toEqual(['init', 'isLoggedIn', 'getIDToken', 'bootstrap', 'exchange']);
    expect(liff.init).toHaveBeenCalledWith({ liffId: 'public-liff-id' });
  });

  it('hands off to LIFF login without inventing a browser identity', async () => {
    const liff = createLiffSdk({ isLoggedIn: vi.fn().mockReturnValue(false) });
    const api = {
      bootstrapLineLogin: vi.fn().mockResolvedValue({ nonce: 'browser-only-nonce' }),
      exchangeLineIdToken: vi.fn(),
    };

    await expect(
      bootLineLiffSession({ liff, api, config: createLiffPublicConfig('public-liff-id') }),
    ).resolves.toEqual({ kind: 'redirecting_to_line_login' });
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(api.exchangeLineIdToken).not.toHaveBeenCalled();
  });

  it('fails closed when LIFF does not return an ID token and never sends a profile or local subject', async () => {
    const liff = createLiffSdk({ getIDToken: vi.fn().mockReturnValue(null) });
    const api = {
      bootstrapLineLogin: vi.fn().mockResolvedValue({ nonce: 'browser-only-nonce' }),
      exchangeLineIdToken: vi.fn(),
    };

    await expect(
      bootLineLiffSession({ liff, api, config: createLiffPublicConfig('public-liff-id') }),
    ).rejects.toMatchObject({ code: 'LIFF_ID_TOKEN_UNAVAILABLE' } satisfies Partial<LiffBrowserError>);
    expect(api.exchangeLineIdToken).not.toHaveBeenCalled();
  });

  it('accepts only a nonblank public LIFF ID supplied by trusted runtime config', () => {
    expect(createLiffPublicConfig('  public-liff-id  ')).toEqual({ liffId: 'public-liff-id' });
    expect(() => createLiffPublicConfig('   ')).toThrow(LiffBrowserError);
  });

  it('revalidates a supplied config before it can reach liff.init', async () => {
    const liff = createLiffSdk();
    const api = {
      bootstrapLineLogin: vi.fn(),
      exchangeLineIdToken: vi.fn(),
    };

    await expect(
      bootLineLiffSession({ liff, api, config: { liffId: '   ' } }),
    ).rejects.toMatchObject({ code: 'INVALID_LIFF_CONFIG' } satisfies Partial<LiffBrowserError>);
    expect(api.bootstrapLineLogin).not.toHaveBeenCalled();
    expect(liff.init).not.toHaveBeenCalled();
  });
});
