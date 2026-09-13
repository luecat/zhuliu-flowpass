import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../shared/api-contract';
import { queryPassportToolStatus } from '../../../../server/domain/public-tool-status';
import { getPublicRuntime } from '../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));

  // Passive search by tool name is intentionally unsupported: detection is passport-driven.
  if (new URL(request.url).searchParams.has('tool')) {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  }

  const result = queryPassportToolStatus(runtime.database, runtime.crypto, session.applicantId);
  return toJsonResponse(
    apiSuccess({
      mode: 'passport',
      ...result,
    }, requestId),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
