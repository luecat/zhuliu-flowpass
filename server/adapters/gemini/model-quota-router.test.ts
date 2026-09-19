import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { LmStudioError } from '../lm-studio/lm-studio-client';
import {
  GeminiQuotaRouter,
  buildGeminiKeyRoutedModels,
  geminiBaseModelId,
  geminiRouteId,
} from './model-quota-router';

describe('GeminiQuotaRouter', () => {
  it('switches models after the safety-margin RPM is reserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpass-quota-'));
    const db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    try {
      const calls: string[] = [];
      const clients = new Map([
        ['first', { complete: async () => { calls.push('first'); return Promise.reject(new Error('should not be called')); } }],
        ['second', { complete: async () => { calls.push('second'); return { content: '{}', model: 'second', inputTokens: 1, outputTokens: 1 }; } }],
      ]);
      const models = [
        { id: 'first', rpm: 2, tpm: 250_000, rpd: 20 },
        { id: 'second', rpm: 2, tpm: 250_000, rpd: 20 },
      ] as const;
      const clock = () => new Date('2026-09-03T08:00:00.000Z');
      db.prepare('INSERT INTO ai_model_quota_usage (model_id, minute_key, day_key, request_count, input_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('first', '2026-09-03T08:00', '2026-09-03', 1, 1, clock().toISOString());
      const result = await new GeminiQuotaRouter(db, clients, models, clock).complete({ systemInstruction: 'x', inputEnvelope: { answer: 'y' } });
      expect(result.model).toBe('second');
      expect(calls).toEqual(['second']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails over from key1 to key2 on the same model when rate limited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpass-quota-keys-'));
    const db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    try {
      const calls: string[] = [];
      const models = buildGeminiKeyRoutedModels(['k1', 'k2'], [
        { id: 'gemini-flash', rpm: 5, tpm: 250_000, rpd: 20 },
      ]);
      const clients = new Map([
        [geminiRouteId('k1', 'gemini-flash'), {
          complete: async () => {
            calls.push('k1');
            throw new LmStudioError('MODEL_RATE_LIMITED');
          },
        }],
        [geminiRouteId('k2', 'gemini-flash'), {
          complete: async () => {
            calls.push('k2');
            return { content: '{}', model: 'gemini-flash', inputTokens: 1, outputTokens: 1 };
          },
        }],
      ]);
      const result = await new GeminiQuotaRouter(db, clients, models).complete({
        systemInstruction: 'x',
        inputEnvelope: { answer: 'y' },
      });
      expect(result.model).toBe('gemini-flash');
      expect(calls).toEqual(['k1', 'k2']);
      expect(geminiBaseModelId(models[0]!.id)).toBe('gemini-flash');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
