import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../shared/api-contract';
import { decryptDatabaseText } from '../../../../server/db/repositories/encrypted-fields';
import { inspectPassportDocument } from '../../../../server/domain/passport-validation';
import { getPublicRuntime } from '../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

function passportTitle(
  crypto: NonNullable<ReturnType<typeof getPublicRuntime>>['crypto'],
  passportVersionId: string | null,
  payloadEnc: string | null,
): string | null {
  if (!passportVersionId || !payloadEnc) return null;
  try {
    const raw = JSON.parse(
      decryptDatabaseText(crypto, 'passport_versions', 'payload_enc', passportVersionId, payloadEnc),
    ) as unknown;
    const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && 'passport_draft' in raw
      ? raw
      : { passport_draft: raw };
    const title = inspectPassportDocument(wrapped).canonical?.use_case.title?.trim();
    return title || null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));

  const rows = runtime.database.prepare(`
    SELECT c.id, c.case_code, pc.name AS program_name, pc.year, c.state, c.submitted_at,
           COALESCE(c.submitted_passport_version_id, c.current_passport_version_id) AS passport_version_id,
           pv.payload_enc AS payload_enc,
           (SELECT COUNT(*) FROM case_tasks t WHERE t.case_id = c.id AND t.status IN ('open','opened')) AS unresolved_task_count,
           CASE WHEN EXISTS (
             SELECT 1 FROM alerts a WHERE a.case_id = c.id AND a.status IN ('open','acknowledged')
           ) THEN 1 ELSE 0 END AS security_alert
    FROM cases c
    JOIN program_cycles pc ON pc.id = c.program_cycle_id
    LEFT JOIN passport_versions pv
      ON pv.id = COALESCE(c.submitted_passport_version_id, c.current_passport_version_id)
    WHERE c.applicant_id = ?
      AND c.deleted_at IS NULL
      AND c.state <> 'draft'
    ORDER BY pc.year DESC, c.created_at DESC
  `).all(session.applicantId) as Array<{
    id: string;
    case_code: string;
    program_name: string;
    year: number;
    state: string;
    submitted_at: string | null;
    passport_version_id: string | null;
    payload_enc: string | null;
    unresolved_task_count: number;
    security_alert: number;
  }>;

  return toJsonResponse(
    apiSuccess({
      passports: rows.map((row) => ({
        id: row.id,
        caseCode: row.case_code,
        programName: row.program_name,
        title: passportTitle(runtime.crypto, row.passport_version_id, row.payload_enc) ?? '用途',
        year: row.year,
        state: row.state,
        submittedAt: row.submitted_at,
        unresolvedTaskCount: row.unresolved_task_count,
        securityAlert: row.security_alert === 1,
      })),
    }, requestId),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
