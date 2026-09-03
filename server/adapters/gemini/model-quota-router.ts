import type { FlowPassDatabase } from '../../db/connection';
import { estimateInputTokens } from '../../domain/ai-draft-service';
import { LmStudioError, type LmStudioInput, type LmStudioResult } from '../lm-studio/lm-studio-client';

export interface GeminiQuotaModel {
  id: string;
  rpm: number;
  tpm: number;
  rpd: number;
}

export const DEFAULT_GEMINI_QUOTA_MODELS: readonly GeminiQuotaModel[] = [
  { id: 'gemini-3.6-flash', rpm: 5, tpm: 250_000, rpd: 20 },
  { id: 'gemini-3.5-flash', rpm: 5, tpm: 250_000, rpd: 20 },
  { id: 'gemini-3.7-flash', rpm: 5, tpm: 250_000, rpd: 20 },
];

const SAFETY_MARGIN = 1;

function pacificDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function estimateRequestTokens(input: LmStudioInput): number {
  return estimateInputTokens(JSON.stringify({
    system: input.systemInstruction,
    originalInput: input.inputEnvelope,
    ...(input.repairIssues ? { validationIssues: input.repairIssues, invalidStructure: input.invalidStructure } : {}),
  }));
}

export class GeminiQuotaRouter {
  private readonly blockedUntil = new Map<string, number>();

  public constructor(
    private readonly database: FlowPassDatabase,
    private readonly clients: ReadonlyMap<string, Pick<{ complete(input: LmStudioInput): Promise<LmStudioResult> }, 'complete'>>,
    private readonly models: readonly GeminiQuotaModel[] = DEFAULT_GEMINI_QUOTA_MODELS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async complete(input: LmStudioInput): Promise<LmStudioResult> {
    const estimatedTokens = estimateRequestTokens(input);
    let attempted = false;
    for (const model of this.models) {
      const client = this.clients.get(model.id);
      if (!client || (this.blockedUntil.get(model.id) ?? 0) > Date.now()) continue;
      if (!this.reserve(model, estimatedTokens)) continue;
      attempted = true;
      try {
        return await client.complete(input);
      } catch (error) {
        if (error instanceof LmStudioError && error.code === 'MODEL_RATE_LIMITED') {
          this.blockedUntil.set(model.id, Date.now() + 60_000);
          continue;
        }
        throw error;
      }
    }
    throw new LmStudioError('MODEL_RATE_LIMITED', attempted ? 'all Gemini models are rate limited' : 'Gemini quota is exhausted');
  }

  private reserve(model: GeminiQuotaModel, inputTokens: number): boolean {
    const now = this.clock();
    const minute = minuteKey(now);
    const day = pacificDay(now);
    return this.database.transaction(() => {
      const minuteRow = this.database.prepare(
        'SELECT request_count, input_tokens FROM ai_model_quota_usage WHERE model_id = ? AND minute_key = ? AND day_key = ?',
      ).get(model.id, minute, day) as { request_count: number; input_tokens: number } | undefined;
      const dayRow = this.database.prepare(
        'SELECT COALESCE(SUM(request_count), 0) AS request_count FROM ai_model_quota_usage WHERE model_id = ? AND day_key = ?',
      ).get(model.id, day) as { request_count: number };
      const requestCount = minuteRow?.request_count ?? 0;
      const tokens = minuteRow?.input_tokens ?? 0;
      if (requestCount >= Math.max(0, model.rpm - SAFETY_MARGIN)) return false;
      if (tokens + inputTokens > Math.max(0, model.tpm - 1_000)) return false;
      if (dayRow.request_count >= Math.max(0, model.rpd - SAFETY_MARGIN)) return false;
      this.database.prepare(
        `INSERT INTO ai_model_quota_usage (model_id, minute_key, day_key, request_count, input_tokens, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(model_id, minute_key, day_key) DO UPDATE SET
           request_count = request_count + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           updated_at = excluded.updated_at`,
      ).run(model.id, minute, day, inputTokens, now.toISOString());
      return true;
    })();
  }
}
