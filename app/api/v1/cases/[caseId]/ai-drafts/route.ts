import { z } from 'zod';
import { ApiErrorCode, apiFailure, apiSuccess, parseQuotedEtag, toJsonResponse } from '../../../../../../shared/api-contract';
import { aiInputTokenBudget, createAiDraftService, AiDraftCommandError } from '../../../../../../server/domain/ai-draft-service';
import { AiDraftAdmissionGuard } from '../../../../../../server/domain/line-session-service';
import { getCaseForApplicant } from '../../../../../../server/db/repositories/cases';
import { getApplicantActiveAiDraftJob } from '../../../../../../server/db/repositories/jobs';
import { isValidMutationKey, readApplicantMutation, reserveApplicantMutation, finalizeApplicantMutation, deleteApplicantMutationReservation } from '../../../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

const BodySchema = z.object({ operation: z.enum(['draft', 'revise']).optional(), retry: z.boolean().optional() }).strict();
function cookie(request: Request, name: string): string | null { for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; } return null; }
function errorResponse(code: ApiErrorCode, id: string, retryAfter?: number): Response { return toJsonResponse(apiFailure(code, id, retryAfter === undefined ? {} : { retryAfter })); }

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime(); const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return errorResponse(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId);
  const sessionToken = cookie(request, 'flowpass_session');
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken, csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return errorResponse(ApiErrorCode.CSRF_FAILED, requestId);
  const { caseId } = await context.params;
  const current = getCaseForApplicant(runtime.database, { applicantId: csrf.applicantId }, caseId);
  if (!current) return errorResponse(ApiErrorCode.NOT_FOUND, requestId);
  const active = getApplicantActiveAiDraftJob(runtime.database, { applicantId: csrf.applicantId }, caseId);
  if (!active) return errorResponse(ApiErrorCode.NOT_FOUND, requestId);
  return toJsonResponse(apiSuccess({ jobId: active.id, state: active.state }, requestId), { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime(); const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return errorResponse(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId);
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return errorResponse(ApiErrorCode.CSRF_FAILED, requestId);
  const sessionToken = cookie(request, 'flowpass_session');
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken, csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return errorResponse(ApiErrorCode.CSRF_FAILED, requestId);
  const key = request.headers.get('idempotency-key'); const ifMatch = request.headers.get('if-match');
  if (!isValidMutationKey(key) || parseQuotedEtag(ifMatch) === null) return errorResponse(ApiErrorCode.INVALID_REQUEST, requestId);
  let body: unknown; try { body = await request.json(); } catch { body = {}; }
  const parsed = BodySchema.safeParse(body); if (!parsed.success) return errorResponse(ApiErrorCode.INVALID_REQUEST, requestId);
  const { caseId } = await context.params; const now = runtime.clock?.() ?? new Date();
  const projection = { caseId, operation: parsed.data.operation ?? 'draft', retry: parsed.data.retry === true, ifMatch };
  const replay = readApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/ai-drafts`, idempotencyKey: key, requestProjection: projection, now });
  if (replay?.kind === 'conflict') return errorResponse(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId);
  if (replay?.kind === 'replay') { try { return toJsonResponse(JSON.parse(replay.body), { status: replay.status, headers: { 'Cache-Control': 'no-store' } }); } catch { return errorResponse(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId); } }
  const reservation = reserveApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/ai-drafts`, idempotencyKey: key, requestProjection: projection, now });
  if (reservation.kind === 'conflict') return errorResponse(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId);
  if (reservation.kind === 'replay') { try { return toJsonResponse(JSON.parse(reservation.body), { status: reservation.status }); } catch { return errorResponse(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId); } }
  try {
    const current = getCaseForApplicant(runtime.database, { applicantId: csrf.applicantId }, caseId);
    if (!current) throw new AiDraftCommandError('NOT_FOUND');
    if (current.rowVersion !== parseQuotedEtag(ifMatch)) throw new AiDraftCommandError('ETAG_MISMATCH');
    const active = getApplicantActiveAiDraftJob(runtime.database, { applicantId: csrf.applicantId }, caseId);
    if (active) {
      const response = apiSuccess({ jobId: active.id, state: active.state }, requestId);
      if (!finalizeApplicantMutation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key, status: 202, publicBody: JSON.stringify(response), now })) throw new Error('idempotency finalization failed');
      return toJsonResponse(response, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    const service = createAiDraftService({ database: runtime.database, crypto: runtime.crypto, modelId: process.env.FLOWPASS_MODEL_ID ?? 'unconfigured', clock: runtime.clock, admission: new AiDraftAdmissionGuard(runtime.database, runtime.crypto, runtime.clock), inputTokenBudget: aiInputTokenBudget(process.env.FLOWPASS_MODEL_PROVIDER) });
    const result = service.enqueue({ applicantId: csrf.applicantId, caseId, operation: parsed.data.operation, retryNonce: parsed.data.retry ? key ?? undefined : undefined, expectedRowVersion: parseQuotedEtag(ifMatch)! });
    const response = apiSuccess({ jobId: result.job.id, state: result.job.state }, requestId);
    if (!finalizeApplicantMutation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key, status: 202, publicBody: JSON.stringify(response), now })) throw new Error('idempotency finalization failed');
    return toJsonResponse(response, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    deleteApplicantMutationReservation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key });
    if (error instanceof AiDraftCommandError) { if (error.code === 'NOT_FOUND') return errorResponse(ApiErrorCode.NOT_FOUND, requestId); if (error.code === 'ETAG_MISMATCH') return errorResponse(ApiErrorCode.ETAG_MISMATCH, requestId); if (error.code === 'INVALID_STATE') return errorResponse(ApiErrorCode.INVALID_STATE, requestId); if (error.code === 'AI_INPUT_TOO_LARGE') return errorResponse(ApiErrorCode.AI_INPUT_TOO_LARGE, requestId); if (error.code === 'AI_INPUT_UNSAFE') return errorResponse(ApiErrorCode.AI_INPUT_UNSAFE, requestId); if (error.code === 'ACTIVE_JOB') return errorResponse(ApiErrorCode.RATE_LIMITED, requestId, 10); if (error.code === 'RATE_LIMITED') return errorResponse(ApiErrorCode.RATE_LIMITED, requestId); }
    return errorResponse(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId);
  }
}
