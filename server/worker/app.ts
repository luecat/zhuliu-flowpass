import { Hono } from 'hono';
import type { FlowPassDatabase } from '../db/connection';
import { localReadiness } from '../services/health-service';

export function createWorkerApp(database?: FlowPassDatabase) {
  const app = new Hono();

  app.get('/healthz', (context) =>
    context.json({
      status: 'ok',
      dependencies: { queue: 'ready', lmStudio: 'pending', ocr: 'pending' },
      concurrency: { ai: 1, ocr: 1, lineNotification: 4 },
    }),
  );
  app.get('/readyz', (context) => { if (!database) return context.json({ ready: false, queue: 'unavailable' }, 503); const result = localReadiness(database); return context.json({ ready: result.ready, queue: result.ready ? 'ready' : 'failed', lmStudio: 'pending', ocr: 'pending' }, result.ready ? 200 : 503); });

  return app;
}
