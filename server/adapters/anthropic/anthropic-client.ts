import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import Anthropic from '@anthropic-ai/sdk';
import { LmStudioError, type LmStudioInput, type LmStudioResult } from '../lm-studio/lm-studio-client';

export const ANTHROPIC_DEFAULT_MODEL_ID = 'claude-sonnet-5';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Kept for LaunchAgent env parsing; thinking is disabled so effort is not sent. */
export const ANTHROPIC_DEFAULT_EFFORT: AnthropicEffort = 'medium';

export function anthropicEffort(value: string | undefined): AnthropicEffort {
  const candidate = value?.trim().toLowerCase();
  return EFFORT_LEVELS.find((level) => level === candidate) ?? ANTHROPIC_DEFAULT_EFFORT;
}

export interface AnthropicClientOptions {
  apiKey: string;
  modelId?: string;
  effort?: AnthropicEffort;
  overallTimeoutMs?: number;
  maxRetries?: number;
  /** Test seam; production lets the SDK use the platform fetch. */
  fetchImpl?: typeof fetch;
}

/** A refusal is a decision about this input, so retrying the same envelope only burns quota. */
function isRefusal(stopReason: string | null): boolean {
  return stopReason === 'refusal';
}

function lastTextBlock(content: Anthropic.Message['content']): string {
  const texts = content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .filter((text) => text.trim());
  return texts.at(-1) ?? '';
}

function inferEnumType(values: readonly unknown[]): 'string' | 'number' | 'boolean' {
  const kinds = new Set(values.filter((value) => value !== null).map((value) => typeof value));
  if (kinds.size === 1 && kinds.has('boolean')) return 'boolean';
  if (kinds.size === 1 && kinds.has('number')) return 'number';
  return 'string';
}

/**
 * Anthropic structured outputs require every node to have `type` (or anyOf).
 * FlowPass's passport JSON Schema uses typeless `enum`/`const` and `enum`+null,
 * which the API rejects with 400 — the worker then records AI_OUTPUT_INVALID.
 */
export function jsonSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const record = { ...(value as Record<string, unknown>) };
    if (Object.hasOwn(record, 'const') && record.enum === undefined) record.enum = [record.const];
    delete record.const;
    if (Array.isArray(record.enum)) {
      const values = record.enum as unknown[];
      if (values.includes(null)) {
        const nonNull = values.filter((item) => item !== null);
        const rest = { ...record };
        delete rest.enum;
        delete rest.type;
        return walk({ ...rest, anyOf: [{ type: inferEnumType(nonNull), enum: nonNull }, { type: 'null' }] });
      }
      if (record.type === undefined) record.type = inferEnumType(values);
    }
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, walk(nested)]));
  };
  return jsonSchemaOutputFormat(walk(schema) as { type: 'object' }).schema as Record<string, unknown>;
}

function mapApiError(error: unknown): LmStudioError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LmStudioError('MODEL_AUTH_FAILED');
  }
  if (error instanceof Anthropic.NotFoundError) return new LmStudioError('MODEL_NOT_FOUND');
  if (error instanceof Anthropic.RateLimitError) return new LmStudioError('MODEL_RATE_LIMITED');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new LmStudioError('MODEL_TIMEOUT');
  if (error instanceof Anthropic.APIConnectionError) return new LmStudioError('MODEL_OFFLINE');
  if (error instanceof Anthropic.BadRequestError) {
    const detail = error.message.replace(/\s+/g, ' ').slice(0, 240);
    console.error(JSON.stringify({ source: 'anthropic', status: 400, detail }));
    // Only applicant-envelope size is "input too large". Schema/grammar 400s
    // contain "too"/"exceed" as well and must not look like the applicant's text.
    return new LmStudioError(/prompt is too long|input is too long|request too large/i.test(error.message) ? 'AI_INPUT_TOO_LARGE' : 'AI_OUTPUT_INVALID');
  }
  if (error instanceof Anthropic.APIError) return new LmStudioError('MODEL_OFFLINE', `Anthropic API error ${error.status ?? 'unknown'}`);
  return new LmStudioError('MODEL_OFFLINE');
}

/**
 * Speaks the same `complete()` contract as the local LM Studio client so the
 * worker can swap providers without the passport handler knowing which one ran.
 */
export class AnthropicClient {
  private readonly client: Anthropic;

  private readonly modelId: string;

  public constructor(options: AnthropicClientOptions) {
    const apiKey = options.apiKey?.trim() ?? '';
    if (!apiKey) throw new Error('Anthropic API key is required');
    this.modelId = options.modelId?.trim() || ANTHROPIC_DEFAULT_MODEL_ID;
    this.client = new Anthropic({
      apiKey,
      timeout: options.overallTimeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 2,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  public async complete(input: LmStudioInput): Promise<LmStudioResult> {
    const isRepair = input.repairIssues !== undefined;
    const envelope = {
      originalInput: input.inputEnvelope,
      ...(isRepair ? { validationIssues: input.repairIssues, invalidStructure: input.invalidStructure } : {}),
    };
    let userContent: string;
    try {
      userContent = JSON.stringify(envelope);
    } catch {
      throw new LmStudioError('AI_INPUT_TOO_LARGE');
    }

    const screeningSchema = input.responseSchema;
    let response;
    try {
      response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: screeningSchema ? 1_024 : 8_192,
        system: input.systemInstruction,
        messages: [{ role: 'user', content: userContent }],
        thinking: { type: 'disabled' },
        ...(screeningSchema
          ? { output_config: { format: { type: 'json_schema', schema: jsonSchemaForAnthropic(screeningSchema) } } }
          : {}),
      });
    } catch (error) {
      throw mapApiError(error);
    }

    if (isRefusal(response.stop_reason)) throw new LmStudioError('AI_OUTPUT_UNSAFE');
    // A truncated response cannot be valid JSON, so fail before the handler
    // spends a repair round trip on half an object.
    if (response.stop_reason === 'max_tokens') throw new LmStudioError('AI_OUTPUT_INVALID');

    const content = lastTextBlock(response.content);
    if (!content.trim()) throw new LmStudioError('AI_OUTPUT_INVALID');

    return {
      content,
      model: response.model || this.modelId,
      inputTokens: typeof response.usage?.input_tokens === 'number' ? response.usage.input_tokens : null,
      outputTokens: typeof response.usage?.output_tokens === 'number' ? response.usage.output_tokens : null,
    };
  }
}
