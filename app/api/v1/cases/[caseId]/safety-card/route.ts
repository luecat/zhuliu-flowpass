import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import { getCaseForApplicant } from '../../../../../../server/db/repositories/cases';
import { decryptDatabaseText } from '../../../../../../server/db/repositories/encrypted-fields';
import { inspectPassportDocument } from '../../../../../../server/domain/passport-validation';
import { buildSafetyCardModel, renderSafetyCardSvg } from '../../../../../../server/domain/safety-card';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const { caseId } = await context.params;
  const owned = getCaseForApplicant(runtime.database, session, caseId);
  if (!owned) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  const version = runtime.database.prepare(`
    SELECT id, payload_enc, workflow_state
    FROM passport_versions
    WHERE id = (
      SELECT COALESCE(submitted_passport_version_id, current_passport_version_id)
      FROM cases WHERE id = ? AND applicant_id = ?
    )
  `).get(caseId, session.applicantId) as { id: string; payload_enc: string; workflow_state: string } | undefined;
  if (!version) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  let payload: unknown;
  try {
    payload = JSON.parse(decryptDatabaseText(runtime.crypto, 'passport_versions', 'payload_enc', version.id, version.payload_enc));
  } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
  const inspection = inspectPassportDocument({ passport_draft: payload });
  if (!inspection.canonical) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  const model = buildSafetyCardModel(inspection.canonical);
  const format = new URL(request.url).searchParams.get('format');
  if (format === 'svg') {
    return new Response(renderSafetyCardSvg(model), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="flowpass-safety-card.svg"',
      },
    });
  }
  return toJsonResponse(apiSuccess({ model, workflowState: version.workflow_state }, requestId), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
