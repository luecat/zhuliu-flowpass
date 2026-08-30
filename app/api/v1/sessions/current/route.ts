import { ApiErrorCode, apiFailure, toJsonResponse } from '../../../../../shared/api-contract';
import { finalizeApplicantMutation, isValidMutationKey, reserveApplicantMutation } from '../../../../../server/public/public-mutations';
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

function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function DELETE(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) {
    return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  }
  const names = runtime.lineSessions.getApplicantCookieNames();
  const rawSession = getCookie(request, names.session);
  const csrfCookie = getCookie(request, names.csrf);
  const csrfHeader = request.headers.get('x-flowpass-csrf');
  const session = runtime.lineSessions.verifyApplicantCsrf({
    sessionToken: rawSession,
    csrfCookie,
    csrfHeader,
  });
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const key = request.headers.get('idempotency-key');
  if (!isValidMutationKey(key)) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const now = runtime.clock?.() ?? new Date();
  const reservation = reserveApplicantMutation({
    database: runtime.database,
    crypto: runtime.crypto,
    applicantId: session.applicantId,
    method: 'DELETE',
    normalizedRoute: '/api/v1/sessions/current',
    idempotencyKey: key,
    requestProjection: { origin: request.headers.get('origin') },
    now,
  });
  if (reservation.kind === 'conflict') {
    return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  }
  if (reservation.kind === 'replay') {
    return new Response(null, { status: reservation.status, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const completed = runtime.database.transaction(() => {
      runtime.lineSessions.revokeApplicant(rawSession);
      if (!finalizeApplicantMutation({
        database: runtime.database,
        crypto: runtime.crypto,
        reservation,
        idempotencyKey: key,
        status: 204,
        publicBody: '{}',
        now: runtime.clock?.() ?? new Date(),
      })) {
        throw new Error('idempotency finalization failed');
      }
      return true;
    })();
    if (!completed) throw new Error('logout failed');
  } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
  const secure = runtime.publicOrigin === 'https://flowpass.luecat.com';
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(names.session, secure));
  headers.append('Set-Cookie', clearCookie(names.csrf, secure));
  return new Response(null, { status: 204, headers });
}
