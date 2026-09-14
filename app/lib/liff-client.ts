'use client';

import type { ApplicantSessionSummary, LineExchangeInput } from './public-api';

/** The small subset of the LIFF SDK that FlowPass needs in the browser. */
export interface LiffBrowserSdk {
  init(input: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(): void;
  logout(): void;
  getIDToken(): string | null;
}

export interface LiffPublicConfig {
  liffId: string;
}

export interface LiffSessionApi {
  bootstrapLineLogin(): Promise<{ nonce: string }>;
  exchangeLineIdToken(input: LineExchangeInput): Promise<ApplicantSessionSummary>;
}

export type LiffBootResult =
  | { kind: 'redirecting_to_line_login' }
  | { kind: 'authenticated'; expiresAt: string };

export class LiffBrowserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LiffBrowserError';
    this.code = code;
  }
}

/**
 * This accepts only build/runtime supplied public configuration. The LIFF ID is
 * public, but query parameters and arbitrary caller values are not accepted.
 */
export function createLiffPublicConfig(liffId: unknown): LiffPublicConfig {
  if (typeof liffId !== 'string') {
    throw new LiffBrowserError('INVALID_LIFF_CONFIG', 'The LIFF configuration is unavailable');
  }
  const normalized = liffId.trim();
  if (!normalized || normalized.length > 256 || /\s/.test(normalized)) {
    throw new LiffBrowserError('INVALID_LIFF_CONFIG', 'The LIFF configuration is unavailable');
  }
  return { liffId: normalized };
}

/**
 * Dynamically loading LIFF keeps this module browser-only while making the
 * boot flow independently testable with an injected SDK.
 */
export async function loadLiffBrowserSdk(): Promise<LiffBrowserSdk> {
  const { liff } = await import('@line/liff');
  return liff;
}

function isRejectedLineToken(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'LINE_TOKEN_INVALID');
}

/**
 * Starts the only permitted browser identity flow:
 * LIFF init/login -> ID token -> bootstrap nonce -> exchange -> forget secrets.
 * No profile, user ID, subject, bearer token, or browser storage is used.
 */
export async function bootLineLiffSession(input: {
  liff: LiffBrowserSdk;
  api: LiffSessionApi;
  config: LiffPublicConfig;
  /**
   * Set only for an explicit applicant retry: LIFF keeps a cached ID token after it
   * expires, so a rejected token must be cleared before LINE can issue a new one.
   * Never set on page load, which would loop if LINE kept returning a bad token.
   */
  forceLogin?: boolean;
}): Promise<LiffBootResult> {
  const config = createLiffPublicConfig(input.config.liffId);
  let nonce: string | undefined;
  let idToken: string | undefined;
  try {
    await input.liff.init({ liffId: config.liffId });
    if (!input.liff.isLoggedIn()) {
      input.liff.login();
      return { kind: 'redirecting_to_line_login' };
    }

    const receivedToken = input.liff.getIDToken();
    idToken = requireNonBlank(receivedToken, 'LIFF_ID_TOKEN_UNAVAILABLE');
    // Do not spend a rate-limited bootstrap nonce before LIFF has an ID token.
    const bootstrap = await input.api.bootstrapLineLogin();
    nonce = requireNonBlank(bootstrap.nonce, 'LOGIN_NONCE_UNAVAILABLE');
    const session = await input.api.exchangeLineIdToken({ idToken, nonce });
    return { kind: 'authenticated', expiresAt: session.expiresAt };
  } catch (error) {
    if (error instanceof LiffBrowserError) throw error;
    if (isRejectedLineToken(error)) {
      if (input.forceLogin) {
        input.liff.logout();
        input.liff.login();
        return { kind: 'redirecting_to_line_login' };
      }
      throw new LiffBrowserError('LINE_LOGIN_EXPIRED', 'The LINE sign-in has expired');
    }
    // Do not surface SDK/provider exception text: it could contain credentials.
    throw new LiffBrowserError('LIFF_SESSION_FAILED', 'Unable to sign in with LINE');
  } finally {
    // The raw nonce and ID token are deliberately never persisted in React,
    // storage, URL parameters, or a client instance.
    nonce = undefined;
    idToken = undefined;
  }
}

function requireNonBlank(value: string | null | undefined, code: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LiffBrowserError(code, 'The LINE sign-in token is unavailable');
  }
  // OIDC token bytes are opaque input to the verifier. Whitespace determines
  // whether the value is blank, but a nonblank token is never normalized.
  return value;
}
