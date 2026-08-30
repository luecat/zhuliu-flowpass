import { describe, expect, it } from 'vitest';
import { runOcrJob } from './run-ocr';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto, type Keyring } from '../../crypto/field-crypto';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';

const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x49) : undefined } satisfies Keyring);
const STAMP = '2026-08-30T00:00:00.000Z';
describe('OCR worker', () => { it('rejects non-OCR jobs', async () => { await expect(runOcrJob({ id: 'j', jobType: 'ai_draft', payload: {}, state: 'leased', uniqueKey: 'u', attempts: 1, maxAttempts: 1, availableAt: '', leaseOwner: 'w', leaseUntil: null, lastErrorCode: null, createdAt: '', completedAt: null }, { workerId: 'w' }, { database: {} as never, crypto: {} as never, ocr: {} as never, bytes: new Uint8Array() })).rejects.toThrow('unsupported OCR job'); }); });

it('persists the selected OCR run and points provenance fields to that immutable run', async () => {
  const db = openDatabase(':memory:'); migrateDatabase(db);
  const applicantId = uuidv7(); const cycleId = uuidv7(); const ruleId = uuidv7(); const caseId = uuidv7(); const documentId = uuidv7();
  db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicantId, 'enc', 'active', STAMP, STAMP, 1);
  db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cycleId, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
  db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ruleId, cycleId, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
  db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, 'CASE', applicantId, cycleId, ruleId, 'draft', STAMP, STAMP, 1);
  db.prepare('INSERT INTO documents (id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(documentId, caseId, 'invoice', 'A'.repeat(43), 'test-v1', 'hash', 'image/png', 1, 'enc', 'ready', 'applicant', applicantId, STAMP, 1);
  const vision = { recognize: async () => ({ engine: 'vision' as const, engineVersion: 'fixture', languages: ['zh-Hant'], lines: [
    { page: 1, text: '發票號碼 AB123456', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
    { page: 1, text: '發票日期 2026/02/03', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
    { page: 1, text: '購買日期 2026/02/03', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
    { page: 1, text: '店家：測試商店', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
    { page: 1, text: '總計 TWD 1,234', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
    { page: 1, text: 'TWD', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } },
  ], durationMs: 1 }) };
  const result = await runOcrJob({ id: uuidv7(), jobType: 'ocr', payload: { documentId }, state: 'leased', uniqueKey: 'ocr', attempts: 1, maxAttempts: 1, availableAt: STAMP, leaseOwner: 'worker', leaseUntil: null, lastErrorCode: null, createdAt: STAMP, completedAt: null }, { workerId: 'worker' }, { database: db, crypto, ocr: { vision }, bytes: new Uint8Array([1]), clock: () => new Date(STAMP), idGenerator: uuidv7 });
  expect(result.manualReview).toBe(false);
  const run = db.prepare('SELECT id, engine, status FROM ocr_runs WHERE document_id = ?').get(documentId) as { id: string; engine: string; status: string };
  expect(run.engine).toBe('vision'); expect(run.status).toBe('completed'); expect((db.prepare('SELECT source_ocr_run_id FROM document_fields WHERE document_id = ?').get(documentId) as { source_ocr_run_id: string }).source_ocr_run_id).toBe(run.id);
  db.close();
});
