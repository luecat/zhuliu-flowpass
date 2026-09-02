import { describe, expect, it, vi } from 'vitest';
import { PASSPORT_GENERATION_JSON_SCHEMA } from '../../../shared/passport-contract';
import { LmStudioError } from '../lm-studio/lm-studio-client';
import { GeminiClient } from './gemini-client';

const ok = { choices: [{ finish_reason: 'stop', message: { content: '{"passport_draft":{}}' } }], model: 'gemini-fixture', usage: { prompt_tokens: 3, completion_tokens: 4 } };

function stubFetch(...responses: Response[]) {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return responses[Math.min(bodies.length - 1, responses.length - 1)];
  });
  return { fetchImpl, bodies };
}

const base = { modelId: 'gemini-fixture', apiKey: 'test-key', sleep: async () => {} };

describe('GeminiClient', () => {
  it('uses plain JSON mode with the schema in the prompt, and never pays for a rejected strict call', async () => {
    const { fetchImpl, bodies } = stubFetch(new Response(JSON.stringify(ok), { status: 200 }));
    const client = new GeminiClient({ ...base, fetchImpl });
    await client.complete({ systemInstruction: 'fixed', inputEnvelope: { answer: 'synthetic' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(bodies[0]!);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain(JSON.stringify(PASSPORT_GENERATION_JSON_SCHEMA));
    expect(JSON.parse(body.messages[1].content)).toEqual({ originalInput: { answer: 'synthetic' } });
  });

  it('degrades to JSON mode when the endpoint refuses the strict schema with a bare INVALID_ARGUMENT', async () => {
    const { fetchImpl, bodies } = stubFetch(
      new Response('{"error":{"code":400,"message":"Request contains an invalid argument."}}', { status: 400 }),
      new Response(JSON.stringify(ok), { status: 200 }),
    );
    const client = new GeminiClient({ ...base, strictSchema: true, fetchImpl });
    await expect(client.complete({ systemInstruction: 'x', inputEnvelope: {} })).resolves.toMatchObject({ content: '{"passport_draft":{}}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(bodies[0]!).response_format.type).toBe('json_schema');
    expect(JSON.parse(bodies[1]!).response_format).toEqual({ type: 'json_object' });
  });

  it('remembers the rejection and stops trying strict mode on later calls', async () => {
    const responses = [
      new Response('{"error":{"code":400,"message":"Request contains an invalid argument."}}', { status: 400 }),
      new Response(JSON.stringify(ok), { status: 200 }),
      new Response(JSON.stringify(ok), { status: 200 }),
    ];
    let index = 0;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return responses[index++]!;
    });
    const client = new GeminiClient({ ...base, strictSchema: true, fetchImpl });
    await client.complete({ systemInstruction: 'x', inputEnvelope: {} });
    await client.complete({ systemInstruction: 'x', inputEnvelope: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(bodies[0]!).response_format.type).toBe('json_schema');
    expect(JSON.parse(bodies[1]!).response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(bodies[2]!).response_format).toEqual({ type: 'json_object' });
  });

  it('fails fast when the answer was truncated at max_tokens', async () => {
    const truncated = { choices: [{ finish_reason: 'length', message: { content: '{"passport_draft":{' } }] };
    const { fetchImpl } = stubFetch(new Response(JSON.stringify(truncated), { status: 200 }));
    const error = await new GeminiClient({ ...base, fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} }).catch((value: unknown) => value as LmStudioError);
    expect(error).toBeInstanceOf(LmStudioError);
    expect((error as LmStudioError).code).toBe('AI_OUTPUT_INVALID');
    expect((error as LmStudioError).message).toContain('truncated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the http status and detail for a 4xx so logs can explain the failure', async () => {
    const { fetchImpl } = stubFetch(new Response('{"error":{"message":"API key not valid. Please pass a valid API key."}}', { status: 401 }));
    const error = await new GeminiClient({ ...base, fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} }).catch((value: unknown) => value as LmStudioError);
    expect((error as LmStudioError).code).toBe('MODEL_AUTH_FAILED');
    expect((error as LmStudioError).message).toContain('gemini http 401');
    expect((error as LmStudioError).message).not.toContain(base.apiKey);
  });

  it('retries a 429 once and reports the rate limit', async () => {
    const { fetchImpl } = stubFetch(new Response('', { status: 429 }));
    await expect(new GeminiClient({ ...base, fetchImpl }).complete({ systemInstruction: 'x', inputEnvelope: {} }))
      .rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
