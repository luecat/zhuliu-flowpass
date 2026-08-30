import { apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import type { CookieValue } from '../../../../../../server/domain/line-session-service';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

function serializeCookie(cookie: CookieValue): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`, `SameSite=${cookie.sameSite === 'lax' ? 'Lax' : 'Strict'}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`);
  return parts.join('; ');
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  if (!runtime) {
    return new Response(JSON.stringify({ error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service dependency is unavailable', requestId: crypto.randomUUID() } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const result = runtime.lineSessions.issueBootstrap({ origin: request.headers.get('origin') });
  if (result.kind === 'failure') {
    return toJsonResponse(result.body);
  }
  return toJsonResponse(apiSuccess({ nonce: result.nonce }, result.requestId), {
    status: 201,
    headers: { 'Set-Cookie': serializeCookie(result.cookie), 'Cache-Control': 'no-store' },
  });
}
