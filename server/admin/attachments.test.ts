import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { DocumentVault } from '../services/document-vault';
import { createAdminSession } from './auth/admin-session';
import { createAdminApp } from './app';

const NOW = '2026-09-01T00:53:00.000Z';
const IDS = {
  admin: '0198f0a0-0000-7000-8000-000000000001',
  applicant: '0198f0a0-0000-7000-8000-000000000002',
  cycle: '0198f0a0-0000-7000-8000-000000000003',
  rule: '0198f0a0-0000-7000-8000-000000000004',
  case: '0198f0a0-0000-7000-8000-000000000005',
  readyDocument: '0198f0a0-0000-7000-8000-000000000006',
  deletedDocument: '0198f0a0-0000-7000-8000-000000000007',
  unsupportedDocument: '0198f0a0-0000-7000-8000-000000000008',
};

const crypto = new FieldCrypto({
  activeKeyId: 'test-v1',
  getMasterKey: (id: string) => id === 'test-v1' ? Buffer.alloc(32, 0x6a) : undefined,
} satisfies Keyring);

describe('admin attachments', () => {
  let database: ReturnType<typeof openDatabase>;
  let root: string;
  let vault: DocumentVault;
  let sessionToken: string;
  let clearBytes: Buffer;

  beforeEach(() => {
    database = openDatabase(':memory:');
    migrateDatabase(database);
    root = mkdtempSync(join(tmpdir(), 'flowpass-admin-attachments-'));
    vault = new DocumentVault({ rootPath: root, crypto });
    clearBytes = Buffer.from('%PDF-1.7 admin attachment');

    database.prepare('INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)').run(IDS.admin, 'admin', 'hash', 'active', NOW, 1, 0);
    database.prepare('INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.cycle, 'ADMIN-ATTACHMENTS', '管理後台附件', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.rule, IDS.cycle, 1, 'published', 0, 2000, 'floor', '[]', '{}', NOW);
    database.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, submitted_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(IDS.case, 'FP-20260901-5822D6B0', IDS.applicant, IDS.cycle, IDS.rule, 'under_review', NOW, NOW, NOW, 15);

    const prepared = vault.prepare({ documentId: IDS.readyDocument, bytes: clearBytes });
    vault.commit(prepared);
    database.prepare('INSERT INTO documents (id, case_id, kind, requirement_key, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, deleted_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      IDS.readyDocument,
      IDS.case,
      'invoice',
      'purchase_proof',
      prepared.storageId,
      prepared.keyId,
      createHash('sha256').update(clearBytes).digest('hex'),
      'application/pdf',
      clearBytes.byteLength,
      encryptDatabaseText(crypto, 'documents', 'original_name_enc', IDS.readyDocument, '九月發票.pdf'),
      'ready',
      'applicant',
      IDS.applicant,
      NOW,
      null,
      2,
    );
    database.prepare('INSERT INTO documents (id, case_id, kind, requirement_key, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, deleted_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      IDS.deletedDocument,
      IDS.case,
      'other',
      null,
      'B'.repeat(43),
      'test-v1',
      createHash('sha256').update('deleted').digest('hex'),
      'image/png',
      7,
      encryptDatabaseText(crypto, 'documents', 'original_name_enc', IDS.deletedDocument, '已刪除.png'),
      'deleted',
      'applicant',
      IDS.applicant,
      NOW,
      NOW,
      3,
    );
    const purchaseDetails = {
      billingCycle: 'annual',
      billingPeriods: null,
      softwareFunction: 'general',
      otherFunction: null,
      softwareName: 'Adobe Photoshop',
      companyName: 'Adobe',
      purchaseDate: '2026-08-01',
      payerType: 'self_card',
      originalCurrency: 'TWD',
      otherCurrency: null,
      originalExpense: '3200',
      convertedTwd: 3200,
      specialStatus: false,
      invoiceNumber: 'AB12345678',
      subscriptionStartDate: null,
      subscriptionEndDate: null,
      applicantName: '王小明',
      receiptBuyerName: null,
      birthDate: null,
      paymentSourceFingerprint: null,
    };
    database.prepare('INSERT INTO case_purchase_details (case_id, details_enc, content_sha256, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(
      IDS.case,
      encryptDatabaseText(crypto, 'case_purchase_details', 'details_enc', IDS.case, JSON.stringify(purchaseDetails)),
      createHash('sha256').update(JSON.stringify(purchaseDetails)).digest('hex'),
      NOW,
      NOW,
      1,
    );
    sessionToken = createAdminSession(database, IDS.admin).token;
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function request(path: string): Promise<Response> {
    const dependencies = { crypto, documentVault: vault, documentVaultPath: root } as Parameters<typeof createAdminApp>[1];
    return createAdminApp(database, dependencies).request(`http://127.0.0.1:38101${path}`, {
      headers: {
        host: '127.0.0.1:38101',
        cookie: `flowpass_admin_session=${encodeURIComponent(sessionToken)}`,
      },
    });
  }

  it('lists only active attachment metadata without exposing vault references', async () => {
    const response = await request(`/admin/v1/cases/${IDS.case}/documents`);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      data: {
        documents: [{
          id: IDS.readyDocument,
          kind: 'invoice',
          requirementKey: 'purchase_proof',
          mediaType: 'application/pdf',
          byteSize: clearBytes.byteLength,
          originalName: '九月發票.pdf',
          status: 'ready',
          createdAt: NOW,
          rowVersion: 2,
        }],
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/storageId|keyId|contentSha256|originalNameEnc/);
  });

  it('returns decrypted purchase details for admin review', async () => {
    const response = await request(`/admin/v1/cases/${IDS.case}/purchase-details`);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.purchaseDetails).toMatchObject({
      softwareName: 'Adobe Photoshop',
      companyName: 'Adobe',
      purchaseDate: '2026-08-01',
      invoiceNumber: 'AB12345678',
      convertedTwd: 3200,
    });
  });

  it('reports no purchase details for a case that has not filled them in yet', async () => {
    database.prepare('INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '0198f0a0-0000-7000-8000-000000000009', 'FP-20260901-0000AAAA', IDS.applicant, IDS.cycle, IDS.rule, 'draft', NOW, NOW, 1,
    );

    const response = await request('/admin/v1/cases/0198f0a0-0000-7000-8000-000000000009/purchase-details');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { purchaseDetails: null } });
  });

  it('does not expose purchase details for an unknown case or without an admin session', async () => {
    const notFound = await request('/admin/v1/cases/does-not-exist/purchase-details');
    expect(notFound.status).toBe(404);

    const unauthenticated = await createAdminApp(database, { crypto, documentVault: vault } as Parameters<typeof createAdminApp>[1]).request(
      `http://127.0.0.1:38101/admin/v1/cases/${IDS.case}/purchase-details`,
      { headers: { host: '127.0.0.1:38101' } },
    );
    expect(unauthenticated.status).toBe(401);
  });

  it('streams a ready attachment inline to an authenticated admin', async () => {
    const response = await request(`/admin/v1/documents/${IDS.readyDocument}/content`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''%E4%B9%9D%E6%9C%88%E7%99%BC%E7%A5%A8.pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(clearBytes);
  });

  it('does not expose deleted attachments or content without an admin session', async () => {
    const deleted = await request(`/admin/v1/documents/${IDS.deletedDocument}/content`);
    expect(deleted.status).toBe(404);

    const unauthenticated = await createAdminApp(database, { crypto, documentVault: vault } as Parameters<typeof createAdminApp>[1]).request(
      `http://127.0.0.1:38101/admin/v1/documents/${IDS.readyDocument}/content`,
      { headers: { host: '127.0.0.1:38101' } },
    );
    expect(unauthenticated.status).toBe(401);
  });

  it('refuses to render an unsupported media type inline even if the database is corrupted', async () => {
    const unsupportedBytes = Buffer.from('<script>alert(1)</script>');
    const prepared = vault.prepare({ documentId: IDS.unsupportedDocument, bytes: unsupportedBytes });
    vault.commit(prepared);
    database.prepare('INSERT INTO documents (id, case_id, kind, requirement_key, storage_id, key_id, content_sha256, media_type, byte_size, original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, deleted_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      IDS.unsupportedDocument,
      IDS.case,
      'other',
      null,
      prepared.storageId,
      prepared.keyId,
      createHash('sha256').update(unsupportedBytes).digest('hex'),
      'text/html',
      unsupportedBytes.byteLength,
      encryptDatabaseText(crypto, 'documents', 'original_name_enc', IDS.unsupportedDocument, 'unsafe.html'),
      'ready',
      'applicant',
      IDS.applicant,
      NOW,
      null,
      1,
    );

    const response = await request(`/admin/v1/documents/${IDS.unsupportedDocument}/content`);
    expect(response.status).toBe(404);
  });

  it('reports readiness only when crypto and the configured vault are available', async () => {
    const unavailable = await createAdminApp(database).request('http://127.0.0.1:38101/readyz');
    expect(unavailable.status).toBe(503);

    const dependencies = { crypto, documentVault: vault, documentVaultPath: root } as Parameters<typeof createAdminApp>[1];
    const ready = await createAdminApp(database, dependencies).request('http://127.0.0.1:38101/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, database: 'ready', migrations: 'ready', keychain: 'ready', vault: 'ready' });
  });
});
