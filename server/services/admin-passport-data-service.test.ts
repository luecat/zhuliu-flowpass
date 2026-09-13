import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { openMigratedDatabase } from '../db/connection';
import { collectPassportRelationGraph } from '../db/admin-passport-relation-registry';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { getAdminPassportDataSnapshot } from './admin-passport-data-service';

const NOW = '2026-09-01T02:00:00.000Z';

describe('admin passport data snapshot', () => {
  let root: string;
  let database: FlowPassDatabase;
  let crypto: FieldCrypto;
  let applicantId: string;
  let targetCaseId: string;
  let siblingCaseId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-admin-data-'));
    database = openMigratedDatabase(join(root, 'flowpass.sqlite3'));
    crypto = new FieldCrypto({
      activeKeyId: 'test-v1',
      getMasterKey: (keyId) => keyId === 'test-v1' ? new Uint8Array(32).fill(7) : undefined,
    });
    applicantId = uuidv7();
    targetCaseId = uuidv7();
    siblingCaseId = uuidv7();
    const cycleId = uuidv7();
    const ruleId = uuidv7();
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)').run(
      applicantId,
      encryptDatabaseText(crypto, 'applicants', 'display_label_enc', applicantId, '王小竹'),
      'active', NOW, NOW,
    );
    database.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, 'SOFTWARE-2026', '軟體補助申請', 2026, 'active', '{}', ?, ?, 1)`).run(cycleId, NOW, NOW);
    database.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, 1, 'published', 5000, 10000, 'floor', '[]', '{}', ?)`).run(ruleId, cycleId, NOW);

    for (const [caseId, code, software] of [[targetCaseId, 'FP-20260901-TARGET', 'Photo Pro'], [siblingCaseId, 'FP-20260901-SIBLING', 'Other App']] as const) {
      const answerId = uuidv7();
      const passportId = uuidv7();
      const versionId = uuidv7();
      database.prepare(`INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, current_answer_version_id, current_passport_version_id, requested_amount_twd, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 'under_review', ?, ?, 200, ?, ?, 3)`).run(caseId, code, applicantId, cycleId, ruleId, answerId, versionId, NOW, NOW);
      const answers = JSON.stringify({ material: '照片', aiPurpose: '整理', sensitiveData: '沒有', destinationAndAudience: '自己', applicantName: '測試申請人' });
      database.prepare('INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(
        answerId, caseId, encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', answerId, answers), 'a'.repeat(64), applicantId, NOW,
      );
      database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, caseId, NOW);
      const payload = JSON.stringify({ project: { softwareName: software, amount: 200 }, nodes: [], edges: [] });
      database.prepare(`INSERT INTO passport_versions (id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id, program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at) VALUES (?, ?, 1, 'applicant_revision', 'confirmed', 'v1', ?, ?, ?, ?, 'applicant', ?, ?)`).run(
        versionId, passportId, answerId, ruleId, encryptDatabaseText(crypto, 'passport_versions', 'payload_enc', versionId, payload), 'b'.repeat(64), applicantId, NOW,
      );
      const details = JSON.stringify({ billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null, softwareName: software, companyName: '竹流', purchaseDate: '2026-09-01', payerType: 'self_card', originalCurrency: 'TWD', otherCurrency: null, originalExpense: '200', convertedTwd: 200, specialStatus: false, invoiceNumber: null, paymentSourceFingerprint: null, subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31', applicantName: '測試申請人' });
      database.prepare('INSERT INTO case_purchase_details (case_id, details_enc, content_sha256, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)').run(
        caseId, encryptDatabaseText(crypto, 'case_purchase_details', 'details_enc', caseId, details), 'c'.repeat(64), NOW, NOW,
      );
    }

    const targetDocument = uuidv7();
    database.prepare(`INSERT INTO documents (id, case_id, kind, requirement_key, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, 'invoice', 'purchase_proof', ?, 'test-v1', ?, 'application/pdf', 123, ?, 'ready', 'applicant', ?, ?, 1)`).run(
      targetDocument, targetCaseId, 'A'.repeat(43), 'd'.repeat(64), encryptDatabaseText(crypto, 'documents', 'original_name_enc', targetDocument, '發票.pdf'), applicantId, NOW,
    );
    const jobId = uuidv7();
    database.prepare(`INSERT INTO jobs (id, job_type, payload_json, state, unique_key, attempts, max_attempts, available_at, created_at) VALUES (?, 'ai_draft', ?, 'completed', ?, 1, 3, ?, ?)`).run(jobId, JSON.stringify({ caseId: targetCaseId }), `ai:${targetCaseId}`, NOW, NOW);
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('collects only the selected passport graph and preserves sibling context', () => {
    const graph = collectPassportRelationGraph(database, targetCaseId, crypto);
    expect(graph).not.toBeNull();
    expect(graph?.preservedSiblingCases).toBe(1);
    expect(graph?.tableIds.cases).toEqual([targetCaseId]);
    expect(graph?.tableIds.jobs).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toContain(siblingCaseId);
  });

  it('returns decrypted grouped data without ciphertext or shared sibling records', () => {
    const snapshot = getAdminPassportDataSnapshot(database, crypto, targetCaseId);
    expect(snapshot).toMatchObject({ caseCode: 'FP-20260901-TARGET', applicantLabel: '王小竹', stateLabel: '審查中' });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('Photo Pro');
    expect(serialized).toContain('發票.pdf');
    expect(serialized).not.toContain('Other App');
    expect(serialized).not.toContain(siblingCaseId);
    expect(serialized).not.toMatch(/ciphertext|nonce|tag/);
    expect(snapshot?.groups.map((group) => group.label)).toHaveLength(9);
    const rawCase = snapshot?.groups.flatMap((group) => group.records).find((record) => record.table === 'cases');
    expect(rawCase?.fields.find((item) => item.key === 'case_code')?.editable).toBe(false);
    expect(rawCase?.fields.find((item) => item.key === 'state')?.editable).toBe(true);
  });
});
