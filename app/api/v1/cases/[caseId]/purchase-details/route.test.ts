import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto } from '../../../../../../server/crypto/field-crypto';
import { openDatabase } from '../../../../../../server/db/connection';
import { migrateDatabase } from '../../../../../../server/db/migrate';
import { clearPublicRuntime, configurePublicRuntime } from '../../../../../../server/public/runtime';
import { GET, PUT } from './route';

const IDS = {
  applicant: '0198f090-0000-7000-8000-000000000001',
  otherApplicant: '0198f090-0000-7000-8000-000000000002',
  cycle: '0198f090-0000-7000-8000-000000000003',
  rule: '0198f090-0000-7000-8000-000000000004',
  case: '0198f090-0000-7000-8000-000000000005',
  request: '0198f090-0000-7000-8000-000000000006',
};
const NOW = '2026-09-01T00:00:00.000Z';
const writeDetails = {
  billingCycle: 'annual', billingPeriods: null, softwareFunction: 'imaging', otherFunction: null,
  softwareName: '私密修圖軟體', companyName: 'Example Inc.', purchaseDate: '2026-08-30',
  payerType: 'self_card', originalCurrency: 'USD', otherCurrency: null,
  originalExpense: '29.99', convertedTwd: 950, specialStatus: false, invoiceNumber: null,
  cardLastFour: '4242', cardholderName: '測試持卡人',
  subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
  applicantName: '測試申請人',
};

describe('purchase details route', () => {
  let database: ReturnType<typeof openDatabase>;
  let crypto: FieldCrypto;

  beforeEach(() => {
    database = openDatabase(':memory:'); migrateDatabase(database);
    crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x45) : undefined });
    for (const applicant of [IDS.applicant, IDS.otherApplicant]) database.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)').run(applicant, 'enc', 'active', NOW, NOW, 1);
    database.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.cycle, 'PURCHASE', '購買測試', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(IDS.rule, IDS.cycle, 1, 'published', 5000, 10000, 'floor', '[]', '{}', NOW);
    database.prepare('INSERT INTO cases (id,case_code,applicant_id,program_cycle_id,program_rule_version_id,state,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)').run(IDS.case, 'PURCHASE-1', IDS.applicant, IDS.cycle, IDS.rule, 'draft', NOW, NOW, 1);
    configurePublicRuntime({
      database, crypto, publicOrigin: 'http://127.0.0.1:38100',
      clock: () => new Date(NOW), requestIdGenerator: () => IDS.request,
      lineSessions: {
        isPublicOrigin: (origin: string | null) => origin === 'http://127.0.0.1:38100',
        authenticateApplicant: () => ({ applicantId: IDS.applicant }),
        verifyApplicantCsrf: () => ({ applicantId: IDS.applicant }),
      },
    } as never);
  });

  afterEach(() => { clearPublicRuntime(); database.close(); });

  it('saves encrypted applicant-owned details and returns the new case ETag', async () => {
    const request = new Request(`http://127.0.0.1:38100/api/v1/cases/${IDS.case}/purchase-details`, {
      method: 'PUT',
      headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'purchase-details-1', 'if-match': '"1"', 'content-type': 'application/json' },
      body: JSON.stringify(writeDetails),
    });
    const response = await PUT(request, { params: Promise.resolve({ caseId: IDS.case }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    expect(await response.json()).toMatchObject({
      data: {
        details: {
          softwareName: '私密修圖軟體',
          convertedTwd: 950,
          paymentSourceRegistered: true,
        },
      },
    });
    const stored = database.prepare('SELECT details_enc FROM case_purchase_details WHERE case_id = ?').get(IDS.case) as { details_enc: string };
    expect(stored.details_enc).not.toContain('私密修圖軟體');
    expect(stored.details_enc).not.toContain('4242');
    expect(database.prepare('SELECT requested_amount_twd,row_version FROM cases WHERE id = ?').get(IDS.case)).toEqual({ requested_amount_twd: 950, row_version: 2 });
  });

  it('evaluates and persists name consistency at save time, while cardholderName plaintext is still available', async () => {
    const put = (body: unknown) => PUT(new Request(`http://127.0.0.1:38100/api/v1/cases/${IDS.case}/purchase-details`, { method: 'PUT', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'name-check', 'if-match': '"1"', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ caseId: IDS.case }) });
    await put({ ...writeDetails, applicantName: '測試申請人', receiptBuyerName: '測試申請人' });
    const row = database.prepare(`SELECT outcome, result_json FROM rule_evaluations WHERE case_id = ? AND json_extract(result_json, '$.ruleCode') = 'applicant_name_consistency' ORDER BY created_at DESC, id DESC LIMIT 1`).get(IDS.case) as { outcome: string; result_json: string };
    expect(row.outcome).toBe('pass');
    expect(JSON.parse(row.result_json).reasonCode).toBe('matches_applicant');
  });

  it('loads a saved form but rejects malformed values and stale writes', async () => {
    const put = (body: unknown, etag: string, key: string) => PUT(new Request(`http://127.0.0.1:38100/api/v1/cases/${IDS.case}/purchase-details`, { method: 'PUT', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': key, 'if-match': etag, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ caseId: IDS.case }) });
    expect((await put({ ...writeDetails, convertedTwd: 0 }, '"1"', 'invalid')).status).toBe(400);
    expect((await put(writeDetails, '"1"', 'valid')).status).toBe(200);
    expect((await put({ ...writeDetails, convertedTwd: 951 }, '"1"', 'stale')).status).toBe(409);
    const getResponse = await GET(new Request(`http://127.0.0.1:38100/api/v1/cases/${IDS.case}/purchase-details`, { headers: { cookie: 'flowpass_session=s' } }), { params: Promise.resolve({ caseId: IDS.case }) });
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json();
    expect(getBody).toMatchObject({
      data: {
        details: {
          originalExpense: '29.99',
          paymentSourceRegistered: true,
        },
      },
    });
    expect(JSON.stringify(getBody)).not.toContain('4242');
  });
});
