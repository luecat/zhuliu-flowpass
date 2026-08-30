'use client';

/**
 * Browser-safe fetch signature.  This module intentionally has no server,
 * cookie-secret, crypto, or LINE-subject imports.
 */
export type BrowserFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface PublicApiMeta {
  requestId: string;
  etag?: string;
}

interface PublicApiSuccess<T> {
  data: T;
  meta: PublicApiMeta;
}

interface PublicApiFailure {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface LineExchangeInput {
  idToken: string;
  nonce: string;
}

export interface ApplicantSessionSummary {
  expiresAt: string;
}

export type PublicMutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PublicMutationInput {
  method: PublicMutationMethod;
  body?: unknown;
  /** A resource ETag obtained from a prior public-safe response. */
  ifMatch?: string;
  /** Test-only override; production callers should use the generated key. */
  idempotencyKey?: string;
}

export interface PublicUploadInput {
  file: File;
  kind: 'invoice' | 'eligibility_proof' | 'supplement' | 'other';
  ifMatch: string;
  idempotencyKey?: string;
  onProgress?: (percent: number) => void;
}

export interface PublicApiClientOptions {
  fetcher?: BrowserFetch;
  /** The CSRF cookie is intentionally readable by same-origin LIFF JavaScript. */
  cookieSource?: () => string;
  /** Injectable for deterministic tests; production uses crypto.randomUUID(). */
  idempotencyKeyFactory?: () => string;
  csrfCookieName?: string;
}

export class PublicApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(input: {
    code: string;
    message: string;
    status?: number;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'PublicApiError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
  }
}

const DEFAULT_CSRF_COOKIE_NAME = 'flowpass_csrf';
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const QUOTED_ETAG = /^"(0|[1-9][0-9]*)"$/;
const SAME_ORIGIN_BASE = 'https://flowpass.invalid';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublicSuccess(value: unknown): value is PublicApiSuccess<unknown> {
  if (!isRecord(value) || !isRecord(value.meta) || typeof value.meta.requestId !== 'string') {
    return false;
  }
  return 'data' in value && (value.meta.etag === undefined || typeof value.meta.etag === 'string');
}

function isPublicFailure(value: unknown): value is PublicApiFailure {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    typeof value.error.requestId === 'string'
  );
}

function currentCookie(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const encoded = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

function assertPublicApiPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) {
    throw new PublicApiError({
      code: 'INVALID_PUBLIC_API_PATH',
      message: 'The requested API path is invalid',
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(path, SAME_ORIGIN_BASE);
  } catch {
    throw new PublicApiError({
      code: 'INVALID_PUBLIC_API_PATH',
      message: 'The requested API path is invalid',
    });
  }
  if (parsed.origin !== SAME_ORIGIN_BASE || !parsed.pathname.startsWith('/api/v1/')) {
    throw new PublicApiError({
      code: 'INVALID_PUBLIC_API_PATH',
      message: 'The requested API path is invalid',
    });
  }
}

function requireNonBlank(value: string, code: string): string {
  if (!value.trim()) {
    throw new PublicApiError({ code, message: 'The browser sign-in request is incomplete' });
  }
  // Both the ID token and server nonce are opaque verifier inputs. Do not
  // normalize a nonblank value before its server-side signature/hash checks.
  return value;
}

function serializeJson(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) throw new TypeError('JSON value missing');
    return serialized;
  } catch {
    throw new PublicApiError({
      code: 'INVALID_PUBLIC_REQUEST',
      message: 'The browser request could not be prepared',
    });
  }
}

function createDefaultIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new PublicApiError({
      code: 'IDEMPOTENCY_UNAVAILABLE',
      message: 'The browser cannot prepare this request',
    });
  }
  return globalThis.crypto.randomUUID();
}

function readPublicApiEnvelope<T>(body: unknown, response: Response): T {
  if (isPublicFailure(body)) {
    throw new PublicApiError({
      code: body.error.code,
      message: body.error.message,
      status: response.status,
      requestId: body.error.requestId,
    });
  }
  if (response.ok && isPublicSuccess(body)) {
    return body.data as T;
  }
  throw new PublicApiError({
    code: 'INVALID_API_RESPONSE',
    message: 'The service returned an invalid response',
    status: response.status,
  });
}

/**
 * A narrow, cookie-only client for public FlowPass routes. It deliberately
 * offers no bearer-token or arbitrary-host escape hatch.
 */
