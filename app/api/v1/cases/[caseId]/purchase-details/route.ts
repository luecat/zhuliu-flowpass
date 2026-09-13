import { v7 as uuidv7 } from 'uuid';
import {
  ApiErrorCode,
  apiFailure,
  apiSuccess,
  parseQuotedEtag,
  toJsonResponse,
} from '../../../../../../shared/api-contract';
import {
  PurchaseDetailsWriteSchema,
  toPublicPurchaseDetails,
} from '../../../../../../shared/purchase-details-contract';
import { isBlockedAiToolLabel } from '../../../../../../shared/approved-ai-tools';
import { appendEncryptedAuditLog } from '../../../../../../server/db/repositories/audit';
import { getCaseForApplicant } from '../../../../../../server/db/repositories/cases';
import {
  getPurchaseDetailsForApplicant,
  upsertPurchaseDetailsForApplicant,
} from '../../../../../../server/db/repositories/purchase-details';
import { materializePurchaseDetails } from '../../../../../../server/domain/purchase-details-materialize';
import {
  deleteApplicantMutationReservation,
  finalizeApplicantMutation,
  isValidMutationKey,
  readApplicantMutation,
  reserveApplicantMutation,
} from '../../../../../../server/public/public-mutations';
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
  const ownedCase = getCaseForApplicant(runtime.database, session, caseId);
  if (!ownedCase) return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  let record;
  try {
    record = getPurchaseDetailsForApplicant(runtime.database, session, runtime.crypto, caseId);
  } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
  const details = record?.details ? toPublicPurchaseDetails(record.details) : null;
  const response = apiSuccess({ details }, requestId, ownedCase.rowVersion);
  return toJsonResponse(response, {
    headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' },
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  if (!runtime.lineSessions.isPublicOrigin(request.headers.get('origin'))) {
    return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  }
  const csrf = runtime.lineSessions.verifyApplicantCsrf({
    sessionToken: cookie(request, 'flowpass_session'),
    csrfCookie: cookie(request, 'flowpass_csrf'),
    csrfHeader: request.headers.get('x-flowpass-csrf'),
  });
  if (!csrf) return toJsonResponse(apiFailure(ApiErrorCode.CSRF_FAILED, requestId));
  const idempotencyKey = request.headers.get('idempotency-key');
  const ifMatch = request.headers.get('if-match');
  const expected = parseQuotedEtag(ifMatch);
  if (!isValidMutationKey(idempotencyKey) || ifMatch === null || expected === null) {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  }
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  }
  const parsed = PurchaseDetailsWriteSchema.safeParse(raw);
  if (!parsed.success) return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  if (isBlockedAiToolLabel(parsed.data.softwareName) || isBlockedAiToolLabel(parsed.data.companyName)) {
    return toJsonResponse(apiFailure(ApiErrorCode.INVALID_REQUEST, requestId));
  }
  const { caseId } = await context.params;
  const now = runtime.clock?.() ?? new Date();
  const route = `/api/v1/cases/${caseId}/purchase-details`;
  const projection = { caseId, details: parsed.data, ifMatch };
  const replay = readApplicantMutation({
    database: runtime.database,
    crypto: runtime.crypto,
    applicantId: csrf.applicantId,
    method: 'PUT',
    normalizedRoute: route,
    idempotencyKey,
    requestProjection: projection,
    now,
  });
  if (replay?.kind === 'conflict') {
    return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  }
  if (replay?.kind === 'replay') {
    try {
      return toJsonResponse(JSON.parse(replay.body), {
        status: replay.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
    }
  }
  const reservation = reserveApplicantMutation({
    database: runtime.database,
    crypto: runtime.crypto,
    applicantId: csrf.applicantId,
    method: 'PUT',
    normalizedRoute: route,
    idempotencyKey,
    requestProjection: projection,
    now,
  });
  if (reservation.kind === 'conflict') {
    return toJsonResponse(apiFailure(ApiErrorCode.IDEMPOTENCY_KEY_REUSED, requestId));
  }
  if (reservation.kind === 'replay') {
    try { return toJsonResponse(JSON.parse(reservation.body), { status: reservation.status }); } catch {
      return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
    }
  }

  try {
    const result = runtime.database.transaction(() => {
      const current = runtime.database.prepare(
        'SELECT state, row_version FROM cases WHERE id = ? AND applicant_id = ?',
      ).get(caseId, csrf.applicantId) as { state: string; row_version: number } | undefined;
      if (!current) throw new Error('NOT_FOUND');
      if (current.row_version !== expected) throw new Error('ETAG_MISMATCH');
      if (current.state !== 'draft') throw new Error('INVALID_STATE');
      const previous = getPurchaseDetailsForApplicant(
        runtime.database,
        { applicantId: csrf.applicantId },
        runtime.crypto,
        caseId,
      )?.details ?? null;
      const stored = materializePurchaseDetails({
        write: parsed.data,
        crypto: runtime.crypto,
        previous,
      });
      const saved = upsertPurchaseDetailsForApplicant(
        runtime.database,
        { applicantId: csrf.applicantId },
        runtime.crypto,
        { caseId, details: stored, now: now.toISOString() },
      );
      const changed = runtime.database.prepare(`
        UPDATE cases
        SET requested_amount_twd = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ? AND applicant_id = ? AND state = 'draft' AND row_version = ?
      `).run(stored.convertedTwd, now.toISOString(), caseId, csrf.applicantId, expected);
      if (changed.changes !== 1) throw new Error('ETAG_MISMATCH');
      appendEncryptedAuditLog(runtime.database, runtime.crypto, {
        id: uuidv7(),
        actorType: 'applicant',
        actorId: csrf.applicantId,
        action: 'update',
        entityType: 'case_purchase_details',
        entityId: caseId,
        beforeHash: null,
        afterHash: saved.contentSha256,
        detail: { kind: 'operation', operation: 'update', outcome: 'ok' },
        requestId,
        createdAt: now.toISOString(),
      });
      const nextCase = getCaseForApplicant(
        runtime.database,
        { applicantId: csrf.applicantId },
        caseId,
      );
      if (!nextCase) throw new Error('NOT_FOUND');
      return { details: toPublicPurchaseDetails(saved.details), rowVersion: nextCase.rowVersion };
    })();
    const response = apiSuccess({ details: result.details }, requestId, result.rowVersion);
    if (!finalizeApplicantMutation({
      database: runtime.database,
      crypto: runtime.crypto,
      reservation,
      idempotencyKey,
      status: 200,
      publicBody: JSON.stringify(response),
      now,
    })) throw new Error('idempotency finalization failed');
    return toJsonResponse(response, {
      status: 200,
      headers: { ETag: response.meta.etag ?? '', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    deleteApplicantMutationReservation({
      database: runtime.database,
      crypto: runtime.crypto,
      reservation,
      idempotencyKey,
    });
    const code = error instanceof Error ? error.message : '';
    if (code === 'NOT_FOUND') return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
    if (code === 'ETAG_MISMATCH') return toJsonResponse(apiFailure(ApiErrorCode.ETAG_MISMATCH, requestId));
    if (code === 'INVALID_STATE') return toJsonResponse(apiFailure(ApiErrorCode.INVALID_STATE, requestId));
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
}
