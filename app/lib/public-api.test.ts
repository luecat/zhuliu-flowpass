import { describe, expect, it, vi } from 'vitest';
import {
  PublicApiClient,
  PublicApiError,
  type BrowserFetch,
} from './public-api';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PublicApiClient', () => {
  it('bootstraps the LINE exchange through a same-origin no-store request', async () => {
    const fetcher = vi.fn<BrowserFetch>().mockResolvedValue(
      jsonResponse({ data: { nonce: 'browser-only-nonce' }, meta: { requestId: 'request-1' } }, 201),
    );
    const client = new PublicApiClient({ fetcher });

    await expect(client.bootstrapLineLogin()).resolves.toEqual({ nonce: 'browser-only-nonce' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/sessions/line/bootstrap',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        }),
      }),
    );
  });

  it('exchanges an ID token once with the bootstrap nonce and an idempotency key', async () => {
    const fetcher = vi.fn<BrowserFetch>().mockResolvedValue(
      jsonResponse(
        {
          data: { session: { expiresAt: '2026-08-30T01:00:00.000Z' } },
          meta: { requestId: 'request-2' },
        },
        201,
      ),
    );
    const client = new PublicApiClient({
      fetcher,
      idempotencyKeyFactory: () => 'exchange-idempotency-key',
    });

    await expect(
      client.exchangeLineIdToken({ idToken: 'short-lived-id-token', nonce: 'browser-only-nonce' }),
    ).resolves.toEqual({ expiresAt: '2026-08-30T01:00:00.000Z' });

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/sessions/line',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Idempotency-Key': 'exchange-idempotency-key',
        }),
        body: JSON.stringify({ idToken: 'short-lived-id-token', nonce: 'browser-only-nonce' }),
      }),
    );
  });

  it('requires a readable CSRF cookie before later public mutations', async () => {
    const fetcher = vi.fn<BrowserFetch>();
    const client = new PublicApiClient({
      fetcher,
      cookieSource: () => '',
      idempotencyKeyFactory: () => 'mutation-idempotency-key',
    });

    await expect(
      client.mutate('/api/v1/cases', { method: 'POST', body: { programCycleId: 'cycle-1' } }),
    ).rejects.toMatchObject({ code: 'CSRF_TOKEN_UNAVAILABLE' } satisfies Partial<PublicApiError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the CSRF cookie and idempotency key without ever using a bearer token', async () => {
    const fetcher = vi.fn<BrowserFetch>().mockResolvedValue(
      jsonResponse({ data: { id: 'case-1' }, meta: { requestId: 'request-3' } }, 201),
    );
    const client = new PublicApiClient({
      fetcher,
      cookieSource: () => 'theme=forest; flowpass_csrf=csrf-cookie-value',
      idempotencyKeyFactory: () => 'mutation-idempotency-key',
    });

    await expect(
      client.mutate<{ id: string }>('/api/v1/cases', {
        method: 'POST',
        body: { programCycleId: 'cycle-1' },
      }),
    ).resolves.toEqual({ id: 'case-1' });

    const [, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({ credentials: 'same-origin' });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-flowpass-csrf')).toBe('csrf-cookie-value');
    expect(headers.get('idempotency-key')).toBe('mutation-idempotency-key');
    expect(headers.has('authorization')).toBe(false);
  });

  it('rejects absolute or non-API paths before making a request', async () => {
    const fetcher = vi.fn<BrowserFetch>();
    const client = new PublicApiClient({ fetcher });

    await expect(client.read('https://outside.example/api/v1/cases')).rejects.toMatchObject({
      code: 'INVALID_PUBLIC_API_PATH',
    } satisfies Partial<PublicApiError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uploads to the current origin instead of the API-path validation origin', async () => {
    const open = vi.fn();
    const setRequestHeader = vi.fn();
    const xhr = {
      open,
      setRequestHeader,
      send: vi.fn(),
      upload: {} as XMLHttpRequestUpload,
      withCredentials: false,
      responseType: '',
      responseText: '',
      status: 0,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      ontimeout: null as (() => void) | null,
    };
    xhr.send.mockImplementation(() => {
      xhr.status = 202;
      xhr.responseText = JSON.stringify({ data: { document: { id: 'document-1' } }, meta: { requestId: 'request-upload' } });
      xhr.onload?.();
    });
    const client = new PublicApiClient({
      cookieSource: () => 'flowpass_csrf=csrf-cookie-value',
      idempotencyKeyFactory: () => 'upload-idempotency-key',
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
    });

    await expect(client.upload<{ document: { id: string } }>('/api/v1/cases/case-1/documents', {
      file: new File(['receipt'], 'receipt.png', { type: 'image/png' }),
      kind: 'invoice',
      requirementKey: 'purchase_proof',
      ifMatch: '"1"',
    })).resolves.toEqual({ document: { id: 'document-1' } });

    expect(open).toHaveBeenCalledWith('POST', '/api/v1/cases/case-1/documents');
    expect(xhr.withCredentials).toBe(true);
    expect(setRequestHeader).toHaveBeenCalledWith('X-FlowPass-CSRF', 'csrf-cookie-value');
  });

  it('surfaces only the public-safe API error envelope', async () => {
    const fetcher = vi.fn<BrowserFetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'LINE_TOKEN_INVALID',
            message: 'LINE identity token is invalid',
            requestId: 'request-4',
            internalIdToken: 'must-not-be-copied',
          },
        },
        401,
      ),
    );
    const client = new PublicApiClient({ fetcher, idempotencyKeyFactory: () => 'exchange-key' });

    await expect(
      client.exchangeLineIdToken({ idToken: 'short-lived-id-token', nonce: 'browser-only-nonce' }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'LINE_TOKEN_INVALID',
        requestId: 'request-4',
        status: 401,
        message: 'LINE identity token is invalid',
      }),
    );
  });

  it('never treats a success-shaped body on an HTTP failure as an authenticated result', async () => {
    const fetcher = vi.fn<BrowserFetch>().mockResolvedValue(
      jsonResponse({ data: { id: 'case-that-must-not-be-used' }, meta: { requestId: 'request-5' } }, 401),
    );
    const client = new PublicApiClient({ fetcher });

    await expect(client.read('/api/v1/cases')).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
      status: 401,
    } satisfies Partial<PublicApiError>);
  });
});
