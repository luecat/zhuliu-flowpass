import { describe, expect, it } from 'vitest';
import { evaluateExchangeRateReasonableness } from './exchange-rate-rules';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';

const base = { ruleVersionId: 'rule', inputSnapshotHash: 'h', evaluatedAt: '2026-09-19T00:00:00.000Z' };

function purchaseWithUsd(originalExpense: string, convertedTwd: number): PurchaseDetails {
  return {
    billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null,
    softwareName: 'ChatGPT', companyName: 'OpenAI', purchaseDate: '2026-08-30', payerType: 'self_card',
    originalCurrency: 'USD', otherCurrency: null, originalExpense, convertedTwd,
    specialStatus: false, invoiceNumber: null, paymentSourceFingerprint: null,
    subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
    applicantName: '測試申請人', receiptBuyerName: null, birthDate: null,
  };
}

describe('evaluateExchangeRateReasonableness (asymmetric ±5% band)', () => {
  // USD 20 at the 31.5 reference rate estimates to NT$630.
  it('passes when the declared amount is above the estimate, however far — fees only push the charge up', () => {
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 653) }).outcome).toBe('pass');
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 900) }).outcome).toBe('pass');
  });

  it('passes at the exact estimate and within 5% below it', () => {
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 630) }).outcome).toBe('pass');
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 599) }).outcome).toBe('pass');
  });

  it('needs review when the declared amount falls more than 5% below the estimate', () => {
    const result = evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 590) });
    expect(result.outcome).toBe('needs_review');
    expect(result.reasonCode).toBe('exchange_rate_below_band');
  });

  it('uses an admin-configured reference rate when supplied instead of the hardcoded default', () => {
    // NT$600 passes against the default 31.5 rate's NT$630 estimate (within
    // 5% below), but the same declared amount falls outside a 5% band under
    // an admin-configured 33 rate's NT$660 estimate.
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 600) }).outcome).toBe('pass');
    const result = evaluateExchangeRateReasonableness({ ...base, purchase: purchaseWithUsd('20', 600), referenceFxRates: { USD: 33 } });
    expect(result.outcome).toBe('needs_review');
  });
});
