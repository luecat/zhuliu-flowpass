import { Hono } from 'hono';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, authenticateAdmin, verifyAdminCsrf } from '../auth/admin-session';
import { createSecurityIncidentService, SecurityIncidentError } from '../../services/security-incident-service';

function cookie(value: string | undefined, name: string): string | null {
  return value?.split(';').map((part) => part.trim()).map((part) => part.split('=')).find(([key]) => key === name)?.slice(1).join('=') ?? null;
}

function auth(context: { req: { header(name: string): string | undefined } }, database: FlowPassDatabase) {
  const session = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
  if (!session) return { session: null, error: 'UNAUTHENTICATED' as const };
  const host = context.req.header('host');
  if ((host && host.split(':')[0] !== '127.0.0.1') || context.req.header('origin') !== 'http://127.0.0.1:38101' || !verifyAdminCsrf(cookie(context.req.header('cookie'), ADMIN_CSRF_COOKIE), session.csrfHash)) return { session: null, error: 'CSRF_FAILED' as const };
  return { session, error: null };
}

function statusFor(error: SecurityIncidentError): number {
  if (error.code === 'NOT_FOUND' || error.code === 'MATCH_NOT_FOUND') return 404;
  if (error.code === 'INVALID_STATE') return 409;
  return 400;
}

export function createIncidentRoutes(database: FlowPassDatabase, crypto: FieldCrypto) {
  const app = new Hono();
  app.post('/admin/v1/incidents', async (context) => {
    const session = auth(context, database);
    if (!session.session) return context.json({ error: { code: session.error } }, session.error === 'UNAUTHENTICATED' ? 401 : 403);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    try {
      const result = createSecurityIncidentService({ database, crypto }).createIncident({ ...body, adminId: session.session.adminId } as never);
      return context.json({ data: result }, 201);
    } catch (error) {
      if (error instanceof SecurityIncidentError) return context.json({ error: { code: error.code } }, statusFor(error) as never);
      return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  });
  app.post('/admin/v1/incidents/:incidentId/preview-matches', (context) => {
    const session = auth(context, database);
    if (!session.session) return context.json({ error: { code: session.error } }, session.error === 'UNAUTHENTICATED' ? 401 : 403);
    try {
      const result = createSecurityIncidentService({ database, crypto }).previewMatches(context.req.param('incidentId'));
      return context.json({ data: result }, 200);
    } catch (error) {
      if (error instanceof SecurityIncidentError) return context.json({ error: { code: error.code } }, statusFor(error) as never);
      return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  });
  app.post('/admin/v1/incidents/:incidentId/confirm-alerts', async (context) => {
    const session = auth(context, database);
    if (!session.session) return context.json({ error: { code: session.error } }, session.error === 'UNAUTHENTICATED' ? 401 : 403);
    const body = await context.req.json().catch(() => null) as { matches?: unknown } | null;
    if (!body || !Array.isArray(body.matches)) return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    try {
      const result = createSecurityIncidentService({ database, crypto }).confirmAlerts({ incidentId: context.req.param('incidentId'), adminId: session.session.adminId, matches: body.matches as never });
      return context.json({ data: result }, 201);
    } catch (error) {
      if (error instanceof SecurityIncidentError) return context.json({ error: { code: error.code } }, statusFor(error) as never);
      return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  });
  return app;
}
