import { Hono } from 'hono';
import type { FlowPassDatabase } from '../db/connection';
import { localReadiness } from '../services/health-service';

export interface WorkerDependencyStatus {
  lmStudio: 'pending' | 'ready' | 'disabled' | 'failed';
  ocr: 'pending' | 'ready' | 'disabled' | 'failed';
  lineNotification: 'pending' | 'ready' | 'disabled' | 'failed';
  processing: 'disabled' | 'starting' | 'ready' | 'failed';
}

export const defaultWorkerDependencyStatus = (): WorkerDependencyStatus => ({
  lmStudio: 'pending',
  ocr: 'pending',
  lineNotification: 'pending',
  processing: process.env.FLOWPASS_WORKER_RUN === '1' ? 'starting' : 'disabled',
});

export function createWorkerApp(database?: FlowPassDatabase, dependencies = defaultWorkerDependencyStatus()) {
  const app = new Hono();

  app.get('/healthz', (context) =>
    context.json({
      status: 'ok',
      dependencies: { queue: database ? 'ready' : 'unavailable', ...dependencies },
      concurrency: { ai: 1, ocr: 1, lineNotification: 4 },
    }),
  );
  app.get('/readyz', (context) => {
    if (!database) return context.json({ ready: false, queue: 'unavailable', ...dependencies }, 503);
    const result = localReadiness(database);
    const processingReady = dependencies.processing === 'ready' || dependencies.processing === 'disabled';
    const ready = result.ready && processingReady;
    return context.json({ ready, queue: result.ready ? 'ready' : 'failed', ...dependencies }, ready ? 200 : 503);
  });

  return app;
}
