import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import { inspectPassportDocument } from './passport-validation';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import {
  buildTransactionFingerprint,
  evaluateToolConsistency,
  evaluateTransactionFingerprint,
  subsidyDerivationSteps,
  toolLabelsMatch,
} from './submission-checks';
import { calculateSubsidy } from './subsidy-calculator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PURCHASE: PurchaseDetails = {
  billingCycle: 'annual',
  billingPeriods: null,
  softwareFunction: 'imaging',
  otherFunction: null,
  softwareName: 'AI 影片生成工具',
  companyName: 'Example Inc.',
  purchaseDate: '2026-08-30',
  payerType: 'self_card',
  originalCurrency: 'USD',
  otherCurrency: null,
  originalExpense: '240',
  convertedTwd: 7560,
  specialStatus: false,
  invoiceNumber: 'AB-12345678',
  paymentSourceFingerprint: null,
  subscriptionStartDate: '2026-08-01',
  subscriptionEndDate: '2027-07-31',
  applicantName: '測試申請人',
  receiptBuyerName: '測試申請人',
  birthDate: null,
  nationalId: null,
  householdAddress: null,
};

function passport() {
  const result = inspectPassportDocument(structuredClone(FLOWPASS_SAMPLE));
  if (!result.canonical) throw new Error('sample must be canonical');
  return result.canonical;
}

describe('submission checks', () => {
  it('matches tool labels with light normalization', () => {
    expect(toolLabelsMatch('AI影片生成工具', 'AI 影片生成工具')).toBe(true);
    expect(toolLabelsMatch('Midjourney', 'Canva')).toBe(false);
  });

  it('flags tool inconsistency between purchase and passport', () => {
    const evaluation = evaluateToolConsistency({
      purchase: { ...PURCHASE, softwareName: 'Midjourney' },
      passport: passport(),
      ruleVersionId: 'rule',
      inputSnapshotHash: 'hash',
      evaluatedAt: 'now',
    });
    expect(evaluation.outcome).toBe('needs_review');
    expect(evaluation.reasonCode).toBe('tool_mismatch');
  });

  it('passes when declared software matches a passport tool node', () => {
    const evaluation = evaluateToolConsistency({
      purchase: PURCHASE,
      passport: passport(),
      ruleVersionId: 'rule',
      inputSnapshotHash: 'hash',
      evaluatedAt: 'now',
    });
    expect(evaluation.outcome).toBe('pass');
  });

  it('builds a stable transaction fingerprint and marks duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpass-fingerprint-'));
    const database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    const fingerprint = buildTransactionFingerprint(PURCHASE);
    const ids = {
      applicant: '0198f050-0000-7000-8000-000000000101',
      cycle: '0198f050-0000-7000-8000-000000000102',
      rule: '0198f050-0000-7000-8000-000000000103',
      caseOld: '0198f050-0000-7000-8000-000000000104',
      evalOld: '0198f050-0000-7000-8000-000000000105',
      caseNew: '0198f050-0000-7000-8000-000000000106',
    };
    const now = '2026-08-30T00:00:00.000Z';
    database.prepare(`INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,1)`).run(ids.applicant, 'enc', 'active', now, now);
    database.prepare(`INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,1)`).run(ids.cycle, 'DEMO', '示範', 2026, 'active', '{}', now, now);
    database.prepare(`INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ids.rule, ids.cycle, 1, 'published', 5000, 3000, 'floor', '[]', '{}', now);
    database.prepare(`INSERT INTO cases (id,case_code,applicant_id,program_cycle_id,program_rule_version_id,state,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,1)`).run(ids.caseOld, 'FP-OLD', ids.applicant, ids.cycle, ids.rule, 'submitted', now, now);
    database.prepare(`INSERT INTO rule_evaluations (id,case_id,passport_version_id,document_id,program_rule_version_id,evaluation_kind,outcome,result_json,input_snapshot_hash,actor_type,actor_id,created_at) VALUES (?,?,NULL,NULL,?,?,?,?,?,?,?,?)`).run(
      ids.evalOld,
      ids.caseOld,
      ids.rule,
      'invoice',
      'pass',
      JSON.stringify({
        ruleCode: 'transaction_fingerprint',
        outcome: 'pass',
        reasonCode: 'unique_transaction',
        explanation: 'ok',
        ruleVersionId: ids.rule,
        inputSnapshotHash: 'hash',
        evaluatedAt: now,
        steps: [{ label: '交易指紋', value: fingerprint }],
      }),
      'hash',
      'system',
      'test',
      now,
    );

    const evaluation = evaluateTransactionFingerprint({
      database,
      caseId: ids.caseNew,
      purchase: PURCHASE,
      ruleVersionId: ids.rule,
      inputSnapshotHash: 'hash',
      evaluatedAt: now,
    });
    expect(evaluation.outcome).toBe('needs_review');
    expect(evaluation.steps.find((step) => step.label === '比對結果')?.value).toContain('FP-OLD');
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes subsidy derivation steps including the cap', () => {
    const calculation = calculateSubsidy({ eligiblePurchaseTwd: 7560, rateBps: 5000, capTwd: 3000 });
    expect(calculation.uncappedAmountTwd).toBe(3780);
    expect(calculation.calculatedAmountTwd).toBe(3000);
    expect(subsidyDerivationSteps(calculation).at(-1)?.value).toBe('NT$3,000（觸及上限）');
  });
});
