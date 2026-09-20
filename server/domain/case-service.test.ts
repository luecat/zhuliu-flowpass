import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createCaseService, CaseCommandError } from './case-service';
import { createPassportLifecycle } from './passport-lifecycle';
import { reserveApplicantMutation } from '../public/public-mutations';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import { inspectPassportDocument } from './passport-validation';
import type { FlowPassPassport } from '../../shared/passport-contract';

const IDS = { applicant: '0198f050-0000-7000-8000-000000000001', cycle: '0198f050-0000-7000-8000-000000000002', rule: '0198f050-0000-7000-8000-000000000003' };
const NOW = '2026-08-30T00:00:00.000Z';
const answers = { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊', requestedTool: 'ChatGPT', retentionDuration: '保留 30 天', applicantName: '測試申請人' };

function cryptoForTests(): FieldCrypto {
  const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined };
  return new FieldCrypto(keyring);
}

function passport(): FlowPassPassport {
  const value = structuredClone(FLOWPASS_SAMPLE) as Record<string, unknown>;
  const draft = value.passport_draft as Record<string, unknown>;
  draft.retention = { storage_location: 'node_storage_01', duration: '30 days', deletion_plan: '刪除原始素材', needs_confirmation: false };
  draft.administrative_hints = { ...(draft.administrative_hints as Record<string, unknown>), requested_tool: '示範工具' };
  draft.confirmation_questions = [];
  const result = inspectPassportDocument(value);
  if (!result.canonical) throw new Error('sample passport must be canonical');
  return result.canonical;
}

describe('case service', () => {
  let dir: string; let db: ReturnType<typeof openDatabase>; let ids = 10;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task6-')); db = openDatabase(join(dir, 'flowpass.sqlite')); migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  function service() { return createCaseService({ database: db, crypto: cryptoForTests(), clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' }); }

  it('replaces an older unsubmitted case and keeps answer versions encrypted', () => {
    const s = service(); const first = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'a' });
    const saved = s.saveAnswers({ applicantId: IDS.applicant, caseId: first.case.id, answers, ifMatch: '"1"', idempotencyKey: 'answers-a' });
    expect(saved.answerVersion.versionNo).toBe(1); expect(saved.case.rowVersion).toBe(2);
    const row = db.prepare('SELECT answers_enc FROM answer_versions WHERE id = ?').get(saved.answerVersion.id) as { answers_enc: string };
    expect(row.answers_enc).not.toContain('照片');
    const second = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'b' });
    expect(second.case.id).not.toBe(first.case.id);
    expect((db.prepare('SELECT deleted_at FROM cases WHERE id = ?').get(first.case.id) as { deleted_at: string | null }).deleted_at).toBe(NOW);
    expect((db.prepare('SELECT COUNT(*) AS count FROM cases WHERE applicant_id = ? AND state = \'draft\' AND deleted_at IS NULL').get(IDS.applicant) as { count: number }).count).toBe(1);
  });
  it('replays idempotency and rejects stale etags/submitted mutation', () => {
    const s = service(); const created = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'same' }); expect(s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'same' }).case.id).toBe(created.case.id);
    const saved = s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: '"1"', idempotencyKey: 'one' });
    expect(() => s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { ...answers, material: '新' }, ifMatch: '"1"', idempotencyKey: 'two' })).toThrowError(CaseCommandError);
    db.prepare("UPDATE cases SET state='submitted' WHERE id=?").run(created.case.id);
    expect(() => s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: `"${saved.case.rowVersion}"`, idempotencyKey: 'three' })).toThrowError(CaseCommandError);
  });

  it('returns only the current answer version for an unchanged body after history diverges', () => {
    const s = service(); const created = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'history-case' });
    const first = s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: '"1"', idempotencyKey: 'history-a' });
    const second = s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { ...answers, material: '第二版' }, ifMatch: '"2"', idempotencyKey: 'history-b' });
    expect(() => s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: '"3"', idempotencyKey: 'history-c' })).toThrowError(CaseCommandError);
    expect(first.answerVersion.id).not.toBe(second.answerVersion.id);
    expect((db.prepare('SELECT current_answer_version_id FROM cases WHERE id=?').get(created.case.id) as { current_answer_version_id: string }).current_answer_version_id).toBe(second.answerVersion.id);
  });

  it('fails closed when an idempotency key contains only a provisional response', () => {
    const crypto = cryptoForTests();
    reserveApplicantMutation({ database: db, crypto, applicantId: IDS.applicant, method: 'POST', normalizedRoute: '/api/v1/cases', idempotencyKey: 'provisional', requestProjection: { programCycleId: IDS.cycle }, now: new Date(NOW) });
    expect(() => service().create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'provisional' })).toThrow('Idempotency replay is unavailable');
  });

  it('reuses a confirmed passport into a new draft case', () => {
    const crypto = cryptoForTests();
    const s = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'source-case' });
    const answer = s.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers, ifMatch: '"1"', idempotencyKey: 'source-answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    db.prepare("UPDATE cases SET state='submitted' WHERE id=?").run(created.case.id);

    const reused = s.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'reuse-case', reuseFromCaseId: created.case.id });
    expect(reused.reused).toBe(true);
    expect(reused.case.id).not.toBe(created.case.id);
    expect(reused.case.state).toBe('draft');
    const row = db.prepare('SELECT current_answer_version_id, current_passport_version_id FROM cases WHERE id=?').get(reused.case.id) as {
      current_answer_version_id: string | null;
      current_passport_version_id: string | null;
    };
    expect(row.current_answer_version_id).toBeTruthy();
    expect(row.current_passport_version_id).toBeTruthy();
    expect((db.prepare('SELECT workflow_state FROM passport_versions WHERE id=?').get(row.current_passport_version_id) as { workflow_state: string }).workflow_state).toBe('needs_applicant_confirmation');
  });
});
