import { describe, expect, it } from 'vitest';
import { createWorkerApp, type WorkerDependencyStatus } from './app';

describe('createWorkerApp', () => {
  it('exposes worker dependency health', async () => {
    const response = await createWorkerApp().request('http://127.0.0.1/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      dependencies: { queue: 'unavailable', lmStudio: 'pending', ocr: 'pending', lineNotification: 'pending', processing: 'disabled' },
      concurrency: { ai: 1, ocr: 1, lineNotification: 4 },
    });
  });

  it('reports mutable runtime dependencies without leaking credentials', async () => {
    const dependencies: WorkerDependencyStatus = {
      lmStudio: 'ready',
      ocr: 'disabled',
      lineNotification: 'ready',
      processing: 'ready',
    };
    const app = createWorkerApp(undefined, dependencies);
    dependencies.lmStudio = 'failed';
    const body = await (await app.request('http://127.0.0.1/healthz')).json();
    expect(body.dependencies).toMatchObject({ lmStudio: 'failed', lineNotification: 'ready' });
    expect(JSON.stringify(body)).not.toContain('token');
  });
});
