import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { insertEncryptedDocumentFieldForSystem, insertEncryptedOcrRawPayloadForSystem, insertEncryptedOcrRunForSystem } from '../db/repositories/documents';
import { purgeExpiredRawOcr } from './retention-service';

const STAMP = '2026-08-30T00:00:00.000Z';
const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x71) : undefined } satisfies Keyring);

function fixture(policy: string, closedAt = STAMP): { db: ReturnType<typeof openDatabase>; documentId: string; fieldId: string; rawId: string } {
  const db = openDatabase(':memory:'); migrateDatabase(db);
  const applicantId = uuidv7(); const cycleId = uuidv7(); const ruleId = uuidv7(); const caseId = uuidv7(); const documentId = uuidv7(); const runId = uuidv7(); const fieldId = uuidv7(); const rawId = uuidv7();
  db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicantId, 'enc', 'active', STAMP, STAMP, 1);
  db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cycleId, 'TEST', 'Test', 2026, 'active', policy, STAMP, STAMP, 1);
  db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ruleId, cycleId, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
  db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, closed_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, `CASE-${caseId}`, applicantId, cycleId, ruleId, 'closed', closedAt, STAMP, STAMP, 1);
  db.prepare('INSERT INTO documents (id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(documentId, caseId, 'invoice', `storage-${documentId}`, 'test-v1', 'hash', 'image/png', 1, 'enc', 'ready', 'applicant', applicantId, STAMP, 1);
  insertEncryptedOcrRunForSystem(db, { systemId: 'fixture' }, crypto, { id: runId, documentId, engine: 'vision', engineVersion: 'fixture', status: 'completed', result: null, resultSha256: 'hash', failureCode: null, startedAt: STAMP, finishedAt: STAMP, createdAt: STAMP });
  insertEncryptedDocumentFieldForSystem(db, { systemId: 'fixture' }, crypto, { id: fieldId, documentId, fieldName: 'amount_minor', originalValue: '原始值', normalizedValue: '100', confidence: 0.9, sourceOcrRunId: runId, sourcePage: 1, sourceBox: JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }), parserReasonCode: 'fixture', createdAt: STAMP });
  insertEncryptedOcrRawPayloadForSystem(db, { systemId: 'fixture' }, crypto, { id: rawId, ocrRunId: runId, payload: '{"lines":[{"text":"原始發票"}]}', createdAt: STAMP });
  return { db, documentId, fieldId, rawId };
}

describe('OCR retention', () => {
  it('purges raw OCR and unreviewed normalized values after the policy window', () => {
    const { db, documentId, fieldId, rawId } = fixture('{"rawOcrRetentionDays":1}');
    const result = purgeExpiredRawOcr({ database: db, crypto, now: new Date('2026-09-01T00:00:00.000Z'), idGenerator: uuidv7 });
    expect(result).toMatchObject({ examined: 1, purged: 1 });
    expect(db.prepare('SELECT payload_enc, purged_at FROM ocr_raw_payloads WHERE id = ?').get(rawId)).toEqual({ payload_enc: null, purged_at: '2026-09-01T00:00:00.000Z' });
    expect(db.prepare('SELECT original_value_enc, normalized_value_enc, source_box_enc FROM document_fields WHERE id = ?').get(fieldId)).toEqual({ original_value_enc: null, normalized_value_enc: null, source_box_enc: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'ocr_raw_payload'").get()).toEqual({ count: 1 });
    expect(documentId).toBeTruthy();
    db.close();
  });

  it('retains reviewed normalized fields and blocks legal-hold cases', () => {
    const { db, fieldId, rawId } = fixture('{"rawOcrRetentionDays":0,"legalHold":true}');
    const result = purgeExpiredRawOcr({ database: db, crypto, now: new Date('2026-09-01T00:00:00.000Z') });
    expect(result).toMatchObject({ examined: 1, purged: 0, skippedLegalHold: 1 });
    expect((db.prepare('SELECT payload_enc FROM ocr_raw_payloads WHERE id = ?').get(rawId) as { payload_enc: string | null }).payload_enc).toEqual(expect.any(String));
    expect((db.prepare('SELECT normalized_value_enc FROM document_fields WHERE id = ?').get(fieldId) as { normalized_value_enc: string | null }).normalized_value_enc).toEqual(expect.any(String));
    db.close();
  });
});

