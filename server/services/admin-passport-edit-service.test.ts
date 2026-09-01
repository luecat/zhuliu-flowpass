import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { openMigratedDatabase } from '../db/connection';
import { decryptDatabaseText, encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { AdminPassportEditError, editAdminPassportField } from './admin-passport-edit-service';

const NOW = '2026-09-01T03:00:00.000Z';

describe('admin passport field editor', () => {
  let root: string;
  let database: FlowPassDatabase;
  let crypto: FieldCrypto;
  let adminId: string;
  let applicantId: string;
  let caseId: string;
  let answerId: string;
  let passportVersionId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-admin-edit-'));
    database = openMigratedDatabase(join(root, 'flowpass.sqlite3'));
    crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? new Uint8Array(32).fill(9) : undefined });
    adminId = uuidv7();
    applicantId = uuidv7();
    caseId = uuidv7();
    answerId = uuidv7();
    passportVersionId = uuidv7();
    const cycleId = uuidv7();
    const ruleId = uuidv7();
    const passportId = uuidv7();
    database.prepare(`INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, 'admin', 'hash', 'active', ?, 1)`).run(adminId, NOW);
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)').run(applicantId, encryptDatabaseText(crypto, 'applicants', 'display_label_enc', applicantId, '測試申請人'), 'active', NOW, NOW);
    database.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, 'SOFTWARE-2026', '軟體補助申請', 2026, 'active', '{}', ?, ?, 1)`).run(cycleId, NOW, NOW);
    database.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, 1, 'published', 5000, 10000, 'floor', '[]', '{}', ?)`).run(ruleId, cycleId, NOW);
    database.prepare(`INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, current_answer_version_id, current_passport_version_id, requested_amount_twd, calculated_amount_twd, created_at, updated_at, row_version) VALUES (?, 'FP-EDIT', ?, ?, ?, 'under_review', ?, ?, 1000, 500, ?, ?, 5)`).run(caseId, applicantId, cycleId, ruleId, answerId, passportVersionId, NOW, NOW);
    const answers = JSON.stringify({ material: '照片', aiPurpose: '整理', sensitiveData: '沒有', destinationAndAudience: '自己' });
    database.prepare('INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(answerId, caseId, encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', answerId, answers), 'a'.repeat(64), applicantId, NOW);
    database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, caseId, NOW);
    const passport = {
      use_case: { title: '影像整理', purpose: '整理照片', intended_outcome: '完成分類' },
      nodes: [{ id: 'node-1', kind: 'data', label: '照片', data_category: 'photo', sensitivity: 'low', source_field: 'materials', source_excerpt: '[not retained]', confidence: 1, needs_confirmation: false }],
      edges: [],
      sharing_scope: { audience: 'self', source_field: 'destination_and_audience', source_excerpt: '[not retained]', needs_confirmation: false },
      retention: { storage_location: '本機', duration: '30 天', deletion_plan: '手動刪除', needs_confirmation: false },
      safety_actions: [], follow_up_questions: [],
      administrative_hints: { requested_tool: 'unknown', invoice_fields_required: ['tool_name', 'purchase_date', 'amount', 'invoice_number'], subsidy_calculation: 'not_performed_by_ai', requires_officer_review: true },
      audit: { draft_status: 'ai_generated_unconfirmed', rules_version: 'hackathon-mvp-2026-08-27', unknown_fields: [] },
    };
    database.prepare(`INSERT INTO passport_versions (id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id, program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at) VALUES (?, ?, 1, 'applicant_revision', 'confirmed', 'flowpass.passport.v1', ?, ?, ?, ?, 'applicant', ?, ?)`).run(passportVersionId, passportId, answerId, ruleId, encryptDatabaseText(crypto, 'passport_versions', 'payload_enc', passportVersionId, JSON.stringify(passport)), 'b'.repeat(64), applicantId, NOW);
    database.prepare(`INSERT INTO passport_node_index (id, passport_version_id, node_key, kind, data_category, sensitivity, needs_confirmation) VALUES (?, ?, 'node-1', 'data', 'photo', 'low', 0)`).run(uuidv7(), passportVersionId);
    const details = JSON.stringify({ billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null, softwareName: 'Photo Pro', companyName: '竹流', purchaseDate: '2026-09-01', payerType: 'self_card', originalCurrency: 'TWD', otherCurrency: null, originalExpense: '1000', convertedTwd: 1000, specialStatus: false });
    database.prepare('INSERT INTO case_purchase_details (case_id, details_enc, content_sha256, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)').run(caseId, encryptDatabaseText(crypto, 'case_purchase_details', 'details_enc', caseId, details), 'c'.repeat(64), NOW, NOW);
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function edit(resource: string, recordId: string, field: string, value: unknown, expectedRowVersion = 5) {
    return editAdminPassportField({ database, crypto, caseId, adminId, requestId: uuidv7(), resource, recordId, field, value, expectedRowVersion, now: new Date('2026-09-01T03:01:00.000Z') });
  }

  it('directly overwrites encrypted answers and records a non-sensitive audit', () => {
    const result = edit('answer_versions', answerId, 'material', '新的照片素材');
    expect(result).toEqual({ rowVersion: 6, requiresAiRefresh: true, recalculated: ['補助金額'] });
    const row = database.prepare('SELECT answers_enc, content_sha256 FROM answer_versions WHERE id = ?').get(answerId) as { answers_enc: string; content_sha256: string };
    expect(JSON.parse(decryptDatabaseText(crypto, 'answer_versions', 'answers_enc', answerId, row.answers_enc)).material).toBe('新的照片素材');
    expect(row.answers_enc).not.toContain('新的照片素材');
    expect(row.content_sha256).not.toBe('a'.repeat(64));
    const audit = database.prepare('SELECT field_name, field_type, outcome, requires_ai_refresh FROM admin_data_edit_audits WHERE case_id = ?').get(caseId);
    expect(audit).toEqual({ field_name: 'material', field_type: 'text', outcome: 'ok', requires_ai_refresh: 1 });
    expect(JSON.stringify(database.prepare('PRAGMA table_info(admin_data_edit_audits)').all())).not.toMatch(/old_value|new_value/);
  });

  it('updates purchase details and recalculates the deterministic subsidy', () => {
    const result = edit('case_purchase_details', caseId, 'convertedTwd', 1800);
    expect(result.recalculated).toContain('補助金額');
    expect(database.prepare('SELECT requested_amount_twd, calculated_amount_twd FROM cases WHERE id = ?').get(caseId)).toEqual({ requested_amount_twd: 1800, calculated_amount_twd: 900 });
    expect((database.prepare('SELECT calculated_amount_twd FROM subsidy_calculations WHERE case_id = ? ORDER BY created_at DESC LIMIT 1').get(caseId) as { calculated_amount_twd: number }).calculated_amount_twd).toBe(900);
  });

  it('re-encrypts a passport leaf and rebuilds its indexes', () => {
    const result = edit('passport_versions', passportVersionId, 'nodes.0.label', '新的照片來源');
    expect(result.recalculated).toContain('護照索引');
    const row = database.prepare('SELECT payload_enc FROM passport_versions WHERE id = ?').get(passportVersionId) as { payload_enc: string };
    const payload = JSON.parse(decryptDatabaseText(crypto, 'passport_versions', 'payload_enc', passportVersionId, row.payload_enc));
    expect(payload.nodes[0].label).toBe('新的照片來源');
    expect(database.prepare('SELECT node_key, kind FROM passport_node_index WHERE passport_version_id = ?').all(passportVersionId)).toEqual([{ node_key: 'node-1', kind: 'data' }]);
  });

  it('rejects stale rows, structural fields and invalid values', () => {
    expect(() => edit('cases', caseId, 'case_code', 'CHANGED')).toThrowError(new AdminPassportEditError('LOCKED_FIELD'));
    expect(() => edit('cases', caseId, 'state', 'not-a-state')).toThrowError(new AdminPassportEditError('INVALID_VALUE'));
    expect(() => edit('cases', caseId, 'state', 'approved', 4)).toThrowError(new AdminPassportEditError('ROW_CONFLICT'));
    expect(() => edit('passport_versions', passportVersionId, 'nodes.0.id', 'changed')).toThrowError(new AdminPassportEditError('LOCKED_FIELD'));
  });
});
