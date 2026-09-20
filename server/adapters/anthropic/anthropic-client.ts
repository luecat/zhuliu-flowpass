import Anthropic from '@anthropic-ai/sdk';
import { PASSPORT_GENERATION_JSON_SCHEMA } from '../../../shared/passport-contract';
import { LmStudioError, type LmStudioInput, type LmStudioResult } from '../lm-studio/lm-studio-client';

export const ANTHROPIC_DEFAULT_MODEL_ID = 'claude-sonnet-5';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Passport drafting is a bounded structured-output task, so the default sits
 * below the API default of `high`: it keeps the reasoning that the sensitive
 * data inference needs without paying for the depth a long agentic task wants.
 * Override per environment with `FLOWPASS_ANTHROPIC_EFFORT`.
 */
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

function mapApiError(error: unknown): LmStudioError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LmStudioError('MODEL_AUTH_FAILED');
  }
  if (error instanceof Anthropic.NotFoundError) return new LmStudioError('MODEL_NOT_FOUND');
  if (error instanceof Anthropic.RateLimitError) return new LmStudioError('MODEL_RATE_LIMITED');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new LmStudioError('MODEL_TIMEOUT');
  if (error instanceof Anthropic.APIConnectionError) return new LmStudioError('MODEL_OFFLINE');
  if (error instanceof Anthropic.BadRequestError) {
    // The only request this adapter builds is the passport envelope, so a 400
    // means the envelope itself was rejected rather than the model misbehaving.
    return new LmStudioError(/too long|too large|exceed/i.test(error.message) ? 'AI_INPUT_TOO_LARGE' : 'AI_INPUT_INVALID');
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

  private readonly effort: AnthropicEffort;

  public constructor(options: AnthropicClientOptions) {
    const apiKey = options.apiKey?.trim() ?? '';
    if (!apiKey) throw new Error('Anthropic API key is required');
    this.modelId = options.modelId?.trim() || ANTHROPIC_DEFAULT_MODEL_ID;
    this.effort = options.effort ?? ANTHROPIC_DEFAULT_EFFORT;
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

    let response;
    try {
      response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: 16_000,
        system: input.systemInstruction,
        messages: [{ role: 'user', content: userContent }],
        thinking: { type: 'adaptive' },
        output_config: {
          effort: this.effort,
          format: { type: 'json_schema', schema: input.responseSchema ?? PASSPORT_GENERATION_JSON_SCHEMA },
        },
      });
    } catch (error) {
      throw mapApiError(error);
    }

    if (isRefusal(response.stop_reason)) throw new LmStudioError('AI_OUTPUT_UNSAFE');
    // A truncated response cannot be valid JSON, so fail before the handler
    // spends a repair round trip on half an object.
    if (response.stop_reason === 'max_tokens') throw new LmStudioError('AI_OUTPUT_INVALID');

    const content = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!content.trim()) throw new LmStudioError('AI_OUTPUT_INVALID');

    return {
      content,
      model: response.model || this.modelId,
      inputTokens: typeof response.usage?.input_tokens === 'number' ? response.usage.input_tokens : null,
      outputTokens: typeof response.usage?.output_tokens === 'number' ? response.usage.output_tokens : null,
    };
  }
}
