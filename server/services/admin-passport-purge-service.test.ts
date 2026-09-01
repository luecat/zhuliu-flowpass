import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { flowPassDatabasePath, openMigratedDatabase } from '../db/connection';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { hashBootstrapAdminPassword } from '../admin/auth/password';
import { DocumentVault } from './document-vault';
import { createVerifiedBackupFromDatabase } from '../../scripts/backup';
import { authorizePassportPurge, executePassportPurge, previewPassportPurge } from './admin-passport-purge-service';

const NOW = '2026-09-01T04:00:00.000Z';

describe('single passport purge', () => {
  let root: string;
  let backupRoot: string;
  let database: FlowPassDatabase;
  let crypto: FieldCrypto;
  let vault: DocumentVault;
  let adminId: string;
  let applicantId: string;
  let caseId: string;
  let siblingCaseId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-purge-'));
    backupRoot = join(root, 'backups');
    database = openMigratedDatabase(flowPassDatabasePath(root));
    crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? new Uint8Array(32).fill(4) : undefined });
    vault = new DocumentVault({ rootPath: join(root, 'vault'), crypto });
    adminId = uuidv7(); applicantId = uuidv7(); caseId = uuidv7(); siblingCaseId = uuidv7();
    const cycleId = uuidv7(); const ruleId = uuidv7();
    database.prepare(`INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, 'admin', ?, 'active', ?, 1)`).run(adminId, await hashBootstrapAdminPassword('admin'), NOW);
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)').run(applicantId, encryptDatabaseText(crypto, 'applicants', 'display_label_enc', applicantId, '清除測試'), 'active', NOW, NOW);
    database.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, 'SOFTWARE-2026', '軟體補助申請', 2026, 'active', '{}', ?, ?, 1)`).run(cycleId, NOW, NOW);
    database.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, 1, 'published', 5000, 10000, 'floor', '[]', '{}', ?)`).run(ruleId, cycleId, NOW);
    for (const [id, code] of [[caseId, 'FP-PURGE-TARGET'], [siblingCaseId, 'FP-PURGE-SIBLING']] as const) {
      const answerId = uuidv7(); const passportId = uuidv7(); const versionId = uuidv7();
      database.prepare(`INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, current_answer_version_id, current_passport_version_id, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 'under_review', ?, ?, ?, ?, 1)`).run(id, code, applicantId, cycleId, ruleId, answerId, versionId, NOW, NOW);
      database.prepare('INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(answerId, id, encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', answerId, '{}'), createHashValue(code), applicantId, NOW);
      database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, id, NOW);
      database.prepare(`INSERT INTO passport_versions (id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id, program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at) VALUES (?, ?, 1, 'applicant_revision', 'confirmed', 'v1', ?, ?, ?, ?, 'applicant', ?, ?)`).run(versionId, passportId, answerId, ruleId, encryptDatabaseText(crypto, 'passport_versions', 'payload_enc', versionId, '{}'), createHashValue(`${code}-passport`), applicantId, NOW);
    }
    const documentId = uuidv7(); const prepared = vault.prepare({ documentId, bytes: new Uint8Array([1, 2, 3]) }); vault.commit(prepared);
    database.prepare(`INSERT INTO documents (id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, 'invoice', ?, ?, ?, 'application/pdf', 3, ?, 'ready', 'applicant', ?, ?, 1)`).run(documentId, caseId, prepared.storageId, prepared.keyId, createHashValue('blob'), encryptDatabaseText(crypto, 'documents', 'original_name_enc', documentId, 'target.pdf'), applicantId, NOW);
    await createVerifiedBackupFromDatabase({ database, backupRoot, name: 'old-backup' });
  });

  afterEach(() => { database.close(); rmSync(root, { recursive: true, force: true }); });

  function createHashValue(value: string): string {
    return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
  }

  it('previews, reauthenticates and completely removes only the target passport', async () => {
    const dependencies = { database, crypto, documentVault: vault, dataRoot: root, backupRoot };
    const preview = previewPassportPurge(dependencies, caseId);
    expect(preview.caseCode).toBe('FP-PURGE-TARGET');
    expect(preview.preservedSiblingCases).toBe(1);
    expect(preview.attachments).toHaveLength(1);
    expect(preview.backups.map((item) => item.name)).toContain('old-backup');
    const authorization = await authorizePassportPurge(dependencies, { caseId, adminId, previewHash: preview.previewHash, caseCode: preview.caseCode, password: 'admin' });
    const result = await executePassportPurge(dependencies, { caseId, adminId, token: authorization.token });
    expect(result.removedRows).toBeGreaterThan(3);
    expect(database.prepare('SELECT id FROM cases WHERE id = ?').get(caseId)).toBeUndefined();
    expect(database.prepare('SELECT id FROM cases WHERE id = ?').get(siblingCaseId)).toBeTruthy();
    expect(existsSync(join(root, 'vault', preview.attachments[0]!.storageId))).toBe(false);
    expect(readdirSync(backupRoot)).toHaveLength(1);
    expect(readdirSync(backupRoot)[0]).toMatch(/^clean-/);
  });
});
