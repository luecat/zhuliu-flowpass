import { ApiErrorCode, apiFailure, toJsonResponse } from '../../../../../shared/api-contract';
import { createPublicRouteHandlers } from '../../../../../server/public/public-routes';
import { getPublicRuntime } from '../../../../../server/public/runtime';

interface RouteContext {
  params: Promise<{ caseId: string }>;
}

/** Public GETs compose the applicant-scoped route service; they never select case rows directly. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
  const { caseId } = await context.params;
  return createPublicRouteHandlers({
    database: runtime.database,
    sessionReader: runtime.lineSessions,
    requestIdGenerator: runtime.requestIdGenerator,
  }).getCase(request, caseId);
}
