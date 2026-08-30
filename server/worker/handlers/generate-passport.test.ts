import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../../crypto/field-crypto';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { createCaseService } from '../../domain/case-service';
import { createAiDraftService } from '../../domain/ai-draft-service';
import { FLOWPASS_SAMPLE } from '../../../app/passport-sample';
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
    await expect(generatePassport({ id: 'job', jobType: 'ocr', payload: {}, state: 'leased', uniqueKey: 'x', attempts: 1, maxAttempts: 1, availableAt: '', leaseOwner: 'w', leaseUntil: null, lastErrorCode: null, createdAt: '', completedAt: null }, { workerId: 'w' }, { database: {} as never, crypto: {} as never, client: { complete: async () => { throw new Error('must not call'); } } })).rejects.toThrow('unsupported job type');
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

  it('creates an immutable child for a revise job even when model content is unchanged', async () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), requestIdGenerator: () => 'request' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const admission = { admit: () => ({ allowed: true, retryAfter: 0 }) } as never;
    const ai = createAiDraftService({ database: db, crypto, modelId: 'fixture', admission, tokenCounter: () => 1, clock: () => new Date(NOW) });
    const client = { complete: async () => ({ content: JSON.stringify(FLOWPASS_SAMPLE), model: 'fixture', inputTokens: 1, outputTokens: 1 }) };
    const first = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id });
    await generatePassport(first.job, { workerId: 'worker-1' }, { database: db, crypto, client, clock: () => new Date(NOW) });
    db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(first.job.id);
    const current = db.prepare('SELECT current_passport_version_id FROM cases WHERE id=?').get(created.case.id) as { current_passport_version_id: string };
    const revision = ai.enqueue({ applicantId: IDS.applicant, caseId: created.case.id, operation: 'revise' });
    const result = await generatePassport(revision.job, { workerId: 'worker-1' }, { database: db, crypto, client, clock: () => new Date(NOW) });
    expect(result.resultCode).toBe('AI_DRAFT_CREATED');
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(2);
    expect((db.prepare('SELECT origin, parent_version_id FROM passport_versions WHERE id=?').get(result.passportVersionId) as { origin: string; parent_version_id: string }).origin).toBe('applicant_revision');
    expect((db.prepare('SELECT parent_version_id FROM passport_versions WHERE id=?').get(result.passportVersionId) as { parent_version_id: string }).parent_version_id).toBe(current.current_passport_version_id);
  });
});
