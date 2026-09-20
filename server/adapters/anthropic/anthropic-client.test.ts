// @vitest-environment node
// The suite defaults to jsdom for the admin React components; the Anthropic SDK
// refuses to construct in a browser-like environment to keep API keys off the
// client, and the worker that owns this adapter is a Node process.
import { describe, expect, it, vi } from 'vitest';
import { PASSPORT_GENERATION_JSON_SCHEMA } from '../../../shared/passport-contract';
import { AnthropicClient, ANTHROPIC_DEFAULT_EFFORT, anthropicEffort, jsonSchemaForAnthropic } from './anthropic-client';
import { LmStudioError } from '../lm-studio/lm-studio-client';

interface RequestBody {
  model: string;
  system: string;
  max_tokens: number;
  thinking: { type: string };
  output_config: { effort?: string; format: { type: string; schema: Record<string, unknown> } };
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
  it('does not send the full passport schema as structured output', async () => {
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
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.output_config).toBeUndefined();
    expect(payload.max_tokens).toBe(8192);
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

  it('adds a type to typeless enums so the SDK transform can accept the passport schema', () => {
    expect(jsonSchemaForAnthropic({
      type: 'object',
      properties: { status: { const: 'required_confirmation' } },
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string', description: '{enum: ["required_confirmation"]}' } },
    });
  });

  it('turns a nullable enum into anyOf string|null', () => {
    const schema = jsonSchemaForAnthropic({
      type: 'object',
      properties: { data_category: { enum: ['photo', null] } },
    });
    expect(schema.properties).toEqual({
      data_category: {
        anyOf: [
          { type: 'string', description: '{enum: ["photo"]}' },
          { type: 'null' },
        ],
      },
    });
  });

  it('normalizes the passport generation schema without throwing', () => {
    const schema = jsonSchemaForAnthropic(PASSPORT_GENERATION_JSON_SCHEMA as Record<string, unknown>);
    expect(schema.type).toBe('object');
    const nodes = (schema.properties as { passport_draft: { properties: { nodes: { items: { properties: { kind: { type: string } } } } } } }).passport_draft.properties.nodes.items.properties;
    expect(nodes.kind.type).toBe('string');
  });

  it('disables thinking for the three-way screening schema', async () => {
    let body: RequestBody | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      body = JSON.parse(String(request?.body)) as RequestBody;
      return messageResponse({ content: [{ type: 'text', text: '{"verdict":"genuine"}' }] });
    });
    const client = new AnthropicClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.complete({
      systemInstruction: 'screen',
      inputEnvelope: { answers: {} },
      responseSchema: { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { enum: ['genuine'] } } },
    });
    expect(body?.thinking).toEqual({ type: 'disabled' });
    expect(body?.output_config.effort).toBeUndefined();
    expect(body?.max_tokens).toBe(1024);
  });

  it('uses the last text block so thinking summaries cannot replace the JSON', async () => {
    const fetchImpl = vi.fn(async () => messageResponse({
      content: [
        { type: 'thinking', thinking: 'example {"verdict":"off_topic"}' },
        { type: 'text', text: 'ignored preamble' },
        { type: 'text', text: '{"passport_draft":{}}' },
      ],
    }));
    const client = new AnthropicClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.complete({ systemInstruction: 'fixed', inputEnvelope: {} });
    expect(result.content).toBe('{"passport_draft":{}}');
  });

  it('maps a schema rejection onto retryable invalid output, not terminal invalid input', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'const is not supported' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new AnthropicClient({ apiKey: 'test-key', maxRetries: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.complete({ systemInstruction: 'fixed', inputEnvelope: {} }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
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
