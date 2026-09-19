import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../../../../../../server/crypto/field-crypto';
import { openDatabase } from '../../../../../../server/db/connection';
import { migrateDatabase } from '../../../../../../server/db/migrate';
import { DocumentVault } from '../../../../../../server/services/document-vault';
import { createDocumentService } from '../../../../../../server/domain/document-service';
import { clearPublicRuntime, configurePublicRuntime } from '../../../../../../server/public/runtime';
import { GET } from './route';

const STAMP = '2026-09-19T00:00:00.000Z';
const crypto = new FieldCrypto({ activeKeyId: 'v1', getMasterKey: (id: string) => id === 'v1' ? Buffer.alloc(32, 0x22) : undefined } satisfies Keyring);

function png(): Buffer {
  const body = Buffer.alloc(13); body.writeUInt32BE(1, 0); body.writeUInt32BE(1, 4); body[8] = 8; body[9] = 2;
  const chunk = (type: string, value: Buffer) => { let crc = 0xffffffff; for (const byte of Buffer.concat([Buffer.from(type), value])) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const length = Buffer.alloc(4); length.writeUInt32BE(value.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, Buffer.from(type), value, checksum]); };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', body), chunk('IDAT', Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}

function fakeEngine(overrides: Partial<{ available: () => Promise<boolean>; recognize: () => Promise<{ lines: Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }>; engineId: string; durationMs: number }> }> = {}) {
  return {
    id: 'fake',
    available: overrides.available ?? (async () => true),
    recognize: overrides.recognize ?? (async () => ({ lines: [{ text: 'Claude Pro', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } }], engineId: 'fake', durationMs: 3 })),
  };
}

describe('GET /api/v1/documents/[documentId]/ocr', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let ids: { applicant: string; otherApplicant: string; cycle: string; rule: string; case: string };

  beforeEach(() => {
    db = openDatabase(':memory:'); migrateDatabase(db); root = mkdtempSync(join(tmpdir(), 'flowpass-ocr-route-'));
    ids = { applicant: uuidv7(), otherApplicant: uuidv7(), cycle: uuidv7(), rule: uuidv7(), case: uuidv7() };
    for (const applicant of [ids.applicant, ids.otherApplicant]) db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicant, 'enc', 'active', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.cycle, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.rule, ids.cycle, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
    db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.case, 'CASE', ids.applicant, ids.cycle, ids.rule, 'draft', STAMP, STAMP, 1);
  });

  afterEach(() => { clearPublicRuntime(); db.close(); rmSync(root, { recursive: true, force: true }); });

  async function uploadReadyDocument(requirementKey: 'vendor_receipt' | 'card_transaction' | 'identity_front'): Promise<string> {
    const vault = new DocumentVault({ rootPath: root, crypto });
    const service = createDocumentService({ database: db, crypto, vault, clock: () => new Date(STAMP) });
    const kind = requirementKey === 'identity_front' ? 'eligibility_proof' : 'invoice';
    const result = await service.upload({ applicantId: ids.applicant, caseId: ids.case, kind, requirementKey, originalName: 'receipt.png', bytes: png(), ifMatch: '"1"', idempotencyKey: `upload-${requirementKey}` });
    return result.document.id;
  }

  function request(documentId: string): { req: Request; params: Promise<{ documentId: string }> } {
    return {
      req: new Request(`http://127.0.0.1:38100/api/v1/documents/${documentId}/ocr`, { headers: { cookie: 'flowpass_session=s' } }),
      params: Promise.resolve({ documentId }),
    };
  }

  function boot(ocrEngine: ReturnType<typeof fakeEngine> | undefined, applicantIdForAuth = ids.applicant) {
    configurePublicRuntime({
      database: db, crypto, publicOrigin: 'http://127.0.0.1:38100',
      clock: () => new Date(STAMP), requestIdGenerator: () => 'req',
      documentVault: new DocumentVault({ rootPath: root, crypto }),
      ocrEngine,
      lineSessions: {
        isPublicOrigin: () => true,
        authenticateApplicant: (token: string | null) => token ? { applicantId: applicantIdForAuth } : null,
        verifyApplicantCsrf: () => null,
      },
    } as never);
  }

  it('requires an authenticated session', async () => {
    boot(fakeEngine());
    const { req, params } = { req: new Request('http://127.0.0.1:38100/api/v1/documents/x/ocr'), params: Promise.resolve({ documentId: 'x' }) };
    const response = await GET(req, { params });
    expect(response.status).toBe(401);
  });

  it('returns 404 for a document owned by another applicant', async () => {
    const documentId = await uploadReadyDocument('vendor_receipt');
    boot(fakeEngine(), ids.otherApplicant);
    const { req, params } = request(documentId);
    const response = await GET(req, { params });
    expect(response.status).toBe(404);
  });

  it('recognizes text for an OCR-eligible requirement and returns it without persisting anything', async () => {
    const documentId = await uploadReadyDocument('vendor_receipt');
    boot(fakeEngine());
    const { req, params } = request(documentId);
    const response = await GET(req, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ocr.lines).toEqual([expect.objectContaining({ text: 'Claude Pro' })]);
    expect(body.data.ocr.engineId).toBe('fake');
    // Recognition is ephemeral: nothing about it is written to the database.
    expect(db.prepare('SELECT COUNT(*) AS count FROM rule_evaluations').get()).toEqual({ count: 0 });
  });

  it('returns ocr: null for a requirement key OCR was never meant for, without calling the engine', async () => {
    const documentId = await uploadReadyDocument('identity_front');
    let called = false;
    boot(fakeEngine({ available: async () => { called = true; return true; } }));
    const { req, params } = request(documentId);
    const response = await GET(req, { params });
    const body = await response.json();
    expect(body.data.ocr).toBeNull();
    expect(called).toBe(false);
  });

  it('returns ocr: null, not an error, when the engine is unavailable on this host', async () => {
    const documentId = await uploadReadyDocument('card_transaction');
    boot(fakeEngine({ available: async () => false }));
    const { req, params } = request(documentId);
    const response = await GET(req, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ocr).toBeNull();
  });

  it('returns ocr: null, not an error, when recognition throws', async () => {
    const documentId = await uploadReadyDocument('vendor_receipt');
    boot(fakeEngine({ recognize: async () => { throw new Error('boom'); } }));
    const { req, params } = request(documentId);
    const response = await GET(req, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ocr).toBeNull();
  });
});
