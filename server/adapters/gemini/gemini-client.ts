import { PASSPORT_GENERATION_JSON_SCHEMA } from '../../../shared/passport-contract';
import {
  LmStudioError,
  type LmStudioInput,
  type LmStudioResult,
} from '../lm-studio/lm-studio-client';

/**
 * Gemini is called through its OpenAI-compatible chat-completions endpoint so
 * the worker keeps exactly one response contract. Failures are surfaced as
 * `LmStudioError` on purpose: the passport handler classifies retries and
 * result codes with `instanceof LmStudioError`, so a parallel error class
 * would degrade every remote failure into an unclassified internal error.
 */
export const GEMINI_DEFAULT_MODEL_ID = 'gemini-3.6-flash';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export interface GeminiClientOptions {
  modelId: string;
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  overallTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Gemini's OpenAI-compatible endpoint accepts a strict `json_schema` for a
   * minimal example but rejects this project's passport schema with a bare
   * 400 `INVALID_ARGUMENT`, so the default is the plain-JSON path with the
   * schema embedded in the prompt. The handler validates the draft and runs
   * its own repair loop, which is what actually guarantees the shape.
   */
  strictSchema?: boolean;
}

/** Thrown internally when the strict response format itself is refused. */
class SchemaFormatRejected extends Error {}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The `jobs` table only persists `last_error_code`, so the detail of a 4xx is
 * otherwise lost. Keep a masked excerpt for logs; never leak credentials.
 */
function describeFailure(status: number, detail: string): string {
  const masked = detail
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/[A-Za-z0-9_-{\[._-]{20,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!masked) return `gemini http ${status}`;
  return `gemini http ${status} ${masked.slice(0, 300)}`;
}

function codeForStatus(status: number): LmStudioError['code'] {
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 429) return 'MODEL_RATE_LIMITED';
  if (status >= 400 && status < 500) return 'AI_OUTPUT_INVALID';
  return 'MODEL_OFFLINE';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object'
        ? String((part as Record<string, unknown>).text ?? '')
        : ''))
      .join('');
  }
  return '';
}

function parseResponse(value: unknown): LmStudioResult {
  if (!value || typeof value !== 'object') throw new LmStudioError('AI_OUTPUT_INVALID');
  const root = value as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new LmStudioError('AI_OUTPUT_INVALID');
  }
  const choice = choices[0] as Record<string, unknown>;
  // A truncated JSON object always fails the handler's parse step, and the
  // repair loop would then burn two more remote calls to rediscover the same
  // limit. Fail fast with a message that says why.
  if (choice.finish_reason === 'length') {
    throw new LmStudioError('AI_OUTPUT_INVALID', 'gemini response truncated at max_tokens');
  }
  const message = choice.message;
  const content = message && typeof message === 'object'
    ? (message as Record<string, unknown>).content
    : null;
  const text = textOf(content);
  if (!text.trim()) throw new LmStudioError('AI_OUTPUT_INVALID');
  const usage = root.usage && typeof root.usage === 'object'
    ? (root.usage as Record<string, unknown>)
    : {};
  return {
    content: text,
    model: typeof root.model === 'string' ? root.model : '',
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
  };
}

export class GeminiClient {
  private readonly modelId: string;

  private readonly endpoint: string;

  private readonly apiKey: string;

  private readonly fetchImpl: typeof fetch;

  private readonly overallTimeoutMs: number;

  private readonly sleep: (milliseconds: number) => Promise<void>;

  private readonly strictSchema: boolean;

  /** Once the endpoint refuses strict schemas, stop paying for that call. */
  private strictRejected = false;

  public constructor(options: GeminiClientOptions) {
    const apiKey = options.apiKey?.trim() ?? '';
    if (!apiKey) throw new Error('Gemini API key is required');
    this.modelId = options.modelId?.trim() || GEMINI_DEFAULT_MODEL_ID;
    this.endpoint = options.endpoint?.trim() || GEMINI_ENDPOINT;
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.overallTimeoutMs = options.overallTimeoutMs ?? 120_000;
    this.sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
    this.strictSchema = options.strictSchema ?? false;
  }

  public async complete(input: LmStudioInput): Promise<LmStudioResult> {
    const isRepair = input.repairIssues !== undefined;
    const envelope = {
      originalInput: input.inputEnvelope,
      ...(isRepair ? { validationIssues: input.repairIssues, invalidStructure: input.invalidStructure } : {}),
    };
    const userContent = JSON.stringify(envelope);
    const useStrict = this.strictSchema && !this.strictRejected;

    if (!useStrict) {
      return await this.request(this.body(userContent, this.instruction(input.systemInstruction, input.responseSchema), false, input.responseSchema), false);
    }

    try {
      return await this.request(this.body(userContent, input.systemInstruction, true, input.responseSchema), true);
    } catch (error) {
      if (!(error instanceof SchemaFormatRejected)) throw error;
      this.strictRejected = true;
      // Degrade to plain JSON mode with the schema embedded in the prompt. The
      // handler still validates the draft and runs its repair loop, so a less
      // strict response format cannot silently produce a bad passport.
      return await this.request(this.body(userContent, this.instruction(input.systemInstruction, input.responseSchema), false, input.responseSchema), false);
    }
  }

  private instruction(systemInstruction: string, responseSchema?: Record<string, unknown>): string {
    return `${systemInstruction}\n\nReturn exactly one JSON object validating this JSON Schema. No prose and no markdown fences:\n${JSON.stringify(responseSchema ?? PASSPORT_GENERATION_JSON_SCHEMA)}`;
  }

  private body(userContent: string, systemInstruction: string, strict: boolean, responseSchema?: Record<string, unknown>): string {
    try {
      return JSON.stringify({
        model: this.modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        stream: false,
        max_tokens: 4096,
        response_format: strict
          ? {
            type: 'json_schema',
            json_schema: {
              name: 'flowpass_passport',
              strict: true,
              schema: responseSchema ?? PASSPORT_GENERATION_JSON_SCHEMA,
            },
          }
          : { type: 'json_object' },
      });
    } catch {
      throw new LmStudioError('AI_INPUT_TOO_LARGE');
    }
  }

  private async request(body: string, strict: boolean): Promise<LmStudioResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, this.overallTimeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          const { status } = response;
          const detail = status >= 400 && status < 500 ? await response.text().catch(() => '') : '';
          // Gemini reports an unusable response format as a bare
          // `INVALID_ARGUMENT` that never mentions the format, so a 4xx while
          // strict is in play is treated as a format rejection and retried
          // once without it; the wording check is only an extra hint.
          if (strict && (status === 400 || status === 422)) {
            throw new SchemaFormatRejected('unsupported response format');
          }
          if (isRetryable(status) && attempt === 0) {
            await this.sleep(1_500);
            continue;
          }
          throw new LmStudioError(codeForStatus(status), describeFailure(status, detail));
        }
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          throw new LmStudioError('AI_OUTPUT_INVALID');
        }
        return parseResponse(json);
      } catch (error) {
        if (error instanceof LmStudioError || error instanceof SchemaFormatRejected) throw error;
        if (controller.signal.aborted) throw new LmStudioError('MODEL_TIMEOUT');
        if (attempt === 0) {
          await this.sleep(1_500);
          continue;
        }
        throw new LmStudioError('MODEL_OFFLINE');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new LmStudioError('MODEL_OFFLINE');
  }
}
