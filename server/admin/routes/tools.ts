import { Hono } from 'hono';
import type { FlowPassDatabase } from '../../db/connection';
import { listToolProductsForAdmin, listToolVersionsForAdmin } from '../../db/repositories/tools';
import { ADMIN_SESSION_COOKIE, authenticateAdmin } from '../auth/admin-session';

function cookie(value: string | undefined, name: string): string | null {
  return value?.split(';').map((part) => part.trim()).map((part) => part.split('=')).find(([key]) => key === name)?.slice(1).join('=') ?? null;
}

export function createToolRoutes(database: FlowPassDatabase, crypto?: unknown): Hono {
  void crypto;
  const app = new Hono();
  app.get('/admin/v1/tools', (context) => {
    const session = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!session) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    return context.json({ data: { tools: listToolProductsForAdmin(database, { adminId: session.adminId }) } });
  });
  app.get('/admin/v1/tools/:toolProductId/versions', (context) => {
    const session = authenticateAdmin(database, cookie(context.req.header('cookie'), ADMIN_SESSION_COOKIE));
    if (!session) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    return context.json({ data: { versions: listToolVersionsForAdmin(database, { adminId: session.adminId }, context.req.param('toolProductId')) } });
  });
  return app;
}
