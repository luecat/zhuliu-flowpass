import { Hono } from 'hono';
import type { FlowPassDatabase } from '../db/connection';
import { verifyAdminPassword } from './auth/password';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession } from './auth/admin-session';
import { listAiRunsForAdmin } from '../db/repositories/ai-runs';
import { localReadiness } from '../services/health-service';
import type { FieldCrypto } from '../crypto/field-crypto';
import { createReviewRoutes } from './routes/reviews';
import { createProgramRoutes } from './routes/programs';
import { createIncidentRoutes } from './routes/incidents';
import { createToolRoutes } from './routes/tools';
import { serveStatic } from '@hono/node-server/serve-static';

export function createAdminApp(database?: FlowPassDatabase, dependencies?: { crypto?: FieldCrypto }) {
  const app = new Hono();

  app.use('*', async (context, next) => {
    await next();
    context.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (context) =>
    context.json({
      status: 'ok',
      dependencies: { database: 'pending', keychain: 'pending' },
    }),
  );
  app.get('/readyz', (context) => { if (!database) return context.json({ ready: false, database: 'unavailable', vault: 'unavailable', migrations: 'unavailable' }, 503); const result = localReadiness(database); return context.json(result, result.ready ? 200 : 503); });

  app.post('/admin/v1/sessions', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    const host = context.req.header('host');
    if (host && host.split(':')[0] !== '127.0.0.1') return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    if (context.req.header('origin') !== 'http://127.0.0.1:38101') return context.json({ error: { code: 'CSRF_FAILED' } }, 403);
    const body = await context.req.json().catch(() => null) as { displayName?: string; password?: string } | null;
    if (!body?.displayName || !body.password) return context.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    const row = database.prepare('SELECT id, password_hash FROM admin_users WHERE display_name = ? AND status = \'active\'').get(body.displayName) as { id: string; password_hash: string } | undefined;
    if (!row || !verifyAdminPassword(body.password, row.password_hash)) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    const session = createAdminSession(database, row.id);
    const response = context.json({ data: { expiresAt: session.expiresAt } }, 201);
    response.headers.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    response.headers.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=${session.csrf}; SameSite=Strict; Path=/; Max-Age=28800`);
    return response;
  });
  app.get('/admin/v1/cases', (context) => { if (!database) return context.json({ error: { code: 'UNAVAILABLE' } }, 503); const auth = authenticateAdmin(database, context.req.header('cookie')?.match(new RegExp(`${ADMIN_SESSION_COOKIE}=([^;]+)`))?.[1] ?? null); if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401); const rows = database.prepare(`SELECT id, case_code, state, submitted_at, updated_at, row_version FROM cases ORDER BY updated_at DESC`).all(); return context.json({ data: { cases: rows } }); });
  app.get('/admin/v1/cases/:caseId/audit', (context) => { if (!database) return context.json({ error: { code: 'UNAVAILABLE' } }, 503); const auth = authenticateAdmin(database, context.req.header('cookie')?.match(new RegExp(`${ADMIN_SESSION_COOKIE}=([^;]+)`))?.[1] ?? null); if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401); const caseId = context.req.param('caseId'); return context.json({ data: { aiRuns: listAiRunsForAdmin(database, { adminId: auth.adminId }, caseId) } }); });

  if (database && dependencies?.crypto) app.route('/', createReviewRoutes(database, dependencies.crypto));
  if (database) app.route('/', createProgramRoutes(database));
  if (database && dependencies?.crypto) app.route('/', createIncidentRoutes(database, dependencies.crypto));
  if (database) app.route('/', createToolRoutes(database, dependencies?.crypto));

  // The admin bundle is built separately and served only by this loopback Hono
  // process; the public Next app never receives these assets.
  app.get('/', serveStatic({ root: './dist/admin', path: 'index.html' }));
  app.use('/assets/*', serveStatic({ root: './dist/admin' }));

  return app;
}
