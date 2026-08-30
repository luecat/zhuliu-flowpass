import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../../../../../../server/crypto/field-crypto';
import { openDatabase } from '../../../../../../server/db/connection';
import { migrateDatabase } from '../../../../../../server/db/migrate';
import { DocumentVault } from '../../../../../../server/services/document-vault';
import { clearPublicRuntime, configurePublicRuntime } from '../../../../../../server/public/runtime';
import { POST } from './route';

const STAMP = '2026-08-30T00:00:00.000Z';
const crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x77) : undefined } satisfies Keyring);

function png(): Buffer {
  const body = Buffer.alloc(13); body.writeUInt32BE(1, 0); body.writeUInt32BE(1, 4); body[8] = 8; body[9] = 2;
  const chunk = (type: string, value: Buffer) => { let crc = 0xffffffff; for (const byte of Buffer.concat([Buffer.from(type), value])) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const length = Buffer.alloc(4); length.writeUInt32BE(value.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, Buffer.from(type), value, checksum]); };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', body), chunk('IDAT', Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}

describe('POST /api/v1/cases/:caseId/documents', () => {
  let db: ReturnType<typeof openDatabase>; let root: string; let caseId: string; let applicantId: string;
  beforeEach(() => {
    db = openDatabase(':memory:'); migrateDatabase(db); root = mkdtempSync(join(tmpdir(), 'flowpass-document-route-')); applicantId = uuidv7(); caseId = uuidv7();
    const cycle = uuidv7(); const rule = uuidv7();
    db.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(applicantId, 'enc', 'active', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cycle, 'TEST', 'Test', 2026, 'active', '{}', STAMP, STAMP, 1);
    db.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rule, cycle, 1, 'published', 0, 0, 'floor', '[]', '{}', STAMP);
    db.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, 'CASE', applicantId, cycle, rule, 'draft', STAMP, STAMP, 1);
    configurePublicRuntime({ database: db, crypto, documentVault: new DocumentVault({ rootPath: root, crypto }), publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: (origin: string | null) => origin === 'http://127.0.0.1:38100', verifyApplicantCsrf: () => ({ applicantId }), authenticateApplicant: () => ({ applicantId, sessionId: 'session' }) } as never, requestIdGenerator: () => 'request-document' });
  });
  afterEach(() => { clearPublicRuntime(); db.close(); rmSync(root, { recursive: true, force: true }); });

  it('returns a bounded invalid-request response for malformed multipart input after guards', async () => {
    const form = new FormData(); form.set('kind', 'invoice'); form.set('file', new File([new Uint8Array(png())], 'wrong-extension.txt', { type: 'text/plain' }));
    const response = await POST(new Request(`http://127.0.0.1:38100/api/v1/cases/${caseId}/documents`, { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'route-upload', 'if-match': '"1"' }, body: form }), { params: Promise.resolve({ caseId }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a request from a non-public origin before reading its multipart body', async () => {
    const response = await POST(new Request(`http://127.0.0.1:38100/api/v1/cases/${caseId}/documents`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'route-origin', 'if-match': '"1"' }, body: 'not-read' }), { params: Promise.resolve({ caseId }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_FAILED');
  });

  it('rejects an explicitly oversized multipart body before buffering the form', async () => {
    const response = await POST(new Request(`http://127.0.0.1:38100/api/v1/cases/${caseId}/documents`, { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'route-oversize', 'if-match': '"1"', 'content-length': String(12 * 1024 * 1024 + 300 * 1024) }, body: 'not-read' }), { params: Promise.resolve({ caseId }) });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('FILE_TOO_LARGE');
  });
});
