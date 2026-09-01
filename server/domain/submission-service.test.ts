import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createCaseService } from './case-service';
import { createPassportLifecycle } from './passport-lifecycle';
import { SubmissionCommandError, createSubmissionService } from './submission-service';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import { inspectPassportDocument } from './passport-validation';
import type { FlowPassPassport } from '../../shared/passport-contract';
import { upsertPurchaseDetailsForApplicant } from '../db/repositories/purchase-details';
import type { DocumentRequirementKey, PurchaseDetails } from '../../shared/purchase-details-contract';

const IDS = { applicant: '0198f050-0000-7000-8000-000000000001', cycle: '0198f050-0000-7000-8000-000000000002', rule: '0198f050-0000-7000-8000-000000000003', docsCycle: '0198f050-0000-7000-8000-000000000004', docsRule: '0198f050-0000-7000-8000-000000000005' };
const NOW = '2026-08-30T00:00:00.000Z';

function cryptoForTests(): FieldCrypto { const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined }; return new FieldCrypto(keyring); }
const PURCHASE_DETAILS: PurchaseDetails = { billingCycle: 'annual', billingPeriods: null, softwareFunction: 'imaging', otherFunction: null, softwareName: '影像工具', companyName: 'Example Inc.', purchaseDate: '2026-08-30', payerType: 'self_card', originalCurrency: 'TWD', otherCurrency: null, originalExpense: '1000', convertedTwd: 1000, specialStatus: false };

function savePurchaseDetails(db: ReturnType<typeof openDatabase>, crypto: FieldCrypto, caseId: string, details: PurchaseDetails = PURCHASE_DETAILS): void {
  upsertPurchaseDetailsForApplicant(db, { applicantId: IDS.applicant }, crypto, { caseId, details, now: NOW });
}

function insertReadyDocument(db: ReturnType<typeof openDatabase>, caseId: string, id: string, requirementKey: DocumentRequirementKey): void {
  const kind = requirementKey === 'purchase_proof' ? 'invoice' : requirementKey === 'passbook_cover' ? 'supplement' : requirementKey === 'affidavit' || requirementKey === 'representative_affidavit' ? 'other' : 'eligibility_proof';
  db.prepare('INSERT INTO documents (id,case_id,kind,requirement_key,storage_id,key_id,content_sha256,media_type,byte_size,original_name_enc,status,uploaded_by_type,uploaded_by_id,created_at,deleted_at,row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, caseId, kind, requirementKey, `storage-${id}`, 'key-v1', `hash-${id}`, 'application/pdf', 10, 'enc', 'ready', 'applicant', IDS.applicant, NOW, null, 1);
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

describe('submission service', () => {
  let dir: string; let db: ReturnType<typeof openDatabase>; let ids = 10;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-task8-submit-')); db = openDatabase(join(dir, 'flowpass.sqlite')); migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.docsCycle, 'DOCS', '文件示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.docsRule, IDS.docsCycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '["invoice"]', '{}', NOW, NOW);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('submits once after confirmation and takes server transaction time', () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    const answer = cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    const invoiceDocumentId = '0198f050-0000-7000-8000-000000000020';
    savePurchaseDetails(db, crypto, created.case.id);
    insertReadyDocument(db, created.case.id, invoiceDocumentId, 'purchase_proof');
    insertReadyDocument(db, created.case.id, '0198f050-0000-7000-8000-000000000040', 'identity_front');
    insertReadyDocument(db, created.case.id, '0198f050-0000-7000-8000-000000000041', 'identity_back');
    insertReadyDocument(db, created.case.id, '0198f050-0000-7000-8000-000000000042', 'passbook_cover');
    insertReadyDocument(db, created.case.id, '0198f050-0000-7000-8000-000000000043', 'affidavit');
    const service = createSubmissionService({ database: db, crypto, clock: () => new Date('2026-08-30T01:02:03.000Z'), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'submit-request' });
    const confirmed = lifecycle.getForApplicant({ applicantId: IDS.applicant, caseId: created.case.id });
    if (!confirmed) throw new Error('confirmed passport missing');
    const currentCase = db.prepare('SELECT row_version FROM cases WHERE id=?').get(created.case.id) as { row_version: number };
    const result = service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: confirmed.version.id, ifMatch: `"${currentCase.row_version}"` });
    expect(result.case.state).toBe('submitted');
    expect(result.case.calculatedAmountTwd).toBe(500);
    expect(result.submittedAt).toBe('2026-08-30T01:02:03.000Z');
    expect((db.prepare('SELECT COUNT(*) AS count FROM case_state_transitions WHERE case_id=? AND to_state=\'submitted\'').get(created.case.id) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM notification_jobs WHERE case_id=?').get(created.case.id) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_evaluations WHERE case_id=?').get(created.case.id) as { count: number }).count).toBe(4);
    expect((db.prepare('SELECT outcome FROM rule_evaluations WHERE case_id=? AND evaluation_kind=\'invoice\' ORDER BY created_at DESC, id DESC LIMIT 1').get(created.case.id) as { outcome: string }).outcome).toBe('missing');
    expect((db.prepare('SELECT calculated_amount_twd FROM subsidy_calculations WHERE case_id=?').get(created.case.id) as { calculated_amount_twd: number }).calculated_amount_twd).toBe(500);
    expect(() => service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: confirmed.version.id, ifMatch: '"4"' })).toThrowError(SubmissionCommandError);
  });

  it('rejects submission when passport is not confirmed or the case ETag is stale', () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    const answer = cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    const service = createSubmissionService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'submit-request' });
    expect(() => service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"' })).toThrowError(SubmissionCommandError);
    expect(() => service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"9"' })).toThrowError(SubmissionCommandError);
  });

  it('requires every attachment before submission', () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.docsCycle, idempotencyKey: 'case' });
    const answer = cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    const confirmed = lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    const service = createSubmissionService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'submit-request' });
    savePurchaseDetails(db, crypto, created.case.id);
    insertReadyDocument(db, created.case.id, `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, 'purchase_proof');
    insertReadyDocument(db, created.case.id, `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, 'identity_front');
    insertReadyDocument(db, created.case.id, `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, 'passbook_cover');
    insertReadyDocument(db, created.case.id, `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, 'affidavit');
    const currentVersion = (db.prepare('SELECT row_version FROM cases WHERE id = ?').get(created.case.id) as { row_version: number }).row_version;
    expect(() => service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: confirmed.id, ifMatch: `"${currentVersion}"` })).toThrowError(SubmissionCommandError);
    insertReadyDocument(db, created.case.id, `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, 'identity_back');
    const result = service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: confirmed.id, ifMatch: `"${currentVersion}"` });
    expect(result.case.state).toBe('submitted');
  });
});
