// @vitest-environment node
// The suite defaults to jsdom for the admin React components; the Anthropic SDK
// refuses to construct in a browser-like environment to keep API keys off the
// client, and the worker that owns this adapter is a Node process.
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, ANTHROPIC_DEFAULT_EFFORT, anthropicEffort } from './anthropic-client';
import { LmStudioError } from '../lm-studio/lm-studio-client';

interface RequestBody {
  model: string;
  system: string;
  thinking: { type: string };
  output_config: { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
  messages: Array<{ role: string; content: string }>;
}

function messageResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"passport_draft":{}}' }],
    usage: { input_tokens: 11, output_tokens: 22 },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('AnthropicClient', () => {
  it('sends the passport schema as a structured output format', async () => {
    let body: RequestBody | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      body = JSON.parse(String(request?.body)) as RequestBody;
      return messageResponse();
    });
    const client = new AnthropicClient({ apiKey: 'test-key', modelId: 'claude-sonnet-5', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.complete({ systemInstruction: 'fixed', inputEnvelope: { answer: 'synthetic' } });

    const payload = body as RequestBody;
    expect(payload.model).toBe('claude-sonnet-5');
    expect(payload.system).toBe('fixed');
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.output_config.effort).toBe(ANTHROPIC_DEFAULT_EFFORT);
    expect(payload.output_config.format.type).toBe('json_schema');
    expect(payload.output_config.format.schema.properties.passport_draft).toBeDefined();
    expect(JSON.parse(payload.messages[0].content)).toEqual({ originalInput: { answer: 'synthetic' } });
    expect(result).toEqual({ content: '{"passport_draft":{}}', model: 'claude-sonnet-5', inputTokens: 11, outputTokens: 22 });
  });

  it('includes the original answers when asking the model to rewrite invalid output', async () => {
    let body: RequestBody | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      body = JSON.parse(String(request?.body)) as RequestBody;
      return messageResponse();
    });
    const client = new AnthropicClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.complete({
      systemInstruction: 'fixed',
      inputEnvelope: { answer: 'synthetic' },
      repairIssues: [{ path: 'passport_draft' }],
      invalidStructure: { passport_draft: null },
    });
    const payload = body as RequestBody;
    expect(JSON.parse(payload.messages[0].content)).toEqual({
      originalInput: { answer: 'synthetic' },
      validationIssues: [{ path: 'passport_draft' }],
      invalidStructure: { passport_draft: null },
    });
  });

  it('reports a refusal as unsafe output instead of returning empty content', async () => {
    const fetchImpl = vi.fn(async () => messageResponse({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
      content: [],
    }));
    const client = new AnthropicClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.complete({ systemInstruction: 'fixed', inputEnvelope: {} }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_UNSAFE' });
  });

  it('rejects a truncated response before the handler spends a repair round trip', async () => {
    const fetchImpl = vi.fn(async () => messageResponse({ stop_reason: 'max_tokens' }));
    const client = new AnthropicClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.complete({ systemInstruction: 'fixed', inputEnvelope: {} }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('maps an authentication failure onto the shared model error contract', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new AnthropicClient({ apiKey: 'test-key', maxRetries: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const error = await client.complete({ systemInstruction: 'fixed', inputEnvelope: {} }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LmStudioError);
    expect((error as LmStudioError).code).toBe('MODEL_AUTH_FAILED');
  });

  it('maps a rate limit onto the retryable model error code', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new AnthropicClient({ apiKey: 'test-key', maxRetries: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.complete({ systemInstruction: 'fixed', inputEnvelope: {} }))
      .rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED' });
  });

  it('requires an API key', () => {
    expect(() => new AnthropicClient({ apiKey: '  ' })).toThrow('Anthropic API key is required');
  });

  it('falls back to the default effort for an unknown override', () => {
    expect(anthropicEffort('xhigh')).toBe('xhigh');
    expect(anthropicEffort('LOW')).toBe('low');
    expect(anthropicEffort('turbo')).toBe(ANTHROPIC_DEFAULT_EFFORT);
    expect(anthropicEffort(undefined)).toBe(ANTHROPIC_DEFAULT_EFFORT);
  });
});
