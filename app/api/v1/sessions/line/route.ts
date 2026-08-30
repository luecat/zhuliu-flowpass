import {
  ApiErrorCode,
  LineExchangeRequestSchema,
  apiFailure,
  toJsonResponse,
} from '../../../../../shared/api-contract';
import type { CookieValue } from '../../../../../server/domain/line-session-service';
import { getPublicRuntime } from '../../../../../server/public/runtime';

function getCookie(request: Request, name: string): string | null {
  const value = request.headers.get('cookie');
  if (!value) return null;
  for (const part of value.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=');
    if (cookieName === name) return rest.join('=') || null;
  }
  return null;
}

function serializeCookie(cookie: CookieValue): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`, 'SameSite=Lax'];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  return parts.join('; ');
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  if (!runtime) {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, crypto.randomUUID()));
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, runtime.requestIdGenerator?.() ?? crypto.randomUUID()));
  }
  const parsed = LineExchangeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, runtime.requestIdGenerator?.() ?? crypto.randomUUID()));
  }
  const names = runtime.lineSessions.getApplicantCookieNames();
  const result = await runtime.lineSessions.exchange({
    origin: request.headers.get('origin'),
    idToken: parsed.data.idToken,
    nonce: parsed.data.nonce,
    bootstrapCookieNonce: getCookie(request, names.bootstrap),
    idempotencyKey: request.headers.get('idempotency-key'),
  });
  if (result.kind === 'failure') {
    return toJsonResponse(result.body);
  }
  if (result.kind === 'replay') {
    return toJsonResponse(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of result.sessionCookies) headers.append('Set-Cookie', serializeCookie(cookie));
  return toJsonResponse(result.body, { status: 201, headers });
}
