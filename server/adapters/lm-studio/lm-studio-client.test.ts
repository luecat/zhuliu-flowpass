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
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('oneOf');
    expect(body.response_format.json_schema.schema.properties.passport_draft.properties.follow_up_questions.items.properties.answerSchema.properties.type.enum).toEqual([
      'text',
      'single_choice',
      'multi_choice',
      'boolean',
    ]);
    expect(body.messages[1].content).toContain('synthetic');
    expect(JSON.parse(body.messages[1].content)).toEqual({ originalInput: { answer: 'synthetic' } });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
    expect(init?.redirect).toBe('error');
  });

  it('includes the original answers when asking the model to rewrite invalid output', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => { init = request; return new Response(JSON.stringify(output), { status: 200 }); });
    const client = new LmStudioClient({ modelId: 'fixture-model', token: null, fetchImpl });
    await client.complete({
      systemInstruction: 'fixed',
      inputEnvelope: { userInputs: { material: '照片' } },
      repairIssues: [{ code: 'invalid-node' }],
      invalidStructure: { passport_draft: {} },
    });
    const body = JSON.parse(String(init?.body));
    const rewrite = JSON.parse(body.messages[1].content);
    expect(rewrite.originalInput.userInputs.material).toBe('照片');
    expect(rewrite.validationIssues).toEqual([{ code: 'invalid-node' }]);
    expect(rewrite.invalidStructure).toEqual({ passport_draft: {} });
  });

  it('allows a tokenless local API and redacts transport errors', async () => {
    let tokenlessInit: RequestInit | undefined;
    const tokenlessFetch = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      tokenlessInit = request;
      return new Response(JSON.stringify(output), { status: 200 });
    });
    await expect(new LmStudioClient({ modelId: 'fixture', token: null, endpoint: 'http://localhost:1234/v1/chat/completions', fetchImpl: tokenlessFetch }).complete({ systemInstruction: 'x', inputEnvelope: {} })).resolves.toMatchObject({ content: output.choices[0].message.content });
    expect(new Headers(tokenlessInit?.headers).has('authorization')).toBe(false);

    const fetchImpl = vi.fn(async () => { throw new Error('secret-token leaked'); });
    const error = await new LmStudioClient({ modelId: 'fixture', token: 'secret', fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} }).catch((value) => value as LmStudioError);
    expect(error).toBeInstanceOf(LmStudioError);
    expect((error as LmStudioError).message).not.toContain('secret-token');
  });

  it('reports a rejected structured-output request without claiming the local model is offline', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }));
    await expect(new LmStudioClient({ modelId: 'fixture', token: null, fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
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
    expect(() => new LmStudioClient({ modelId: 'fixture', token: 'secret', endpoint: 'http://localhost:1234/other', fetchImpl: vi.fn() })).toThrow('loopback');
  });
});
