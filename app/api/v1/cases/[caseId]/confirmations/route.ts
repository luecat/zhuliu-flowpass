import { z } from 'zod';
import { ApiErrorCode, apiFailure, apiSuccess, parseQuotedEtag, toJsonResponse } from '../../../../../../shared/api-contract';
import { PassportLifecycleError, createPassportLifecycle } from '../../../../../../server/domain/passport-lifecycle';
import { aiInputTokenBudget, createAiDraftService, AiDraftCommandError } from '../../../../../../server/domain/ai-draft-service';
import { AiDraftAdmissionGuard } from '../../../../../../server/domain/line-session-service';
import { isValidMutationKey, readApplicantMutation, reserveApplicantMutation, finalizeApplicantMutation, deleteApplicantMutationReservation } from '../../../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

const BodySchema = z.object({
  passportVersionId: z.string().min(1).max(128),
  answers: z.array(z.object({ questionId: z.string().min(1).max(128), answer: z.string().max(4_096) }).strict()).max(12),
  declarations: z.array(z.object({ confirmationType: z.string().min(1).max(64), targetKey: z.string().min(1).max(128), value: z.unknown() }).strict()).max(32),
}).strict();

function cookie(request: Request, name: string): string | null { for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; } return null; }
function errorResponse(error: PassportLifecycleError | AiDraftCommandError, requestId: string): Response {
  if (error instanceof AiDraftCommandError) {
    const code = error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'ETAG_MISMATCH' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : error.code === 'AI_INPUT_UNSAFE' ? ApiErrorCode.AI_INPUT_UNSAFE : error.code === 'ACTIVE_JOB' || error.code === 'RATE_LIMITED' ? ApiErrorCode.RATE_LIMITED : ApiErrorCode.AI_INPUT_TOO_LARGE;
    return toJsonResponse(apiFailure(code, requestId));
  }
  const code = error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'ETAG_MISMATCH' || error.code === 'STALE_VERSION' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'PASSPORT_NOT_READY' ? ApiErrorCode.PASSPORT_NOT_READY : error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : ApiErrorCode.INVALID_REQUEST;
  return toJsonResponse(apiFailure(code, requestId));
}

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const sessionToken = cookie(request, 'flowpass_session');
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken, csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const key = request.headers.get('idempotency-key');
  const ifMatch = request.headers.get('if-match');
  if (!isValidMutationKey(key) || parseQuotedEtag(ifMatch) === null) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  if (ifMatch === null) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  let raw: unknown;
  try { raw = await request.json(); } catch { return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId)); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const { caseId } = await context.params;
  const now = runtime.clock?.() ?? new Date();
  const projection = { caseId, passportVersionId: parsed.data.passportVersionId, answers: parsed.data.answers.map((answer) => ({ questionId: answer.questionId, answer: answer.answer })), declarations: parsed.data.declarations.map((declaration) => [declaration.confirmationType, declaration.targetKey, declaration.value]) };
  const replay = readApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/confirmations`, idempotencyKey: key, requestProjection: { ...projection, ifMatch }, now });
  if (replay?.kind === 'conflict') return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  if (replay?.kind === 'replay') { try { return toJsonResponse(JSON.parse(replay.body), { status: replay.status, headers: { 'Cache-Control': 'no-store' } }); } catch { return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); } }
  const reservation = reserveApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/confirmations`, idempotencyKey: key, requestProjection: { ...projection, ifMatch }, now });
  if (reservation.kind === 'conflict') return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  if (reservation.kind === 'replay') { try { return toJsonResponse(JSON.parse(reservation.body), { status: reservation.status }); } catch { return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); } }
  try {
    const ai = createAiDraftService({ database: runtime.database, crypto: runtime.crypto, modelId: process.env.FLOWPASS_MODEL_ID ?? 'unconfigured', clock: runtime.clock, admission: new AiDraftAdmissionGuard(runtime.database, runtime.crypto, runtime.clock), inputTokenBudget: aiInputTokenBudget(process.env.FLOWPASS_MODEL_PROVIDER) });
    const lifecycle = createPassportLifecycle({ database: runtime.database, crypto: runtime.crypto, clock: runtime.clock, enqueueRevision: ({ applicantId, caseId: queuedCaseId }) => {
      const queued = ai.enqueueInTransaction({ applicantId, caseId: queuedCaseId, operation: 'revise' });
      return { jobId: queued.job.id, state: queued.job.state };
    } });
    const result = parsed.data.answers.length > 0
      ? lifecycle.answerFollowUps({ applicantId: csrf.applicantId, caseId, passportVersionId: parsed.data.passportVersionId, ifMatch, answers: parsed.data.answers, declarations: parsed.data.declarations })
      : lifecycle.confirmVersion({ applicantId: csrf.applicantId, caseId, passportVersionId: parsed.data.passportVersionId, ifMatch, declarations: parsed.data.declarations });
    const revision = 'revisionJobId' in result ? result as { revisionJobId?: string; revisionJobState?: string } : {};
    const response = apiSuccess({ passportVersionId: result.id, versionNo: result.versionNo, workflowState: result.workflowState, ...(revision.revisionJobId ? { revisionJobId: revision.revisionJobId, jobState: revision.revisionJobState } : {}) }, requestId, result.versionNo);
    if (!finalizeApplicantMutation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key, status: 201, publicBody: JSON.stringify(response), now })) throw new Error('idempotency finalization failed');
    return toJsonResponse(response, { status: 201, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
  } catch (error) {
    deleteApplicantMutationReservation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key });
    return error instanceof PassportLifecycleError || error instanceof AiDraftCommandError ? errorResponse(error, requestId) : toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
}
