import { describe, expect, it } from 'vitest';
import { createWorkerApp } from './app';

describe('createWorkerApp', () => {
  it('exposes worker dependency health', async () => {
    const response = await createWorkerApp().request('http://127.0.0.1/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      dependencies: { queue: 'ready', lmStudio: 'pending', ocr: 'pending' },
      concurrency: { ai: 1, ocr: 1, lineNotification: 4 },
    });
  });
});
