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

/** Default Keychain accounts for complementary Gemini API keys. */
export const DEFAULT_GEMINI_KEYCHAIN_ACCOUNTS = ['gemini-api-key', 'gemini-api-key-2', 'gemini-api-key-3'] as const;

const SAFETY_MARGIN = 1;

const FAILOVER_CODES = new Set<LmStudioError['code']>([
  'MODEL_RATE_LIMITED',
  'MODEL_OFFLINE',
  'MODEL_AUTH_FAILED',
]);

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

/**
 * Resolves Keychain account names for Gemini keys. Override with a comma list
 * via `FLOWPASS_GEMINI_KEYCHAIN_ACCOUNTS`, otherwise k1/k2/k3 env defaults.
 */
export function geminiKeychainAccounts(): string[] {
  const listed = process.env.FLOWPASS_GEMINI_KEYCHAIN_ACCOUNTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (listed && listed.length > 0) return [...new Set(listed)];
  const accounts = [
    process.env.FLOWPASS_GEMINI_KEYCHAIN_ACCOUNT?.trim() || DEFAULT_GEMINI_KEYCHAIN_ACCOUNTS[0],
    process.env.FLOWPASS_GEMINI_KEYCHAIN_ACCOUNT_2?.trim() || DEFAULT_GEMINI_KEYCHAIN_ACCOUNTS[1],
    process.env.FLOWPASS_GEMINI_KEYCHAIN_ACCOUNT_3?.trim() || DEFAULT_GEMINI_KEYCHAIN_ACCOUNTS[2],
  ];
  return [...new Set(accounts)];
}

/** Quota / client map id: `k1:gemini-3.6-flash`. */
export function geminiRouteId(keySlot: string, modelId: string): string {
  return `${keySlot}:${modelId}`;
}

export function geminiBaseModelId(routeId: string): string {
  const index = routeId.indexOf(':');
  return index === -1 ? routeId : routeId.slice(index + 1);
}

/**
 * Builds routed quota rows so each key keeps its own RPM/RPD pool.
 * Order: preferred model on key1, then same model on key2, then next model…
 * so complementary keys cover each other before falling back to another model.
 */
export function buildGeminiKeyRoutedModels(
  keySlots: readonly string[],
  models: readonly GeminiQuotaModel[] = DEFAULT_GEMINI_QUOTA_MODELS,
): GeminiQuotaModel[] {
  if (keySlots.length === 0) return [];
  if (keySlots.length === 1) {
    return models.map((model) => ({ ...model, id: geminiRouteId(keySlots[0]!, model.id) }));
  }
  const routed: GeminiQuotaModel[] = [];
  for (const model of models) {
    for (const slot of keySlots) {
      routed.push({ ...model, id: geminiRouteId(slot, model.id) });
    }
  }
  return routed;
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
        if (error instanceof LmStudioError && FAILOVER_CODES.has(error.code)) {
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
