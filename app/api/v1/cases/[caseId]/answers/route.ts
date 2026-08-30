import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import { createCaseService, CaseCommandError } from '../../../../../../server/domain/case-service';
import { isValidMutationKey } from '../../../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null { for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; } return null; }
function failure(error: CaseCommandError, requestId: string) { const code = error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : error.code === 'ETAG_MISMATCH' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'IDEMPOTENCY_KEY_REUSED' ? ApiErrorCode.IDEMPOTENCY_KEY_REUSED : ApiErrorCode.INVALID_REQUEST; return toJsonResponse(apiFailure(code, requestId)); }

export async function PUT(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime(); const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const sessionToken = cookie(request, 'flowpass_session'); const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken, csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const key = request.headers.get('idempotency-key'); const ifMatch = request.headers.get('if-match'); if (!isValidMutationKey(key) || !ifMatch) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  let body: unknown; try { body = await request.json(); } catch { return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId)); }
  const { caseId } = await context.params;
  try {
    const result = createCaseService({ database: runtime.database, crypto: runtime.crypto, clock: runtime.clock, requestIdGenerator: runtime.requestIdGenerator }).saveAnswers({ applicantId: csrf.applicantId, caseId, answers: body as never, ifMatch, idempotencyKey: key, requestId });
    const response = apiSuccess(result, requestId, result.case.rowVersion);
    return toJsonResponse(response, { status: 201, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof CaseCommandError) return failure(error, requestId); return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); }
}
