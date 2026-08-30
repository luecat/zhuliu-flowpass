import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto, type Keyring } from '../../../../../../../server/crypto/field-crypto';
import { openDatabase } from '../../../../../../../server/db/connection';
import { migrateDatabase } from '../../../../../../../server/db/migrate';
import { clearPublicRuntime, configurePublicRuntime } from '../../../../../../../server/public/runtime';
import { PATCH } from './route';

const STAMP = '2026-08-30T00:00:00.000Z';
const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x38) : undefined } satisfies Keyring);

describe('PATCH /api/v1/cases/:caseId/document-fields/:fieldId', () => {
  let db: ReturnType<typeof openDatabase>; let applicantId: string; let caseId: string; let fieldId: string;
  beforeEach(() => {
    db = openDatabase(':memory:'); migrateDatabase(db); applicantId = uuidv7(); caseId = uuidv7(); fieldId = uuidv7();
    const cycle = uuidv7(); const rule = uuidv7(); const documentId = uuidv7();
    db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicantId, 'enc', 'active', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cycle, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rule, cycle, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
    db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, 'CASE', applicantId, cycle, rule, 'draft', STAMP, STAMP, 1);
    db.prepare('INSERT INTO documents (id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(documentId, caseId, 'invoice', 'A'.repeat(43), 'test-v1', 'hash', 'image/png', 1, 'enc', 'ready', 'applicant', applicantId, STAMP, 1);
    db.prepare('INSERT INTO document_fields (id, document_id, field_name, original_value_enc, normalized_value_enc, normalized_value_hmac, confidence, source_ocr_run_id, source_page, source_box_enc, parser_reason_code, effective_review_id, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL, ?, NULL, ?)').run(fieldId, documentId, 'vendor_or_tool', 0.5, 1, 'fixture', STAMP);
    configurePublicRuntime({ database: db, crypto, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: () => true, verifyApplicantCsrf: () => ({ applicantId }) } } as never);
  });
  afterEach(() => { clearPublicRuntime(); db.close(); });

  it('appends an encrypted applicant review and returns 201 with the new case ETag', async () => {
    const response = await PATCH(new Request(`http://127.0.0.1:38100/api/v1/cases/${caseId}/document-fields/${fieldId}`, { method: 'PATCH', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'field-review', 'if-match': '"1"', 'content-type': 'application/json' }, body: JSON.stringify({ value: '新店家' }) }), { params: Promise.resolve({ caseId, fieldId }) });
    expect(response.status).toBe(201);
    expect((await response.json()).data.fieldId).toBe(fieldId);
    expect((db.prepare('SELECT decision, value_enc FROM document_field_reviews WHERE document_field_id = ?').get(fieldId) as { decision: string; value_enc: string }).decision).toBe('corrected');
  });
});
