import { describe, expect, it, vi } from 'vitest';
import { ensureModelRuntime } from './model-runtime';

describe('ensureModelRuntime', () => {
  it('starts a loopback server and loads the configured model identifier', async () => {
    const calls: string[][] = [];
    const execRunner = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'server' && args[1] === 'status') throw new Error('offline');
    });
    let loaded = false;
    execRunner.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'server' && args[1] === 'status') throw new Error('offline');
      if (args[0] === 'load') loaded = true;
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: loaded ? [{ id: 'qwen3.8-9b-distill' }] : [] })));
    await expect(ensureModelRuntime({ execRunner, fetchImpl })).resolves.toEqual({ ok: true, modelId: 'qwen3.8-9b-distill', status: 'ready' });
    expect(calls).toContainEqual(['server', 'start', '--bind', '127.0.0.1', '--port', '1234']);
    expect(calls).toContainEqual(['load', 'qwen3.8-9b-distill', '--identifier', 'qwen3.8-9b-distill', '--parallel', '1', '-y']);
  });
});
