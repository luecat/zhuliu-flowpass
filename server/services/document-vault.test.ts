import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { DocumentVault } from './document-vault';

const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x55) : undefined } satisfies Keyring);
const STAMP = '2026-08-30T00:00:00.000Z';

describe('DocumentVault', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('writes an encrypted temp envelope, fsyncs then atomically commits, and round-trips bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpass-test-vault-')); roots.push(root);
    const vault = new DocumentVault({ rootPath: root, crypto, storageIdFactory: () => 'A'.repeat(43) });
    const documentId = uuidv7();
    const clear = Buffer.from('invoice-plaintext-sentinel');
    const prepared = vault.prepare({ documentId, bytes: clear });
    expect(readFileSync(prepared.tempPath).toString('utf8')).not.toContain('invoice-plaintext-sentinel');
    expect(readFileSync(prepared.tempPath).subarray(0, 1).toString()).toBe('{');
    vault.commit(prepared);
    expect(readdirSync(root).filter((name) => name !== '.tmp')).toEqual(['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']);
    expect(vault.read({ id: documentId, storageId: prepared.storageId, keyId: prepared.keyId })).toEqual(clear);
  });

  it('reconciles a final blob for a pending row only when decrypted bytes match the recorded hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpass-test-vault-')); roots.push(root);
    const vault = new DocumentVault({ rootPath: root, crypto, storageIdFactory: () => 'B'.repeat(43) });
    const db = openDatabase(':memory:'); migrateDatabase(db);
    const ids = { applicant: uuidv7(), cycle: uuidv7(), rule: uuidv7(), case: uuidv7(), document: uuidv7() };
    db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(ids.applicant, 'enc', 'active', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.cycle, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.rule, ids.cycle, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
    db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.case, 'CASE', ids.applicant, ids.cycle, ids.rule, 'draft', STAMP, STAMP, 1);
    const clear = Buffer.from('recovery-bytes');
    const prepared = vault.prepare({ documentId: ids.document, bytes: clear });
    vault.commit(prepared);
    db.prepare(`INSERT INTO documents (id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version) VALUES (?, ?, 'invoice', ?, ?, ?, 'application/pdf', ?, ?, 'pending_vault', 'applicant', ?, ?, 1)`).run(ids.document, ids.case, prepared.storageId, prepared.keyId, createHash('sha256').update(clear).digest('hex'), clear.length, encryptDatabaseText(crypto, 'documents', 'original_name_enc', ids.document, 'invoice.pdf'), ids.applicant, STAMP);
    expect(vault.reconcile({ database: db, now: new Date(STAMP) }).completed).toBe(1);
    expect((db.prepare('SELECT status FROM documents WHERE id = ?').get(ids.document) as { status: string }).status).toBe('ready');
    db.close();
  });
});
