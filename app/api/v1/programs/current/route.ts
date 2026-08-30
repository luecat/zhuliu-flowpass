import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../shared/api-contract';
import { getCurrentProgram, createProgramService } from '../../../../../server/domain/program-service';
import { getPublicRuntime } from '../../../../../server/public/runtime';

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
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, runtime.lineSessions.getApplicantCookieNames().session));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const program = getCurrentProgram(createProgramService(runtime.database, { applicantId: session.applicantId }));
  return toJsonResponse(apiSuccess(program, requestId), { headers: { 'Cache-Control': 'no-store' } });
}
