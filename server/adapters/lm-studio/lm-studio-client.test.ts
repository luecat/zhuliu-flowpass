import { describe, expect, it, vi } from 'vitest';
import { LmStudioClient, LmStudioError } from './lm-studio-client';

const output = { choices: [{ message: { content: '{"passport_draft":{}}' } }], model: 'fixture', usage: { prompt_tokens: 3, completion_tokens: 4 } };

describe('LmStudioClient', () => {
  it('sends the fixed non-streaming constrained JSON request', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => { init = request; return new Response(JSON.stringify(output), { status: 200 }); });
    const client = new LmStudioClient({ modelId: 'fixture-model', token: 'secret', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', fetchImpl });
    await client.complete({ systemInstruction: 'fixed', inputEnvelope: { answer: 'synthetic' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('fixture-model');
    expect(body.temperature).toBe(0.1);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format.json_schema.name).toBe('flowpass_passport');
    expect(body.messages[1].content).toContain('synthetic');
  });

  it('fails closed without an auth token and redacts transport errors', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('secret-token leaked'); });
    await expect(new LmStudioClient({ modelId: 'fixture', token: null, fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} })).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' });
    const error = await new LmStudioClient({ modelId: 'fixture', token: 'secret', fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} }).catch((value) => value as LmStudioError);
    expect(error).toBeInstanceOf(LmStudioError);
    expect((error as LmStudioError).message).not.toContain('secret-token');
  });

  it('retries one 429 and maps a second failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    await expect(new LmStudioClient({ modelId: 'fixture', token: 'secret', fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} })).rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the five-second connect probe separate from model inference', async () => {
    const connectProbe = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify(output), { status: 200 });
    });
    const client = new LmStudioClient({
      modelId: 'fixture',
      token: 'secret',
      endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
      fetchImpl,
      connectProbe,
      connectTimeoutMs: 5,
      overallTimeoutMs: 100,
    });
    await expect(client.complete({ systemInstruction: 'x', inputEnvelope: {} })).resolves.toMatchObject({ content: output.choices[0].message.content });
    expect(connectProbe).toHaveBeenCalledTimes(1);
  });

  it('rejects non-loopback endpoints even when a test transport is injected', () => {
    expect(() => new LmStudioClient({ modelId: 'fixture', token: 'secret', endpoint: 'https://example.invalid/v1/chat/completions', fetchImpl: vi.fn() })).toThrow('loopback');
  });
});
