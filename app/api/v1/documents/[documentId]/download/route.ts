import { ApiErrorCode, apiFailure, toJsonResponse } from '../../../../../../shared/api-contract';
import { getDocumentStorageForApplicant } from '../../../../../../server/db/repositories/documents';
import { getPublicRuntime } from '../../../../../../server/public/runtime';

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }): Promise<Response> {
  const runtime = getPublicRuntime();
  const requestId = runtime?.requestIdGenerator?.() ?? crypto.randomUUID();
  if (!runtime || !runtime.documentVault) return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  const session = runtime.lineSessions.authenticateApplicant(cookie(request, 'flowpass_session'));
  if (!session) return toJsonResponse(apiFailure(ApiErrorCode.UNAUTHENTICATED, requestId));
  const { documentId } = await context.params;
  const document = getDocumentStorageForApplicant(runtime.database, { applicantId: session.applicantId }, documentId);
  if (!document || document.status === 'deleted' || document.status !== 'ready') return toJsonResponse(apiFailure(ApiErrorCode.NOT_FOUND, requestId));
  try {
    const bytes = runtime.documentVault.read({ id: document.id, storageId: document.storageId, keyId: document.keyId });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': document.mediaType,
        'Content-Disposition': 'attachment; filename="flowpass-document"',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return toJsonResponse(apiFailure(ApiErrorCode.DEPENDENCY_UNAVAILABLE, requestId));
  }
}
