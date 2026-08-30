import {
  ApiErrorCode,
  apiFailure,
  apiSuccess,
  toJsonResponse,
  type ApiFailure,
} from '../../shared/api-contract';
import type { FlowPassDatabase } from '../db/connection';
import { getCaseForApplicant } from '../db/repositories/cases';
import { getApplicantVisibleJob } from '../db/repositories/jobs';

export interface PublicApplicantSession {
  sessionId: string;
  applicantId: string;
}

export interface PublicSessionReader {
  authenticateApplicant(rawSessionToken: string | null): PublicApplicantSession | null;
}

export interface PublicRouteDependencies {
  database: FlowPassDatabase;
  sessionReader: PublicSessionReader;
  requestIdGenerator?: () => string;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      return rawValue.join('=') || null;
    }
  }
  return null;
}

function requestId(dependencies: PublicRouteDependencies): string {
  return dependencies.requestIdGenerator?.() ?? crypto.randomUUID();
}

function requireApplicant(
  request: Request,
  dependencies: PublicRouteDependencies,
): PublicApplicantSession | ApiFailure {
  // Deliberately reads only the applicant cookie. Authorization headers and the
  // local Admin cookie never participate in public-route authentication.
  const session = dependencies.sessionReader.authenticateApplicant(getCookie(request, 'flowpass_session'));
  return session ?? apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId(dependencies));
}

function isFailure(value: PublicApplicantSession | ApiFailure): value is ApiFailure {
  return 'error' in value;
}

export interface PublicRouteHandlers {
  getCase(request: Request, caseId: string): Promise<Response>;
  getJob(request: Request, jobId: string): Promise<Response>;
}

/** Route factories keep authentication and SQL-scoped ownership testable without proxy involvement. */
export function createPublicRouteHandlers(dependencies: PublicRouteDependencies): PublicRouteHandlers {
  return {
    async getCase(request, caseId) {
      const session = requireApplicant(request, dependencies);
      if (isFailure(session)) {
        return toJsonResponse(session);
      }
      const record = getCaseForApplicant(dependencies.database, { applicantId: session.applicantId }, caseId);
      if (!record) {
        return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId(dependencies)));
      }
      const body = apiSuccess(record, requestId(dependencies), record.rowVersion);
      return toJsonResponse(body, { headers: { ETag: body.meta.etag ?? '' } });
    },

    async getJob(request, jobId) {
      const session = requireApplicant(request, dependencies);
      if (isFailure(session)) {
        return toJsonResponse(session);
      }
      const record = getApplicantVisibleJob(dependencies.database, { applicantId: session.applicantId }, jobId);
      if (!record) {
        return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId(dependencies)));
      }
      return toJsonResponse(apiSuccess(record, requestId(dependencies)));
    },
  };
}
