import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../../crypto/field-crypto';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { decryptDatabaseText } from '../../db/repositories/encrypted-fields';
import { createCaseService } from '../../domain/case-service';
import { createAiDraftService } from '../../domain/ai-draft-service';
import { createPassportLifecycle } from '../../domain/passport-lifecycle';
import { inspectPassportJson } from '../../domain/passport-validation';
import { FLOWPASS_SAMPLE } from '../../../app/passport-sample';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { generatePassport } from './generate-passport';

const IDS = { applicant: '0198f050-0000-7000-8000-000000000001', cycle: '0198f050-0000-7000-8000-000000000002', rule: '0198f050-0000-7000-8000-000000000003' };
const NOW = '2026-08-30T00:00:00.000Z';
function cryptoForTests(): FieldCrypto { const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined }; return new FieldCrypto(keyring); }

describe('generate passport worker boundary', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task7-worker-')); db = openDatabase(join(dir, 'flowpass.sqlite')); migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  it('rejects non-AI jobs before touching persistence or the model', async () => {
    await expect(generatePassport({ id: 'job', jobType: 'line_webhook', payload: {}, state: 'leased', uniqueKey: 'x', attempts: 1, maxAttempts: 1, availableAt: '', leaseOwner: 'w', leaseUntil: null, lastErrorCode: null, createdAt: '', completedAt: null }, { workerId: 'w' }, { database: {} as never, crypto: {} as never, client: { complete: async () => { throw new Error('must not call'); } } })).rejects.toThrow('unsupported job type');
  });

  it('decrypts the answer in the worker and finalizes through passport lifecycle metadata', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: undefined, requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: 'worker secret sentinel', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const worker = await generatePassport(queued.job, { workerId: 'worker-1' }, { database: db, crypto, client: { complete: async () => ({ content: JSON.stringify(FLOWPASS_SAMPLE), model: 'fixture', inputTokens: 1, outputTokens: 1 }) }, clock: () => new Date(NOW) });
    expect(worker.resultCode).toBe('AI_DRAFT_CREATED');
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_follow_up_questions').get() as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_runs').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT payload_enc FROM passport_versions').get() as { payload_enc: string }).payload_enc).not.toContain('worker secret sentinel');
  });

  it('stops before passport generation when the AI quality gate rejects the answers', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'quality-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: 'asdf', aiPurpose: '12345', sensitiveData: '哈哈哈', destinationAndAudience: '???' }, ifMatch: '"1"', idempotencyKey: 'quality-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    let calls = 0;
    await expect(generatePassport(queued.job, { workerId: 'worker-1' }, {
      database: db,
      crypto,
      classifyInput: true,
      client: {
        complete: async (input) => {
          calls += 1;
          expect(input.responseSchema).toBeDefined();
          return { content: JSON.stringify({ valid: false, field_validity: { material: false, aiPurpose: false, sensitiveData: true, destinationAndAudience: true }, invalid_fields: ['material', 'aiPurpose'], reason: '無意義內容' }), model: 'fixture', inputTokens: 1, outputTokens: 1 };
        },
      },
      clock: () => new Date(NOW),
    })).rejects.toMatchObject({ code: 'AI_INPUT_INVALID' });
    expect(calls).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(0);
  });

  it('rewrites invalid model output with the original answers until the passport is valid', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'rewrite-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: 'rewrite source sentinel', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'rewrite-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const calls: Array<{ inputEnvelope: unknown; repairIssues?: readonly unknown[] }> = [];
    const result = await generatePassport(queued.job, { workerId: 'worker-1' }, {
      database: db,
      crypto,
      client: {
        complete: async (input) => {
          calls.push(input);
          return { content: calls.length < 3 ? '{"passport_draft":{}}' : JSON.stringify(FLOWPASS_SAMPLE), model: 'fixture', inputTokens: 1, outputTokens: 1 };
        },
      },
      clock: () => new Date(NOW),
    });
    expect(result.repairCount).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[1]?.inputEnvelope)).toContain('rewrite source sentinel');
    expect(calls[1]?.repairIssues?.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls[2]?.inputEnvelope)).toContain('rewrite source sentinel');
  });

  it('validates the JSON object when the model surrounds it with thinking text and a code fence', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'wrapped-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'wrapped-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    let calls = 0;
    const result = await generatePassport(queued.job, { workerId: 'worker-1' }, {
      database: db,
      crypto,
      client: { complete: async () => { calls += 1; return { content: `<think>private reasoning</think>\n\`\`\`json\n${JSON.stringify(FLOWPASS_SAMPLE)}\n\`\`\``, model: 'fixture', inputTokens: 1, outputTokens: 1 }; } },
      clock: () => new Date(NOW),
    });
    expect(result.resultCode).toBe('AI_DRAFT_CREATED');
    expect(calls).toBe(1);
  });

  it('normalizes fixed invoice metadata without asking the model to rewrite applicant content', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'invoice-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'invoice-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const modelOutput = structuredClone(FLOWPASS_SAMPLE) as unknown as { passport_draft: { administrative_hints: { invoice_fields_required: string[] } } };
    modelOutput.passport_draft.administrative_hints.invoice_fields_required = ['tool_name', 'tool_name', 'tool_name', 'tool_name'];
    let calls = 0;
    const result = await generatePassport(queued.job, { workerId: 'worker-1' }, { database: db, crypto, client: { complete: async () => { calls += 1; return { content: JSON.stringify(modelOutput), model: 'fixture', inputTokens: 1, outputTokens: 1 }; } }, clock: () => new Date(NOW) });
    expect(result.resultCode).toBe('AI_DRAFT_CREATED');
    expect(result.repairCount).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(1);
  });

  it('uses canonical answer names and removes invented retention, tool, and known answer keys', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'grounded-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '社團照片', aiPurpose: '使用 AI 修圖', sensitiveData: '可能有人像', destinationAndAudience: '公開於 IG' }, ifMatch: '"1"', idempotencyKey: 'grounded-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const modelOutput = structuredClone(FLOWPASS_SAMPLE) as unknown as { passport_draft: FlowPassPassport };
    modelOutput.passport_draft.retention = { storage_location: 'flowpass_storage', duration: '30_days', deletion_plan: '自動銷毀', needs_confirmation: false };
    modelOutput.passport_draft.administrative_hints.requested_tool = 'AI修圖工具';
    modelOutput.passport_draft.audit.unknown_fields = ['material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience'];
    let inputEnvelope: unknown;
    const result = await generatePassport(queued.job, { workerId: 'worker-1' }, { database: db, crypto, client: { complete: async (input) => { inputEnvelope = input.inputEnvelope; return { content: JSON.stringify(modelOutput), model: 'fixture', inputTokens: 1, outputTokens: 1 }; } }, clock: () => new Date(NOW) });
    expect(inputEnvelope).toMatchObject({ answers: { materials: '社團照片', intended_use: '使用 AI 修圖', personal_or_sensitive_data: '可能有人像', destination_and_audience: '公開於 IG' } });
    const encrypted = db.prepare('SELECT id, payload_enc FROM passport_versions WHERE id = ?').get(result.passportVersionId) as { id: string; payload_enc: string };
    const passport = JSON.parse(decryptDatabaseText(crypto, 'passport_versions', 'payload_enc', encrypted.id, encrypted.payload_enc)) as FlowPassPassport;
    expect(passport.retention).toMatchObject({ storage_location: 'unknown', duration: 'unknown', deletion_plan: 'unknown', needs_confirmation: true });
    expect(passport.administrative_hints.requested_tool).toBe('unknown');
    expect(passport.audit.unknown_fields).not.toEqual(expect.arrayContaining(['material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience']));
  });

  it('keeps only one concrete follow-up per topic', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'dedupe-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '修圖', sensitiveData: '不確定', destinationAndAudience: '公開於 IG' }, ifMatch: '"1"', idempotencyKey: 'dedupe-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;
    const baseQuestion = { version: 1, answerSchema: { type: 'text' as const, maxLength: 400 as const }, required: true, relatedNodeIds: [] as string[], priority: 'high' as const, status: 'open' as const };
    passport.follow_up_questions = [
      { ...baseQuestion, id: 'tool-1', prompt: '請問會使用哪個 AI 工具？例如 Canva。', reason: '確認工具。' },
      { ...baseQuestion, id: 'tool-2', prompt: '請再提供修圖工具名稱，例如 Firefly。', reason: '確認服務。' },
      { ...baseQuestion, id: 'retention-1', prompt: '檔案會保留多久？例如 30 天。', reason: '確認刪除時間。' },
    ];
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const result = await generatePassport(queued.job, { workerId: 'worker-1' }, { database: db, crypto, client: { complete: async () => ({ content: JSON.stringify({ passport_draft: passport }), model: 'fixture', inputTokens: 1, outputTokens: 1 }) }, clock: () => new Date(NOW) });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW) });
    const stored = lifecycle.getForApplicant({ applicantId: IDS.applicant, caseId: created.case.id, versionId: result.passportVersionId });
    expect(stored?.followUps.map((question) => question.questionKey)).toEqual(expect.arrayContaining(['tool-1', 'retention-1']));
    expect(stored?.followUps).toHaveLength(2);
  });

  it('rewrites a public or sensitive draft until it has a connected destination and safety action', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'semantic-case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '社團照片', aiPurpose: '使用 AI 修圖', sensitiveData: '可能有人像', destinationAndAudience: '公開於 IG' }, ifMatch: '"1"', idempotencyKey: 'semantic-answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const queued = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    const invalid = structuredClone(FLOWPASS_SAMPLE) as unknown as { passport_draft: FlowPassPassport };
    invalid.passport_draft.nodes = invalid.passport_draft.nodes.filter((node) => node.kind !== 'destination');
    const remainingIds = new Set(invalid.passport_draft.nodes.map((node) => node.id));
    invalid.passport_draft.edges = invalid.passport_draft.edges.filter((edge) => remainingIds.has(edge.from_node_id) && remainingIds.has(edge.to_node_id));
    invalid.passport_draft.safety_actions = [];
    (invalid.passport_draft as unknown as { confirmation_questions: unknown[] }).confirmation_questions = [];
    const calls: Array<{ repairIssues?: readonly unknown[] }> = [];
    await generatePassport(queued.job, { workerId: 'worker-1' }, { database: db, crypto, client: { complete: async (input) => { calls.push(input); return { content: JSON.stringify(calls.length === 1 ? invalid : FLOWPASS_SAMPLE), model: 'fixture', inputTokens: 1, outputTokens: 1 }; } }, clock: () => new Date(NOW) });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.repairIssues)).toContain('public_without_destination_flow');
    expect(JSON.stringify(calls[1]?.repairIssues)).toContain('missing_safety_action');
  });

  it('creates an immutable child for a revise job even when model content is unchanged', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const initialPassport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;
    initialPassport.follow_up_questions = [{
      id: 'tool-name',
      version: 1,
      prompt: '你會使用哪個 AI 工具？例如 Adobe Firefly 或 Canva。',
      reason: '確認資料會交給哪個服務處理。',
      answerSchema: { type: 'text', maxLength: 400 },
      required: true,
      relatedNodeIds: [],
      priority: 'high',
      status: 'open',
    }];
    const modelDocument = { passport_draft: initialPassport };
    const client = { complete: async () => ({ content: JSON.stringify(modelDocument), model: 'fixture', inputTokens: 1, outputTokens: 1 }) };
    const first = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    await generatePassport(first.job, { workerId: 'worker-1' }, { database: db, crypto, client, clock: () => new Date(NOW) });
    db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(first.job.id);
    const current = db.prepare('SELECT current_passport_version_id FROM cases WHERE id=?').get(created.case.id) as { current_passport_version_id: string };
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW) });
    const source = lifecycle.getForApplicant({ applicantId: IDS.applicant, caseId: created.case.id });
    expect(source).not.toBeNull();
    const requiredQuestions = source!.followUps.filter((question) => question.required);
    expect(requiredQuestions.length).toBeGreaterThan(0);
    lifecycle.answerFollowUps({
      applicantId: IDS.applicant,
      caseId: created.case.id,
      passportVersionId: source!.version.id,
      ifMatch: source!.etag,
      answers: requiredQuestions.map((question) => ({ questionId: question.id, answer: 'LM Studio' })),
      declarations: [],
    });
    const revision = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id, operation: 'revise' });
    let revisionInput: unknown;
    const result = await generatePassport(revision.job, { workerId: 'worker-1' }, {
      database: db,
      crypto,
      client: { complete: async (input) => { revisionInput = input.inputEnvelope; return client.complete(); } },
      clock: () => new Date(NOW),
    });
    expect(result.resultCode).toBe('AI_DRAFT_CREATED');
    expect(revisionInput).toMatchObject({ answeredFollowUps: expect.arrayContaining([{ question: expect.any(String), answer: 'LM Studio' }]) });
    expect(revisionInput).not.toHaveProperty('newAnswers');
    expect(revisionInput).not.toHaveProperty('currentQuestionIds');
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(2);
    expect((db.prepare('SELECT origin, parent_version_id FROM passport_versions WHERE id=?').get(result.passportVersionId) as { origin: string; parent_version_id: string }).origin).toBe('applicant_revision');
    expect((db.prepare('SELECT parent_version_id FROM passport_versions WHERE id=?').get(result.passportVersionId) as { parent_version_id: string }).parent_version_id).toBe(current.current_passport_version_id);
    const revised = lifecycle.getForApplicant({ applicantId: IDS.applicant, caseId: created.case.id });
    expect(revised?.passport.follow_up_questions).toEqual([]);
    expect(revised?.followUps).toEqual([]);
  });
});
