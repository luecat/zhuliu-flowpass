import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { screenVendorReceipt } from './receipt-screening';
import { blockedTermsForCase } from './blocked-vendor-list';
import { DEFAULT_BLOCKED_VENDORS } from '../../shared/default-blocked-vendors';
import type { OcrEngine, OcrResult } from '../adapters/ocr/ocr-engine';
import type { DocumentRequirementKey } from '../../shared/purchase-details-contract';

const IDS = {
  applicant: '0198f050-0000-7000-8000-000000000001',
  cycle: '0198f050-0000-7000-8000-000000000002',
  rule: '0198f050-0000-7000-8000-000000000003',
  case: '0198f050-0000-7000-8000-000000000004',
  receipt: '0198f050-0000-7000-8000-000000000005',
};
const NOW = '2026-08-30T00:00:00.000Z';

function line(text: string, confidence = 1) {
  return { text, confidence, box: { x: 0, y: 0, width: 1, height: 1 } };
}

function engineReading(texts: string[], available = true): OcrEngine {
  return {
    id: 'test-engine',
    available: async () => available,
    recognize: async (): Promise<OcrResult> => ({ lines: texts.map((text) => line(text)), engineId: 'test-engine', durationMs: 1 }),
  };
}

const vault = { read: () => new Uint8Array([1, 2, 3]) };

describe('screenVendorReceipt', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  function insertReceipt(mediaType = 'image/png', status = 'ready'): void {
    db.prepare('INSERT INTO documents (id,case_id,kind,requirement_key,storage_id,key_id,content_sha256,media_type,byte_size,original_name_enc,status,uploaded_by_type,uploaded_by_id,created_at,deleted_at,row_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(IDS.receipt, IDS.case, 'invoice', 'vendor_receipt' satisfies DocumentRequirementKey, 'storage-1', 'key-v1', 'hash-1', mediaType, 10, 'enc', status, 'applicant', IDS.applicant, NOW, null, 1);
  }

  function screen(engine: OcrEngine) {
    return screenVendorReceipt({ database: db, documentVault: vault, ocrEngine: engine, applicantId: IDS.applicant, caseId: IDS.case });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-receipt-screen-'));
    db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
    db.prepare('INSERT INTO cases (id,case_code,applicant_id,program_cycle_id,program_rule_version_id,state,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.case, 'CASE-0001', IDS.applicant, IDS.cycle, IDS.rule, 'draft', NOW, NOW, 1);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('finds a relay product name printed in the receipt line items', async () => {
    insertReceipt();
    await expect(screen(engineReading(['電子發票開立資訊', '品名 Token Plan Individual'])))
      .resolves.toMatchObject({ term: 'token plan' });
  });

  it('finds a blocked vendor in the receipt header, whatever the applicant typed into the form', async () => {
    insertReceipt();
    await expect(screen(engineReading(['42527414 Alibaba Cloud (Singapore) Private Limited'])))
      .resolves.toMatchObject({ term: 'alibaba' });
  });

  it('passes an ordinary western receipt', async () => {
    insertReceipt();
    await expect(screen(engineReading(['OpenAI, LLC', 'ChatGPT Plus', 'USD 20.00']))).resolves.toBeNull();
  });

  it('screens nothing when the engine is unavailable, rather than rejecting on an outage', async () => {
    insertReceipt();
    await expect(screen(engineReading(['Alibaba Cloud'], false))).resolves.toBeNull();
  });

  it('screens nothing when there is no ready receipt to read', async () => {
    insertReceipt('image/png', 'pending_vault');
    await expect(screen(engineReading(['Alibaba Cloud']))).resolves.toBeNull();
  });

  it('skips a media type the recognizer cannot open', async () => {
    insertReceipt('image/heic');
    await expect(screen(engineReading(['Alibaba Cloud']))).resolves.toBeNull();
  });

  it('is governed by the cycle\'s stored denylist once one is configured', async () => {
    insertReceipt();
    expect(blockedTermsForCase(db, IDS.case)).toBe(DEFAULT_BLOCKED_VENDORS);

    const configuredRule = '0198f050-0000-7000-8000-000000000006';
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(configuredRule, IDS.cycle, 2, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', JSON.stringify({ softwareBlacklist: ['Example Blocked Vendor'] }), NOW, NOW);
    db.prepare('UPDATE cases SET program_rule_version_id = ? WHERE id = ?').run(configuredRule, IDS.case);

    expect(blockedTermsForCase(db, IDS.case)).toEqual(['Example Blocked Vendor']);
    // The stored list now decides: what it omits is allowed, what it names is not.
    await expect(screen(engineReading(['Alibaba Cloud']))).resolves.toBeNull();
    await expect(screen(engineReading(['Example Blocked Vendor Ltd.'])))
      .resolves.toMatchObject({ term: 'Example Blocked Vendor' });
  });
});
