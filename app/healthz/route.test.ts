import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /healthz', () => {
  it('returns the public listener health payload', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
