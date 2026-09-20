import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createCaseService } from './case-service';
import { AI_INPUT_TOKEN_BUDGET, AI_PROMPT_VERSION, FIXED_AI_INSTRUCTION, GEMINI_AI_INPUT_TOKEN_BUDGET, aiInputTokenBudget, createAiDraftService, estimateInputTokens } from './ai-draft-service';
import { v7 as uuidv7 } from 'uuid';

const IDS = { applicant: '0198f050-0000-7000-8000-000000000001', cycle: '0198f050-0000-7000-8000-000000000002', rule: '0198f050-0000-7000-8000-000000000003' };
const NOW = '2026-08-30T00:00:00.000Z';

function testCrypto(): FieldCrypto {
  const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined };
  return new FieldCrypto(keyring);
}

describe('ai draft admission boundary', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task7-ai-'));
    db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('exposes the reserved 11,264-token input budget and does not expose an answer payload in the job contract', () => {
    expect(AI_INPUT_TOKEN_BUDGET).toBe(11_264);
    expect(GEMINI_AI_INPUT_TOKEN_BUDGET).toBe(27_648);
    expect(aiInputTokenBudget('gemini')).toBe(GEMINI_AI_INPUT_TOKEN_BUDGET);
    expect(aiInputTokenBudget('lm-studio')).toBe(AI_INPUT_TOKEN_BUDGET);
    const service = createAiDraftService({ database: {} as never, crypto: {} as never, modelId: 'fixture' });
    expect(service).toHaveProperty('enqueue');
  });

  it('requires natural Traditional Chinese without exposing structural JSON names in visible copy', () => {
    expect(AI_PROMPT_VERSION).toBe('flowpass-ai-v10');
    expect(FIXED_AI_INSTRUCTION).toContain('Traditional Chinese (zh-Hant)');
    expect(FIXED_AI_INSTRUCTION).toContain('Never expose or quote JSON property names');
    expect(FIXED_AI_INSTRUCTION).toContain('structural JSON property names and enum values exactly');
    expect(FIXED_AI_INSTRUCTION).toContain('answeredFollowUps entry pairs');
    expect(FIXED_AI_INSTRUCTION).toContain('set follow_up_questions exactly to []');
    expect(FIXED_AI_INSTRUCTION).toContain('at most four required follow-up questions');
    expect(FIXED_AI_INSTRUCTION).toContain('Prefer checklist-style follow-up questions');
    expect(FIXED_AI_INSTRUCTION).toContain('single_choice or multi_choice');
    expect(FIXED_AI_INSTRUCTION).toContain('Never ask follow-up questions about the AI tool or retention duration');
    expect(FIXED_AI_INSTRUCTION).toContain('Infer which sensitive categories are plausible');
    expect(FIXED_AI_INSTRUCTION).toContain('not a generic face-only question');
    expect(FIXED_AI_INSTRUCTION).toContain('API keys/passwords');
  });

  it('does not turn an unknown case into a job', () => {
    const database = { prepare: () => ({ get: () => undefined }) } as never;
    const service = createAiDraftService({ database, crypto: {} as never, modelId: 'fixture' });
    expect(() => service.projectionForCase({ applicantId: 'applicant', caseId: 'missing' })).toThrow('NOT_FOUND');
  });

  it('persists only IDs/control metadata in the durable payload and enforces the injectable token budget', () => {
    const crypto = testCrypto();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: uuidv7, requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '機密答案 sentinel', aiPurpose: '整理', sensitiveData: '健康', destinationAndAudience: '團隊', requestedTool: 'ChatGPT', retentionDuration: '保留 30 天', applicantName: '測試申請人' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const service = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const result = service.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const payload = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(result.job.id) as { payload_json: string };
    expect(payload.payload_json).not.toContain('機密答案 sentinel');
    expect(payload.payload_json).toContain(created.case.id);
    expect(estimateInputTokens('中')).toBeGreaterThanOrEqual(2);
    const tooLarge = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => AI_INPUT_TOKEN_BUDGET + 1, clock: () => new Date(NOW) });
    expect(() => tooLarge.projectionForCase({ applicantId: IDS.applicant, caseId: created.case.id })).toThrow('AI_INPUT_TOO_LARGE');
  });

  it('uses a fresh unique key for an explicit terminal-job retry', () => {
    const crypto = testCrypto();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: uuidv7, requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊', requestedTool: 'ChatGPT', retentionDuration: '保留 30 天', applicantName: '測試申請人' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const service = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const first = service.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    db.prepare("UPDATE jobs SET state='failed_terminal' WHERE id=?").run(first.job.id);
    const retry = service.enqueue({ applicantId: IDS.applicant, caseId: created.case.id, retryNonce: 'retry-key' });
    expect(retry.job.id).not.toBe(first.job.id);
  });
});
