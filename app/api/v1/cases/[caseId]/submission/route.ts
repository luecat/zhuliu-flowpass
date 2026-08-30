import { z } from 'zod';
import { ApiErrorCode, apiFailure, apiSuccess, parseQuotedEtag, toJsonResponse } from '../../../../../../shared/api-contract';
import { SubmissionCommandError, createSubmissionService } from '../../../../../../server/domain/submission-service';
import { isValidMutationKey, readApplicantMutation, reserveApplicantMutation, finalizeApplicantMutation, deleteApplicantMutationReservation } from '../../../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

const BodySchema = z.object({ passportVersionId: z.string().min(1).max(128) }).strict();
function cookie(request: Request, name: string): string | null { for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; } return null; }
function errorResponse(error: SubmissionCommandError, requestId: string): Response {
  const code = error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'ETAG_MISMATCH' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : error.code === 'PASSPORT_NOT_READY' ? ApiErrorCode.PASSPORT_NOT_READY : error.code === 'DOCUMENT_NOT_READY' ? ApiErrorCode.DOCUMENT_NOT_READY : ApiErrorCode.INVALID_REQUEST;
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
  const projection = { caseId, passportVersionId: parsed.data.passportVersionId, ifMatch };
  const replay = readApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/submission`, idempotencyKey: key, requestProjection: projection, now });
  if (replay?.kind === 'conflict') return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  if (replay?.kind === 'replay') { try { return toJsonResponse(JSON.parse(replay.body), { status: replay.status, headers: { 'Cache-Control': 'no-store' } }); } catch { return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); } }
  const reservation = reserveApplicantMutation({ database: runtime.database, crypto: runtime.crypto, applicantId: csrf.applicantId, method: 'POST', normalizedRoute: `/api/v1/cases/${caseId}/submission`, idempotencyKey: key, requestProjection: projection, now });
  if (reservation.kind === 'conflict') return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  if (reservation.kind === 'replay') { try { return toJsonResponse(JSON.parse(reservation.body), { status: reservation.status }); } catch { return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId)); } }
  try {
    const result = createSubmissionService({ database: runtime.database, crypto: runtime.crypto, clock: runtime.clock, requestIdGenerator: runtime.requestIdGenerator }).submit({ applicantId: csrf.applicantId, caseId, passportVersionId: parsed.data.passportVersionId, ifMatch });
    const response = apiSuccess(result, requestId, result.case.rowVersion);
    if (!finalizeApplicantMutation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key, status: 201, publicBody: JSON.stringify(response), now })) throw new Error('idempotency finalization failed');
    return toJsonResponse(response, { status: 201, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
  } catch (error) {
    deleteApplicantMutationReservation({ database: runtime.database, crypto: runtime.crypto, reservation, idempotencyKey: key });
    return error instanceof SubmissionCommandError ? errorResponse(error, requestId) : toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
}
