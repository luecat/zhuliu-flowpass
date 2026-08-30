import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createCaseService } from './case-service';
import { PassportLifecycleError, createPassportLifecycle } from './passport-lifecycle';
import { inspectPassportDocument } from './passport-validation';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import type { FlowPassPassport } from '../../shared/passport-contract';

const IDS = {
  applicant: '0198f050-0000-7000-8000-000000000001',
  cycle: '0198f050-0000-7000-8000-000000000002',
  rule: '0198f050-0000-7000-8000-000000000003',
};
const NOW = '2026-08-30T00:00:00.000Z';
const answers = { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' };

function cryptoForTests(): FieldCrypto {
  const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined };
  return new FieldCrypto(keyring);
}

describe('passport lifecycle', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let ids = 10;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task8-passport-'));
    db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function createCase() {
    const service = createCaseService({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = service.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: `case-${ids}` });
    const saved = service.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: '"1"', idempotencyKey: `answers-${ids}` });
    return { caseId: created.case.id, answerVersionId: saved.answerVersion.id };
  }

  function samplePassport(): FlowPassPassport {
    const value = structuredClone(FLOWPASS_SAMPLE) as Record<string, unknown>;
    const draft = value.passport_draft as Record<string, unknown>;
    draft.retention = { storage_location: 'node_storage_01', duration: '30 days', deletion_plan: '刪除原始素材', needs_confirmation: false };
    draft.administrative_hints = { ...(draft.administrative_hints as Record<string, unknown>), requested_tool: '示範工具' };
    const questions = draft.confirmation_questions as Array<Record<string, unknown>>;
    draft.confirmation_questions = questions.map((question) => ({
      ...question,
      version: 1,
      answerSchema: { type: 'text', maxLength: 400 },
      required: true,
      status: 'open',
    }));
    const inspection = inspectPassportDocument(value);
    if (!inspection.canonical) throw new Error('sample passport must be canonical');
    return inspection.canonical;
  }

  it('first AI result creates version 1 and records required follow-ups', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const result = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    expect(result.version.versionNo).toBe(1);
    expect(result.version.workflowState).toBe('follow_up_required');
    expect(result.followUps.length).toBeGreaterThan(0);
    expect((db.prepare('SELECT current_passport_version_id FROM cases WHERE id=?').get(caseId) as { current_passport_version_id: string }).current_passport_version_id).toBe(result.version.id);
  });

  it('keys follow-up answers to both question and source passport version', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    const followUp = first.followUps[0];
    const confirmed = lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: [{ questionId: followUp.id, answer: '示範回答' }], declarations: [], });
    expect(confirmed.workflowState).toBe('follow_up_required');
    const row = db.prepare('SELECT passport_version_id FROM passport_follow_up_answers WHERE question_id=?').get(followUp.id) as { passport_version_id: string };
    expect(row.passport_version_id).toBe(first.version.id);
    expect((db.prepare('SELECT status FROM passport_follow_up_questions WHERE id=?').get(followUp.id) as { status: string }).status).toBe('answered');
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: '0198f050-0000-7000-8000-000000000099', ifMatch: '"1"', answers: [{ questionId: followUp.id, answer: '錯誤版本' }], declarations: [] })).toThrowError(PassportLifecycleError);
  });

  it('rejects stale version answers and creates immutable revised versions', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"9"', answers: [], declarations: [] })).toThrowError(PassportLifecycleError);
    const revised = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'applicant_revision', actorType: 'system', actorId: 'worker-1', parentVersionId: first.version.id });
    expect(revised.version.versionNo).toBe(2);
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: [], declarations: [] })).toThrowError(PassportLifecycleError);
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(2);
  });

  it('does not mark a version confirmed while required follow-ups remain unanswered', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    const result = lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: [], declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    expect(result.workflowState).toBe('follow_up_required');
    expect(() => lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"' })).toThrowError(PassportLifecycleError);
  });

  it('persists required answers and enqueues a revision atomically', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, enqueueRevision: () => ({ jobId: 'revision-job', state: 'queued' }) });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    const pending = lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: first.followUps.map((question) => ({ questionId: question.id, answer: `回答-${question.questionKey}` })), declarations: [] });
    expect(pending.workflowState).toBe('follow_up_required');
    expect(pending.revisionJobId).toBe('revision-job');
    const current = lifecycle.getForApplicant({ applicantId: IDS.applicant, caseId });
    if (!current) throw new Error('current passport missing');
    expect(current.version.versionNo).toBe(1);
    expect(current.followUps.every((question) => question.answer?.startsWith('回答-'))).toBe(true);
    expect(current.followUps.every((question) => question.status === 'answered')).toBe(true);
  });

  it('rejects optional and out-of-schema multi-choice answers', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const passport = samplePassport();
    passport.follow_up_questions = [
      { ...passport.follow_up_questions[0], required: false, answerSchema: { type: 'single_choice', choices: ['A'] } },
      { ...passport.follow_up_questions[1], required: true, answerSchema: { type: 'multi_choice', choices: ['A', 'B'] } },
    ];
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport, origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: [{ questionId: first.followUps[0].id, answer: 'A' }], declarations: [] })).toThrowError(PassportLifecycleError);
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: [{ questionId: first.followUps[1].id, answer: '["C"]' }], declarations: [] })).toThrowError(PassportLifecycleError);
  });

  it('rolls back follow-up answers when revision enqueue fails', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, enqueueRevision: () => { throw new Error('queue unavailable'); } });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    const allAnswered = first.followUps.map((question) => ({ questionId: question.id, answer: `回答-${question.questionKey}` }));
    expect(() => lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: allAnswered, declarations: [] })).toThrow('queue unavailable');
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_follow_up_answers').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT status FROM passport_follow_up_questions WHERE passport_version_id=? AND status=\'open\'').all(first.version.id) as unknown[]).length).toBe(first.followUps.length);
    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(0);
  });

  it('rejects an invalid confirmation declaration before creating a new version', () => {
    const { caseId, answerVersionId } = createCase();
    const lifecycle = createPassportLifecycle({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const first = lifecycle.createVersion({ caseId, answerVersionId, passport: samplePassport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker-1' });
    const allAnswered = first.followUps.map((question) => ({ questionId: question.id, answer: `回答-${question.questionKey}` }));
    const pending = lifecycle.answerFollowUps({ applicantId: IDS.applicant, caseId, passportVersionId: first.version.id, ifMatch: '"1"', answers: allAnswered, declarations: [] });
    expect(() => lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId, passportVersionId: pending.id, ifMatch: '"2"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: 'not-true'.repeat(1_000) }] })).toThrowError(PassportLifecycleError);
    expect((db.prepare('SELECT COUNT(*) AS count FROM passport_versions').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT current_passport_version_id FROM cases WHERE id=?').get(caseId) as { current_passport_version_id: string }).current_passport_version_id).toBe(pending.id);
  });
});
