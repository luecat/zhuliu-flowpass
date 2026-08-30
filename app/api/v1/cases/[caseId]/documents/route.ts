import { ApiErrorCode, apiFailure, apiSuccess, parseQuotedEtag, toJsonResponse } from '../../../../../../shared/api-contract';
import { createDocumentService, DocumentCommandError, type DocumentKind } from '../../../../../../server/domain/document-service';
import { getCaseForApplicant } from '../../../../../../server/db/repositories/cases';
import { isValidMutationKey } from '../../../../../../server/public/public-mutations';
import { getPublicRuntime } from '../../../../../../server/public/runtime';
import { MAX_MULTIPART_BODY_BYTES } from '../../../../../../server/domain/file-validation';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

function failure(error: unknown, requestId: string): Response {
  if (!(error instanceof DocumentCommandError)) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const code = error.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : error.code === 'ETAG_MISMATCH' ? ApiErrorCode.ETAG_MISMATCH : error.code === 'INVALID_STATE' ? ApiErrorCode.INVALID_STATE : error.code === 'IDEMPOTENCY_KEY_REUSED' ? ApiErrorCode.IDEMPOTENCY_KEY_REUSED : error.code === 'RATE_LIMITED' ? ApiErrorCode.RATE_LIMITED : error.code === 'FILE_INVALID' ? (error.validationCode === 'file_too_large' ? ApiErrorCode.FILE_TOO_LARGE : error.validationCode === 'type_unsupported' ? ApiErrorCode.UNSUPPORTED_FILE : ApiErrorCode.INVALID_REQUEST) : error.code === 'INVALID_REQUEST' ? ApiErrorCode.INVALID_REQUEST : ApiErrorCode.DEPENDENCY_UNAVAILABLE;
  return toJsonResponse(apiFailure(code, requestId, error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }));
}

function auth(request: Request, runtime: NonNullable<ReturnType<typeof getPublicRuntime>>): { applicantId: string } | Response {
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  return session ? { applicantId: session.applicantId } : toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, runtime.requestIdGenerator?.() ?? crypto.randomUUID()));
}

function isUploadFile(value: unknown): value is File {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; stream?: unknown; arrayBuffer?: unknown; size?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.size === 'number' && typeof candidate.arrayBuffer === 'function';
}

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime || !runtime.documentVault) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const identity = auth(request, runtime);
  if (identity instanceof Response) return identity;
  const { caseId } = await context.params;
  const ownedCase = getCaseForApplicant(runtime.database, identity, caseId);
  if (!ownedCase) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  const documents = createDocumentService({ database: runtime.database, crypto: runtime.crypto, vault: runtime.documentVault, clock: runtime.clock }).list({ applicantId: identity.applicantId, caseId });
  const response = apiSuccess({ documents }, requestId, ownedCase.rowVersion);
  return toJsonResponse(response, { headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime || !runtime.documentVault) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken: cookie(request, 'flowpass_session'), csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const idempotencyKey = request.headers.get('idempotency-key');
  const ifMatch = request.headers.get('if-match');
  if (!isValidMutationKey(idempotencyKey) || ifMatch === null || parseQuotedEtag(ifMatch) === null) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  // Reject an explicitly oversized multipart body before request.formData()
  // can buffer it. The service still enforces the exact decoded file limit for
  // chunked/unknown-length requests.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) return toJsonResponse(apiFailure(ApiErrorCode.FILE_TOO_LARGE, requestId));
  let form: FormData;
  try { form = await request.formData(); } catch { return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId)); }
  const file = form.get('file');
  const rawKind = form.get('kind');
  if (!isUploadFile(file) || typeof rawKind !== 'string' || !['invoice', 'eligibility_proof', 'supplement', 'other'].includes(rawKind)) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const { caseId } = await context.params;
  try {
    const result = await createDocumentService({ database: runtime.database, crypto: runtime.crypto, vault: runtime.documentVault, clock: runtime.clock, requestIdGenerator: runtime.requestIdGenerator }).upload({ applicantId: csrf.applicantId, caseId, kind: rawKind as DocumentKind, originalName: file.name || 'upload', ...(typeof file.stream === 'function' ? { stream: file.stream() } : { bytes: new Uint8Array(await file.arrayBuffer()) }), ifMatch, idempotencyKey, requestId });
    const response = apiSuccess(result, requestId, result.document.rowVersion);
    return toJsonResponse(response, { status: 202, headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error, requestId); }
}

export async function DELETE(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime || !runtime.documentVault) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const csrf = runtime.lineSessions.verifyApplicantCsrf({ sessionToken: cookie(request, 'flowpass_session'), csrfCookie: cookie(request, 'flowpass_csrf'), csrfHeader: request.headers.get('x-flowpass-csrf') });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const idempotencyKey = request.headers.get('idempotency-key');
  const ifMatch = request.headers.get('if-match');
  if (!isValidMutationKey(idempotencyKey) || ifMatch === null || parseQuotedEtag(ifMatch) === null) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const { caseId } = await context.params;
  const documentId = new URL(request.url).searchParams.get('documentId');
  if (!documentId) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  try {
    const result = createDocumentService({ database: runtime.database, crypto: runtime.crypto, vault: runtime.documentVault, clock: runtime.clock, requestIdGenerator: runtime.requestIdGenerator }).delete({ applicantId: csrf.applicantId, caseId, documentId, ifMatch, idempotencyKey, requestId });
    return toJsonResponse(apiSuccess(result, requestId, result.document.rowVersion), { status: 200, headers: { ETag: `"${result.document.rowVersion}"`, 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error, requestId); }
}
