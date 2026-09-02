import { createConnection } from 'node:net';
import { PASSPORT_GENERATION_JSON_SCHEMA } from '../../../shared/passport-contract';
import { assertLoopbackOpenAiChatCompletionsUrl } from '../../config/loopback-openai-url';

export type LmStudioErrorCode =
  | 'MODEL_OFFLINE'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'AI_INPUT_TOO_LARGE'
  | 'AI_OUTPUT_INVALID'
  | 'AI_OUTPUT_UNSAFE';

export class LmStudioError extends Error {
  public constructor(public readonly code: LmStudioErrorCode, message: string = code) {
    super(message);
    this.name = 'LmStudioError';
  }
}

export interface LmStudioInput {
  systemInstruction: string;
  inputEnvelope: unknown;
  repairIssues?: readonly unknown[];
  invalidStructure?: unknown;
}

export interface LmStudioResult {
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LmStudioClientOptions {
  modelId: string;
  endpoint?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  overallTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam; production uses the loopback TCP probe below. */
  connectProbe?: (endpoint: string, timeoutMs: number) => Promise<void>;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';

function isRetryable(status: number): boolean { return status === 429 || status >= 500; }

function probeLoopback(endpoint: string, timeoutMs: number): Promise<void> {
  const url = new URL(endpoint);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LmStudioError('MODEL_TIMEOUT'));
    }, timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.once('connect', () => finish());
    socket.once('error', () => finish(new LmStudioError('MODEL_OFFLINE')));
  });
}

function parseResponse(value: unknown): LmStudioResult {
  if (!value || typeof value !== 'object') throw new LmStudioError('AI_OUTPUT_INVALID');
  const root = value as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') throw new LmStudioError('AI_OUTPUT_INVALID');
  const message = (choices[0] as Record<string, unknown>).message;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : null;
  if (typeof content !== 'string' || !content.trim()) throw new LmStudioError('AI_OUTPUT_INVALID');
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : {};
  return {
    content,
    model: typeof root.model === 'string' ? root.model : '',
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
  };
}

export class LmStudioClient {
  private readonly options: Required<Pick<LmStudioClientOptions, 'modelId' | 'endpoint' | 'connectTimeoutMs' | 'overallTimeoutMs'>> & LmStudioClientOptions;

  public constructor(options: LmStudioClientOptions) {
    this.options = { endpoint: DEFAULT_ENDPOINT, connectTimeoutMs: 5_000, overallTimeoutMs: 120_000, ...options };
    try {
      assertLoopbackOpenAiChatCompletionsUrl(this.options.endpoint);
    } catch {
      throw new Error('LM Studio endpoint must be loopback');
    }
  }

  public async complete(input: LmStudioInput): Promise<LmStudioResult> {
    const isRepair = input.repairIssues !== undefined;
    const envelope = {
      originalInput: input.inputEnvelope,
      ...(isRepair ? { validationIssues: input.repairIssues, invalidStructure: input.invalidStructure } : {}),
    };
    let body: string;
    try {
      body = JSON.stringify({
        model: this.options.modelId,
        messages: [
          { role: 'system', content: input.systemInstruction },
          { role: 'user', content: JSON.stringify(envelope) },
        ],
        temperature: 0.1,
        stream: false,
        max_tokens: 4096,
        response_format: { type: 'json_schema', json_schema: { name: 'flowpass_passport', strict: true, schema: PASSPORT_GENERATION_JSON_SCHEMA } },
      });
    } catch { throw new LmStudioError('AI_INPUT_TOO_LARGE'); }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    if (this.options.connectProbe) {
      await this.options.connectProbe(this.options.endpoint, this.options.connectTimeoutMs);
    } else if (!this.options.fetchImpl) {
      await probeLoopback(this.options.endpoint, this.options.connectTimeoutMs);
    }
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, this.options.overallTimeoutMs);
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const token = this.options.token?.trim();
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetchImpl(this.options.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          if (isRetryable(response.status) && attempt === 0) { attempt += 1; continue; }
          if (response.status === 401 || response.status === 403) throw new LmStudioError('MODEL_AUTH_FAILED');
          if (response.status === 404) throw new LmStudioError('MODEL_NOT_FOUND');
          if (response.status === 429) throw new LmStudioError('MODEL_RATE_LIMITED');
          if (response.status >= 400 && response.status < 500) throw new LmStudioError('AI_OUTPUT_INVALID');
          throw new LmStudioError('MODEL_OFFLINE');
        }
        let json: unknown;
        try { json = await response.json(); } catch { throw new LmStudioError('AI_OUTPUT_INVALID'); }
        return parseResponse(json);
      } catch (error) {
        if (error instanceof LmStudioError) throw error;
        if (controller.signal.aborted) throw new LmStudioError('MODEL_TIMEOUT');
        if (attempt === 0) { attempt += 1; continue; }
        throw new LmStudioError('MODEL_OFFLINE');
      } finally { clearTimeout(timer); }
    }
  }
}

export { DEFAULT_ENDPOINT as LM_STUDIO_ENDPOINT };
