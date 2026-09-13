import { z } from 'zod';
import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../shared/api-contract';
import { createCaseService, CaseCommandError } from '../../../../server/domain/case-service';
import { RateLimitAction, RateLimiter } from '../../../../server/domain/line-session-service';
import { isValidMutationKey, readApplicantMutation } from '../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../server/public/runtime';
import { createPublicRouteHandlers } from '../../../../server/public/public-routes';

const BodySchema = z.object({
  programCycleId: z.string().min(1).max(128),
  reuseFromCaseId: z.string().min(1).max(128).nullable().optional(),
}).strict();

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; }
  return null;
}

function failure(error: CaseCommandError, requestId: string) {
  const code = error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : error.code === 'ETAG_MISMATCH' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'IDEMPOTENCY_KEY_REUSED' ? ApiErrorCode.IDEMPOTENCY_KEY_REUSED : ApiErrorCode.INVALID_REQUEST;
  return toJsonResponse(apiFailure(code, requestId));
}

export async function GET(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  return createPublicRouteHandlers({
    database: runtime.database,
    crypto: runtime.crypto,
    sessionReader: runtime.lineSessions,
    requestIdGenerator: runtime.requestIdGenerator,
  }).listCases(request);
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getPublicRuntime(); const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const sessionToken = cookie(request, 'flowpass_session');
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken, csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const key = request.headers.get('idempotency-key'); if (!isValidMutationKey(key)) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  let body: unknown; try { body = await request.json(); } catch { return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId)); }
  const parsed = BodySchema.safeParse(body); if (!parsed.success) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const now = runtime.clock?.() ?? new Date();
  const reuseFromCaseId = parsed.data.reuseFromCaseId ?? null;
  const requestProjection = reuseFromCaseId
    ? { programCycleId: parsed.data.programCycleId, reuseFromCaseId }
    : { programCycleId: parsed.data.programCycleId };
  const replay = readApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: '/api/v1/cases', idempotencyKey: key, requestProjection, now });
  if (replay?.kind === 'conflict') return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  if (replay?.kind === 'replay') {
    try { const data = JSON.parse(replay.body) as { case: { rowVersion?: number } }; const response = apiSuccess(data, requestId, data.case.rowVersion); return toJsonResponse(response, { status: replay.status, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } }); } catch { return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); }
  }
  try {
    const cases = createCaseService({ database: runtime.database, crypto: runtime.crypto, clock: runtime.clock, requestIdGenerator: runtime.requestIdGenerator });
    if (!reuseFromCaseId) {
      const active = cases.findActiveDraft(csrf.applicantId);
      if (active) {
        const response = apiSuccess({ case: active, reused: false }, requestId, active.rowVersion);
        return toJsonResponse(response, { status: 200, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
      }
    }
    const rate = new RateLimiter(runtime.database, runtime.crypto, runtime.clock ?? (() => new Date())).consume({ action: RateLimitAction.CASE_CREATE, scope: csrf.applicantId });
    if (!rate.allowed) return toJsonResponse(apiFailure(ApiErrorCode.RATE_LIMITED, requestId, { retryAfter: rate.retryAfter }));
    const result = cases.create({
      applicantId: csrf.applicantId,
      programCycleId: parsed.data.programCycleId,
      reuseFromCaseId,
      idempotencyKey: key,
      requestId,
    });
    const response = apiSuccess(result, requestId, result.case.rowVersion);
    return toJsonResponse(response, { status: 201, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof CaseCommandError) return failure(error, requestId); return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); }
}
