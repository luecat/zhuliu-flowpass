import { ApiErrorCode, apiFailure, apiSuccess, toJsonResponse } from '../../../../../../shared/api-contract';
import { getDocumentStorageForApplicant } from '../../../../../../server/db/repositories/documents';
import { getPublicRuntime } from '../../../../../../server/public/runtime';
import { DEFAULT_OCR_LANGUAGES, type OcrMediaType } from '../../../../../../server/adapters/ocr/ocr-engine';
import type { DocumentRequirementKey } from '../../../../../../shared/purchase-details-contract';
import type { DocumentOcrResponseData } from '../../../../../../shared/ocr-contract';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

const OCR_ELIGIBLE_REQUIREMENTS: ReadonlySet<DocumentRequirementKey> = new Set(['vendor_receipt', 'card_transaction']);
const OCR_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/**
 * Recognition for the confirmation screen — the contract is
 * shared/ocr-contract.ts. Deliberately a separate request from the upload
 * itself (app/api/v1/cases/[caseId]/documents/route.ts): running Vision
 * synchronously inside that upload request once left a production upload
 * stuck at 100% for many seconds on a real phone photo, with no distinct
 * progress indicator for the applicant. This endpoint is called afterward,
 * so the confirmation screen can show its own "正在辨識" state instead of
 * stalling the upload bar.
 *
 * Nothing here is persisted — recognized lines are returned once and
 * discarded, matching docs/2026-09-19-憑證比對自動化-開發企劃.md section 10.
 */
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime || !runtime.documentVault || !runtime.ocrEngine) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const { documentId } = await context.params;
  const document = getDocumentStorageForApplicant(runtime.database, { applicantId: session.applicantId }, documentId);
  if (!document || document.status !== 'ready') return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  if (!OCR_ELIGIBLE_REQUIREMENTS.has(document.requirementKey as DocumentRequirementKey) || !OCR_MEDIA_TYPES.has(document.mediaType)) {
    return toJsonResponse(apiSuccess<DocumentOcrResponseData>({ ocr: null }, requestId));
  }
  try {
    if (!(await runtime.ocrEngine.available())) return toJsonResponse(apiSuccess<DocumentOcrResponseData>({ ocr: null }, requestId));
    const bytes = runtime.documentVault.read({ id: document.id, storageId: document.storageId, keyId: document.keyId });
    const result = await runtime.ocrEngine.recognize({ bytes, mediaType: document.mediaType as OcrMediaType, languages: DEFAULT_OCR_LANGUAGES });
    return toJsonResponse(apiSuccess<DocumentOcrResponseData>({ ocr: { lines: result.lines, engineId: result.engineId, durationMs: result.durationMs } }, requestId));
  } catch {
    // Best-effort: the confirmation screen falls back to manual entry.
    return toJsonResponse(apiSuccess<DocumentOcrResponseData>({ ocr: null }, requestId));
  }
}
