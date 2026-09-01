import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, authenticateAdmin, verifyAdminCsrf } from '../auth/admin-session';
import { AdminReviewError, createAdminReviewService, type AdminReviewDecision } from '../../services/admin-review-service';
import type { CaseState, CaseTransitionAction } from '../../domain/case-state-machine';

function cookie(value: string | undefined, name: string): string | null {
  return value?.split(';').map((part) => part.trim()).map((part) => part.split('=')).find(([key]) => key === name)?.slice(1).join('=') ?? null;
}

function statusFor(error: AdminReviewError): 400 | 401 | 404 | 409 {
  if (error.code === 'UNAUTHENTICATED') return 401;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'ETAG_MISMATCH' || error.code === 'IDEMPOTENCY_KEY_REUSED' || error.code === 'INVALID_STATE' || error.code === 'FORBIDDEN_TRANSITION') return 409;
  return 400;
}

const COMMANDS: Record<string, { action: CaseTransitionAction; toState: CaseState }> = {
  start: { action: 'start_review', toState: 'under_review' },
  'start-review': { action: 'start_review', toState: 'under_review' },
  'request-documents': { action: 'request_documents', toState: 'awaiting_documents' },
  'return-correction': { action: 'return_correction', toState: 'returned_for_correction' },
  approve: { action: 'approve', toState: 'approved' },
  reject: { action: 'reject', toState: 'rejected' },
  'awaiting-disbursement': { action: 'await_disbursement', toState: 'awaiting_disbursement' },
  disburse: { action: 'disburse', toState: 'disbursed' },
  close: { action: 'close', toState: 'closed' },
};

function safeResult(result: ReturnType<ReturnType<typeof createAdminReviewService>['decide']>) {
  return {
    case: {
      id: result.case.id,
      caseCode: result.case.caseCode,
      state: result.case.state,
      requestedAmountTwd: result.case.requestedAmountTwd,
      calculatedAmountTwd: result.case.calculatedAmountTwd,
      approvedAmountTwd: result.case.approvedAmountTwd,
      disbursedAmountTwd: result.case.disbursedAmountTwd,
      submittedAt: result.case.submittedAt,
      closedAt: result.case.closedAt,
      updatedAt: result.case.updatedAt,
      rowVersion: result.case.rowVersion,
    },
    transition: result.transition,
    taskIds: result.taskIds,
    notificationJobId: result.notificationJobId,
  };
}

export function createReviewRoutes(database: FlowPassDatabase, crypto: FieldCrypto): Hono {
  const app = new Hono();

  async function handle(context: Context, command: { action: CaseTransitionAction; toState: CaseState } | null) {
    const auth = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    const csrfCookie = cookie(context.req.header('cookie'), ADMIN_CSRF_COOKIE);
    const csrfHeader = context.req.header('x-csrf-token');
    if (!['http://127.0.0.1:38101', 'https://admin.luecat.com'].includes(context.req.header('origin') ?? '') || !csrfCookie || !csrfHeader || csrfCookie !== csrfHeader || !verifyAdminCsrf(csrfHeader, auth.csrfHash)) {
      return context.json({ error: { code: 'CSRF_FAILED' } }, 403);
    }
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body)) return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    const selected = command ?? (typeof body.action === 'string' && typeof body.toState === 'string' ? { action: body.action as CaseTransitionAction, toState: body.toState as CaseState } : null);
    if (!selected) return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    const supplement = body.title !== undefined || body.instructions !== undefined || body.acceptedTypes !== undefined || body.dueAt !== undefined
      ? {
          title: typeof body.title === 'string' ? body.title : '',
          instructions: typeof body.instructions === 'string' ? body.instructions : '',
          acceptedDocumentTypes: Array.isArray(body.acceptedTypes) ? body.acceptedTypes.filter((value): value is string => typeof value === 'string') : [],
          dueAt: typeof body.dueAt === 'string' ? body.dueAt : null,
          passportReconfirmationRequired: body.passportReconfirmationRequired === true,
        }
      : undefined;
    const input: AdminReviewDecision = {
      adminId: auth.adminId,
      caseId: context.req.param('caseId') ?? '',
      ifMatch: context.req.header('if-match') ?? '',
      idempotencyKey: context.req.header('idempotency-key') ?? '',
      action: selected.action,
      toState: selected.toState,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      approvedAmountTwd: typeof body.approvedAmountTwd === 'number' ? body.approvedAmountTwd : undefined,
      disbursedAmountTwd: typeof body.disbursedAmountTwd === 'number' ? body.disbursedAmountTwd : undefined,
      overrideReason: typeof body.overrideReason === 'string' ? body.overrideReason : undefined,
      passportVersionId: typeof body.passportVersionId === 'string' ? body.passportVersionId : null,
      supplement,
    };
    try {
      const result = createAdminReviewService({ database, crypto }).decide(input);
      const safe = safeResult(result);
      const response = context.json({ data: safe, meta: { etag: `"${result.case.rowVersion}"` } }, 201);
      response.headers.set('ETag', `"${result.case.rowVersion}"`);
      return response;
    } catch (error) {
      if (error instanceof AdminReviewError) return context.json({ error: { code: error.code, message: error.message } }, statusFor(error));
      return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  }

  app.post('/admin/v1/cases/:caseId/review', (context) => handle(context, null));
  for (const [command, transition] of Object.entries(COMMANDS)) {
    app.post(`/admin/v1/cases/:caseId/review/${command}`, (context) => handle(context, transition));
  }
  return app;
}
