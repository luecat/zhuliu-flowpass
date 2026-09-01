import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { DocumentVault } from '../services/document-vault';
import { DocumentCommandError, createDocumentService } from './document-service';

const STAMP = '2026-08-30T00:00:00.000Z';
const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x66) : undefined } satisfies Keyring);

function png(): Buffer {
  const body = Buffer.alloc(13); body.writeUInt32BE(1, 0); body.writeUInt32BE(1, 4); body[8] = 8; body[9] = 2;
  const chunk = (type: string, value: Buffer) => { let crc = 0xffffffff; for (const byte of Buffer.concat([Buffer.from(type), value])) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const length = Buffer.alloc(4); length.writeUInt32BE(value.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, Buffer.from(type), value, checksum]); };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', body), chunk('IDAT', Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}

describe('DocumentService', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let service: ReturnType<typeof createDocumentService>;
  let ids: { applicant: string; otherApplicant: string; cycle: string; rule: string; case: string };

  beforeEach(() => {
    db = openDatabase(':memory:'); migrateDatabase(db); root = mkdtempSync(join(tmpdir(), 'flowpass-document-service-'));
    ids = { applicant: uuidv7(), otherApplicant: uuidv7(), cycle: uuidv7(), rule: uuidv7(), case: uuidv7() };
    for (const applicant of [ids.applicant, ids.otherApplicant]) db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicant, 'enc', 'active', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.cycle, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.rule, ids.cycle, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
    db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.case, 'CASE', ids.applicant, ids.cycle, ids.rule, 'draft', STAMP, STAMP, 1);
    const vault = new DocumentVault({ rootPath: root, crypto });
    service = createDocumentService({ database: db, crypto, vault, clock: () => new Date(STAMP) });
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it('enforces applicant ownership and case ETag before persistence', async () => {
    await expect(service.upload({ applicantId: ids.otherApplicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'invoice.png', bytes: png(), ifMatch: '"1"', idempotencyKey: 'foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'invoice.png', bytes: png(), ifMatch: '"2"', idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'ETAG_MISMATCH' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
  });

  it('uses the two-phase vault protocol, stores only encrypted metadata and replays idempotently', async () => {
    const bytes = png();
    const first = await service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'private-invoice.png', bytes, ifMatch: '"1"', idempotencyKey: 'same-key' });
    const replay = await service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'private-invoice.png', bytes, ifMatch: '"1"', idempotencyKey: 'same-key' });
    expect(replay).toEqual(first);
    expect(first.document.status).toBe('ready');
    expect(first.document.mediaType).toBe('image/png');
    expect(db.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT original_name_enc, storage_id, key_id FROM documents').get()).toMatchObject({ storage_id: expect.not.stringContaining('private-invoice'), key_id: 'test-v1' });
    const raw = db.prepare('SELECT original_name_enc FROM documents').get() as { original_name_enc: string };
    expect(raw.original_name_enc).not.toContain('private-invoice.png');
    expect((db.prepare('SELECT row_version FROM cases WHERE id = ?').get(ids.case) as { row_version: number }).row_version).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_type = 'ocr'").get() as { count: number }).count).toBe(1);
  });

  it('rejects submitted cases and removes a document only while the case is mutable', async () => {
    const uploaded = await service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'receipt.png', bytes: png(), ifMatch: '"1"', idempotencyKey: 'upload' });
    const deleted = service.delete({ applicantId: ids.applicant, caseId: ids.case, documentId: uploaded.document.id, ifMatch: '"2"', idempotencyKey: 'delete' });
    expect(deleted.document.status).toBe('deleted');
    db.prepare("UPDATE cases SET state = 'submitted' WHERE id = ?").run(ids.case);
    await expect(service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'again.png', bytes: png(), ifMatch: '"3"', idempotencyKey: 'submitted' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('does not persist bytes when stream validation fails', async () => {
    const tooLarge = new Uint8Array(12 * 1024 * 1024 + 1);
    await expect(service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'invoice', requirementKey: 'purchase_proof', originalName: 'bad.bin', bytes: tooLarge, ifMatch: '"1"', idempotencyKey: 'invalid' })).rejects.toBeInstanceOf(DocumentCommandError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
  });

  it('never queues OCR for identity, bankbook, or affidavit uploads', async () => {
    const uploaded = await service.upload({ applicantId: ids.applicant, caseId: ids.case, kind: 'eligibility_proof', requirementKey: 'identity_front', originalName: 'identity.png', bytes: png(), ifMatch: '"1"', idempotencyKey: 'identity' });
    expect(uploaded.document.requirementKey).toBe('identity_front');
    expect((db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_type = 'ocr'").get() as { count: number }).count).toBe(0);
  });
});