export class PublicApiClient {
  private readonly fetcher: BrowserFetch;
  private readonly cookieSource: () => string;
  private readonly idempotencyKeyFactory: () => string;
  private readonly csrfCookieName: string;

  constructor(options: PublicApiClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.cookieSource = options.cookieSource ?? currentCookie;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? createDefaultIdempotencyKey;
    this.csrfCookieName = options.csrfCookieName ?? DEFAULT_CSRF_COOKIE_NAME;
  }

  async bootstrapLineLogin(): Promise<{ nonce: string }> {
    const data = await this.request<{ nonce: unknown }>('/api/v1/sessions/line/bootstrap', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    if (!isRecord(data) || typeof data.nonce !== 'string' || !data.nonce.trim()) {
      throw new PublicApiError({
        code: 'INVALID_API_RESPONSE',
        message: 'The service returned an invalid response',
      });
    }
    return { nonce: data.nonce };
  }

  async exchangeLineIdToken(input: LineExchangeInput): Promise<ApplicantSessionSummary> {
    const idToken = requireNonBlank(input.idToken, 'LIFF_ID_TOKEN_UNAVAILABLE');
    const nonce = requireNonBlank(input.nonce, 'LOGIN_NONCE_UNAVAILABLE');
    const idempotencyKey = this.nextIdempotencyKey();
    const data = await this.request<{ session: { expiresAt: unknown } }>('/api/v1/sessions/line', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: serializeJson({ idToken, nonce }),
    });
    if (!isRecord(data) || !isRecord(data.session) || typeof data.session.expiresAt !== 'string') {
      throw new PublicApiError({
        code: 'INVALID_API_RESPONSE',
        message: 'The service returned an invalid response',
      });
    }
    return { expiresAt: data.session.expiresAt };
  }

  async read<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  async mutate<T>(path: string, input: PublicMutationInput): Promise<T> {
    const csrfToken = readCookie(this.cookieSource(), this.csrfCookieName);
    if (!csrfToken) {
      throw new PublicApiError({
        code: 'CSRF_TOKEN_UNAVAILABLE',
        message: 'The browser session could not be verified',
      });
    }
    if (input.ifMatch !== undefined && !QUOTED_ETAG.test(input.ifMatch)) {
      throw new PublicApiError({
        code: 'INVALID_ETAG',
        message: 'The resource version is invalid',
      });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'X-FlowPass-CSRF': csrfToken,
      'Idempotency-Key': input.idempotencyKey ?? this.nextIdempotencyKey(),
    };
    if (input.ifMatch !== undefined) headers['If-Match'] = input.ifMatch;
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.request<T>(path, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : serializeJson(input.body),
    });
  }

  async upload<T>(path: string, input: PublicUploadInput): Promise<T> {
    assertPublicApiPath(path);
    const csrfToken = readCookie(this.cookieSource(), this.csrfCookieName);
    if (!csrfToken) {
      throw new PublicApiError({ code: 'CSRF_TOKEN_UNAVAILABLE', message: 'The browser session could not be verified' });
    }
    if (!QUOTED_ETAG.test(input.ifMatch)) {
      throw new PublicApiError({ code: 'INVALID_ETAG', message: 'The resource version is invalid' });
    }
    const form = new FormData();
    form.set('kind', input.kind);
    form.set('file', input.file, input.file.name || 'upload');
    input.onProgress?.(0);
    const response = await this.fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'X-FlowPass-CSRF': csrfToken,
        'Idempotency-Key': input.idempotencyKey ?? this.nextIdempotencyKey(),
        'If-Match': input.ifMatch,
      },
      body: form,
    });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    const data = readPublicApiEnvelope<T>(body, response);
    input.onProgress?.(100);
    return data;
  }

  private nextIdempotencyKey(): string {
    const key = this.idempotencyKeyFactory();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new PublicApiError({
        code: 'IDEMPOTENCY_UNAVAILABLE',
        message: 'The browser cannot prepare this request',
      });
    }
    return key;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    assertPublicApiPath(path);
    let response: Response;
    try {
      response = await this.fetcher(path, { ...init, credentials: 'same-origin' });
    } catch {
      throw new PublicApiError({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'The service is unavailable',
      });
    }
    if (response.status === 204) {
      return undefined as T;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PublicApiError({
        code: 'INVALID_API_RESPONSE',
        message: 'The service returned an invalid response',
        status: response.status,
      });
    }
    return readPublicApiEnvelope<T>(body, response);
  }
}
