import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import { createPassportLifecycle } from '../../../../../../server/domain/passport-lifecycle';
import { getPublicRuntime } from '../../../../../../server/public/runtime';
import { listPassportVersionsForApplicant } from '../../../../../../server/db/repositories/passports';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const { caseId } = await context.params;
  if (new URL(request.url).searchParams.get('history') === '1') {
    const versions = listPassportVersionsForApplicant(runtime.database, { applicantId: session.applicantId }, caseId);
    if (versions.length === 0) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
    return toJsonResponse(apiSuccess({ versions }, requestId), { headers: { 'Cache-Control': 'no-store' } });
  }
  const versionId = new URL(request.url).searchParams.get('version') ?? undefined;
  const result = createPassportLifecycle({ database: runtime.database, crypto: runtime.crypto, clock: runtime.clock }).getForApplicant({ applicantId: session.applicantId, caseId, versionId });
  if (!result) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  const response = apiSuccess(result, requestId, result.version.versionNo);
  return toJsonResponse(response, { headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' } });
}
