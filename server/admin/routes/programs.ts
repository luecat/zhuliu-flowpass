import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../../db/connection';
import {
  createDraftProgramRuleVersionForAdmin,
  listProgramCyclesForAdmin,
  listProgramRuleVersionsForAdmin,
  publishProgramRuleVersionForAdmin,
} from '../../db/repositories/programs';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, authenticateAdmin, verifyAdminCsrf } from '../auth/admin-session';
import {
  applyProgramRuleSettings,
  normalizeProgramRuleSettings,
  readProgramRuleSettings,
} from '../../domain/program-rules-config';

function cookie(value: string | undefined, name: string): string | null {
  return value?.split(';').map((part) => part.trim()).map((part) => part.split('=')).find(([key]) => key === name)?.slice(1).join('=') ?? null;
}

function authorized(database: FlowPassDatabase, context: { req: { header(name: string): string | undefined } }) {
  const auth = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
  if (!auth) return { error: 'UNAUTHENTICATED' as const };
  const csrfCookie = cookie(context.req.header('cookie'), ADMIN_CSRF_COOKIE);
  const csrfHeader = context.req.header('x-csrf-token');
  if (!['http://127.0.0.1:38101', 'https://admin.luecat.com'].includes(context.req.header('origin') ?? '') || !csrfCookie || csrfCookie !== csrfHeader || !verifyAdminCsrf(csrfHeader, auth.csrfHash)) {
    return { error: 'CSRF_FAILED' as const };
  }
  return { auth };
}

/**
 * A case pins the highest-version published rule at creation time (see
 * case-service), so that row is the one the settings screen reads and edits.
 */
function currentPublishedRule(database: FlowPassDatabase, adminId: string, cycleId: string) {
  return listProgramRuleVersionsForAdmin(database, { adminId }, cycleId).find((rule) => rule.status === 'published');
}

export function createProgramRoutes(database: FlowPassDatabase): Hono {
  const app = new Hono();

  app.get('/admin/v1/program-cycles', (context) => {
    const auth = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    return context.json({ data: { cycles: listProgramCyclesForAdmin(database, { adminId: auth.adminId }) } });
  });

  app.get('/admin/v1/program-cycles/:cycleId/rules', (context) => {
    const auth = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    return context.json({ data: { rules: listProgramRuleVersionsForAdmin(database, { adminId: auth.adminId }, context.req.param('cycleId')) } });
  });

  app.post('/admin/v1/program-cycles/:cycleId/rules/draft', async (context) => {
    const access = authorized(database, context);
    if ('error' in access) return context.json({ error: { code: access.error } }, access.error === 'UNAUTHENTICATED' ? 401 : 403);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.sourceRuleVersionId !== 'string') return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    try {
      const draft = createDraftProgramRuleVersionForAdmin(database, { adminId: access.auth.adminId }, {
        sourceRuleVersionId: body.sourceRuleVersionId,
        id: uuidv7(),
        createdAt: new Date().toISOString(),
        ...(typeof body.applicationStartAt === 'string' ? { applicationStartAt: body.applicationStartAt } : {}),
        ...(typeof body.applicationEndAt === 'string' ? { applicationEndAt: body.applicationEndAt } : {}),
        ...(typeof body.purchaseStartAt === 'string' ? { purchaseStartAt: body.purchaseStartAt } : {}),
        ...(typeof body.purchaseEndAt === 'string' ? { purchaseEndAt: body.purchaseEndAt } : {}),
        ...(Number.isSafeInteger(body.subsidyRateBps) ? { subsidyRateBps: body.subsidyRateBps as number } : {}),
        ...(Number.isSafeInteger(body.perCaseCapTwd) ? { perCaseCapTwd: body.perCaseCapTwd as number } : {}),
        ...(body.roundingMode === 'floor' || body.roundingMode === 'half_up' ? { roundingMode: body.roundingMode } : {}),
        ...(typeof body.requiredDocumentsJson === 'string' ? { requiredDocumentsJson: body.requiredDocumentsJson } : {}),
        ...(typeof body.rulesJson === 'string' ? { rulesJson: body.rulesJson } : {}),
      });
      return context.json({ data: draft }, 201);
    } catch {
      return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    }
  });

  app.post('/admin/v1/program-rules/:ruleVersionId/publish', (context) => {
    const access = authorized(database, context);
    if ('error' in access) return context.json({ error: { code: access.error } }, access.error === 'UNAUTHENTICATED' ? 401 : 403);
    try {
      const rule = publishProgramRuleVersionForAdmin(database, { adminId: access.auth.adminId }, {
        ruleVersionId: context.req.param('ruleVersionId'),
        adminId: access.auth.adminId,
        publishedAt: new Date().toISOString(),
      });
      return context.json({ data: rule }, 201);
    } catch {
      return context.json({ error: { code: 'INVALID_STATE' } }, 409);
    }
  });

  app.get('/admin/v1/program-cycles/:cycleId/settings', (context) => {
    const auth = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    const rule = currentPublishedRule(database, auth.adminId, context.req.param('cycleId'));
    if (!rule) return context.json({ error: { code: 'NOT_FOUND' } }, 404);
    return context.json({ data: { ruleVersionId: rule.id, versionNo: rule.versionNo, publishedAt: rule.publishedAt, settings: readProgramRuleSettings(rule.rulesJson) } });
  });

  /**
   * Published rule versions are immutable, so a settings save is a new version
   * rather than an update: the draft is created from the current published row
   * and published in the same transaction, leaving the previous settings intact
   * as an audit trail. Cases already created keep the rule version they pinned.
   */
  app.put('/admin/v1/program-cycles/:cycleId/settings', async (context) => {
    const access = authorized(database, context);
    if ('error' in access) return context.json({ error: { code: access.error } }, access.error === 'UNAUTHENTICATED' ? 401 : 403);
    const body = await context.req.json().catch(() => null) as unknown;
    const normalized = normalizeProgramRuleSettings(body);
    if (!normalized.ok) return context.json({ error: { code: 'INVALID_REQUEST', message: normalized.reason } }, 400);
    const scope = { adminId: access.auth.adminId };
    const source = currentPublishedRule(database, access.auth.adminId, context.req.param('cycleId'));
    if (!source) return context.json({ error: { code: 'NOT_FOUND' } }, 404);
    try {
      const published = database.transaction(() => {
        const draft = createDraftProgramRuleVersionForAdmin(database, scope, {
          sourceRuleVersionId: source.id,
          id: uuidv7(),
          createdAt: new Date().toISOString(),
          rulesJson: applyProgramRuleSettings(source.rulesJson, normalized.settings),
        });
        return publishProgramRuleVersionForAdmin(database, scope, { ruleVersionId: draft.id, adminId: access.auth.adminId, publishedAt: new Date().toISOString() });
      })();
      return context.json({ data: { ruleVersionId: published.id, versionNo: published.versionNo, publishedAt: published.publishedAt, settings: readProgramRuleSettings(published.rulesJson) } });
    } catch {
      return context.json({ error: { code: 'INVALID_STATE' } }, 409);
    }
  });

  return app;
}
