import type { FlowPassDatabase } from '../../db/connection';
import type { LmStudioInput, LmStudioResult } from '../lm-studio/lm-studio-client';

/**
 * Anthropic enforces its own account-level rate limits and answers with 429 plus
 * `retry-after`, so this records what actually ran instead of pre-reserving a
 * local quota the way the Gemini free tier required. The admin AI usage panel
 * reads these rows.
 */
export const USAGE_DAY_TIMEZONE = 'Asia/Taipei';

export function usageDayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_DAY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function usageMinuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

interface Completer { complete(input: LmStudioInput): Promise<LmStudioResult>; }

export class AnthropicUsageRecorder implements Completer {
  public constructor(
    private readonly database: FlowPassDatabase,
    private readonly inner: Completer,
    private readonly modelId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async complete(input: LmStudioInput): Promise<LmStudioResult> {
    const result = await this.inner.complete(input);
    // Usage is an audit aid, never a reason to discard a draft the model already
    // produced, so a failed write must not surface as a generation failure.
    try {
      this.record(result.inputTokens ?? 0);
    } catch {
      /* usage accounting is best effort */
    }
    return result;
  }

  private record(inputTokens: number): void {
    const now = this.clock();
    this.database.prepare(
      `INSERT INTO ai_model_quota_usage (model_id, minute_key, day_key, request_count, input_tokens, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(model_id, minute_key, day_key) DO UPDATE SET
         request_count = request_count + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         updated_at = excluded.updated_at`,
    ).run(this.modelId, usageMinuteKey(now), usageDayKey(now), Math.max(0, inputTokens), now.toISOString());
  }
}
