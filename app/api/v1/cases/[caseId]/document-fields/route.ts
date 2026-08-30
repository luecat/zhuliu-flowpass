import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import { getCaseForApplicant } from '../../../../../../server/db/repositories/cases';
import { listDocumentFieldsForApplicant } from '../../../../../../server/db/repositories/documents';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null { for (const part of (request.headers.get('cookie') ?? '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') || null; } return null; }

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime(); const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const { caseId } = await context.params; const ownedCase = getCaseForApplicant(runtime.database, session, caseId);
  if (!ownedCase) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  const fields = listDocumentFieldsForApplicant(runtime.database, session, runtime.crypto, caseId);
  const response = apiSuccess({ fields }, requestId, ownedCase.rowVersion);
  return toJsonResponse(response, { headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
}
