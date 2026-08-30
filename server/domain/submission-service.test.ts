import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createCaseService } from './case-service';
import { createPassportLifecycle } from './passport-lifecycle';
import { SubmissionCommandError, createSubmissionService } from './submission-service';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import { inspectPassportDocument } from './passport-validation';
import type { FlowPassPassport } from '../../shared/passport-contract';

const IDS = { applicant: '0198f050-0000-7000-8000-000000000001', cycle: '0198f050-0000-7000-8000-000000000002', rule: '0198f050-0000-7000-8000-000000000003', docsCycle: '0198f050-0000-7000-8000-000000000004', docsRule: '0198f050-0000-7000-8000-000000000005' };
const NOW = '2026-08-30T00:00:00.000Z';

function cryptoForTests(): FieldCrypto { const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined }; return new FieldCrypto(keyring); }
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

  it('submits once after confirmation, evaluates OCR evidence and takes server transaction time', () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.cycle, idempotencyKey: 'case' });
    const answer = cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    const invoiceDocumentId = '0198f050-0000-7000-8000-000000000020';
    const duplicateDocumentId = '0198f050-0000-7000-8000-000000000021';
    const ocrRunId = '0198f050-0000-7000-8000-000000000022';
    db.prepare('INSERT INTO documents (id,case_id,kind,storage_id,key_id,content_sha256,media_type,byte_size,original_name_enc,status,uploaded_by_type,uploaded_by_id,created_at,deleted_at,row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(invoiceDocumentId, created.case.id, 'invoice', `storage-${invoiceDocumentId}`, 'key-v1', 'invoice-hash', 'application/pdf', 10, 'enc', 'ready', 'applicant', IDS.applicant, NOW, null, 1);
    db.prepare('INSERT INTO documents (id,case_id,kind,storage_id,key_id,content_sha256,media_type,byte_size,original_name_enc,status,uploaded_by_type,uploaded_by_id,created_at,deleted_at,row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(duplicateDocumentId, created.case.id, 'invoice', `storage-${duplicateDocumentId}`, 'key-v1', 'duplicate-hash', 'application/pdf', 10, 'enc', 'ready', 'applicant', IDS.applicant, NOW, null, 1);
    db.prepare('INSERT INTO ocr_runs (id,document_id,engine,engine_version,status,result_enc,result_sha256,failure_code,started_at,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(ocrRunId, invoiceDocumentId, 'manual', 'test', 'completed', null, null, null, NOW, NOW, NOW);
    const fields = [
      ['invoice_number', 'AB123456'],
      ['invoice_at', '2026-08-30T00:00:00Z'],
      ['purchase_at', '2026-08-30T00:00:00Z'],
      ['amount_minor', '100000'],
      ['currency', 'TWD'],
    ] as const;
    fields.forEach(([fieldName, value], index) => {
      const fieldId = `0198f050-0000-7000-8000-${String(30 + index).padStart(12, '0')}`;
      db.prepare('INSERT INTO document_fields (id,document_id,field_name,original_value_enc,normalized_value_enc,normalized_value_hmac,confidence,source_ocr_run_id,source_page,source_box_enc,parser_reason_code,effective_review_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fieldId, invoiceDocumentId, fieldName, encryptDatabaseText(crypto, 'document_fields', 'original_value_enc', fieldId, value), encryptDatabaseText(crypto, 'document_fields', 'normalized_value_enc', fieldId, value), crypto.hmacLookup(value, 'document-normalized-value'), 0.95, ocrRunId, 1, null, 'fixture', null, NOW);
    });
    db.prepare('INSERT INTO invoice_fingerprints (id,document_id,case_id,fingerprint_hmac,created_at) VALUES (?,?,?,?,?)').run('0198f050-0000-7000-8000-000000000024', duplicateDocumentId, created.case.id, crypto.hmacLookup('AB123456', 'invoice-fingerprint'), NOW);
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
    expect((db.prepare('SELECT outcome FROM rule_evaluations WHERE case_id=? AND evaluation_kind=\'invoice\' ORDER BY created_at DESC, id DESC LIMIT 1').get(created.case.id) as { outcome: string }).outcome).toBe('needs_review');
    expect((db.prepare('SELECT calculated_amount_twd FROM subsidy_calculations WHERE case_id=?').get(created.case.id) as { calculated_amount_twd: number }).calculated_amount_twd).toBe(500);
    expect((db.prepare('SELECT COUNT(*) AS count FROM invoice_fingerprints WHERE case_id=?').get(created.case.id) as { count: number }).count).toBe(2);
    expect((db.prepare('SELECT result_json FROM rule_evaluations WHERE case_id=?').all(created.case.id) as Array<{ result_json: string }>).every((row) => !row.result_json.includes('AB123456'))).toBe(true);
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

  it('rejects a required document until its upload and OCR are terminal', () => {
    const crypto = cryptoForTests();
    const cases = createCaseService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'req' });
    const created = cases.create({ applicantId: IDS.applicant, programCycleId: IDS.docsCycle, idempotencyKey: 'case' });
    const answer = cases.saveAnswers({ applicantId: IDS.applicant, caseId: created.case.id, answers: { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊' }, ifMatch: '"1"', idempotencyKey: 'answers' });
    const lifecycle = createPassportLifecycle({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}` });
    const draft = lifecycle.createVersion({ caseId: created.case.id, answerVersionId: answer.answerVersion.id, passport: passport(), origin: 'ai_draft', actorType: 'system', actorId: 'worker' });
    const confirmed = lifecycle.confirmVersion({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: draft.version.id, ifMatch: '"1"', declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
    const service = createSubmissionService({ database: db, crypto, clock: () => new Date(NOW), idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, requestIdGenerator: () => 'submit-request' });
    const documentId = `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`;
    db.prepare('INSERT INTO documents (id,case_id,kind,storage_id,key_id,content_sha256,media_type,byte_size,original_name_enc,status,uploaded_by_type,uploaded_by_id,created_at,deleted_at,row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(documentId, created.case.id, 'invoice', `storage-${documentId}`, 'key-v1', 'sha256', 'application/pdf', 10, 'invoice.pdf', 'ready', 'applicant', IDS.applicant, NOW, null, 1);
    db.prepare('INSERT INTO ocr_runs (id,document_id,engine,engine_version,status,result_enc,result_sha256,failure_code,started_at,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`, documentId, 'manual', 'test', 'failed', null, null, 'ocr_failed', NOW, NOW, NOW);
    expect(() => service.submit({ applicantId: IDS.applicant, caseId: created.case.id, passportVersionId: confirmed.id, ifMatch: '"2"' })).toThrowError(SubmissionCommandError);
  });
});
