import { describe, expect, it } from 'vitest';
import { evaluateExchangeRateReasonableness } from './exchange-rate-rules';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';

const base = { ruleVersionId: 'rule', inputSnapshotHash: 'h', evaluatedAt: '2026-09-19T00:00:00.000Z' };

function purchase(partial: Partial<PurchaseDetails> & Pick<PurchaseDetails, 'originalCurrency' | 'originalExpense' | 'convertedTwd'>): PurchaseDetails {
  return {
    billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null,
    softwareName: 'ChatGPT', companyName: 'OpenAI', purchaseDate: '2026-08-30', payerType: 'self_card',
    otherCurrency: null, specialStatus: false, invoiceNumber: null, paymentSourceFingerprint: null,
    subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
    applicantName: '測試申請人', receiptBuyerName: null, receiptVendorName: null, birthDate: null, nationalId: null, householdAddress: null,
    ...partial,
  };
}

describe('evaluateExchangeRateReasonableness (receipt × bank payment)', () => {
  it('passes foreign amounts at or above the estimate, including large fee overshoots', () => {
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 653 }) }).outcome).toBe('pass');
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 900 }) }).outcome).toBe('pass');
  });

  it('passes within 5% below the foreign-currency estimate', () => {
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 630 }) }).outcome).toBe('pass');
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 599 }) }).outcome).toBe('pass');
  });

  it('fails when the bank payment falls more than 5% below the receipt estimate', () => {
    const result = evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 590 }) });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('receipt_payment_amount_mismatch');
  });

  it('fails when a TWD receipt amount disagrees with the bank payment', () => {
    const result = evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'TWD', originalExpense: '1200', convertedTwd: 999 }) });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('receipt_payment_amount_mismatch');
  });

  it('passes when a TWD receipt matches the bank payment exactly', () => {
    const result = evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'TWD', originalExpense: '1200', convertedTwd: 1200 }) });
    expect(result.outcome).toBe('pass');
    expect(result.reasonCode).toBe('receipt_payment_amount_match');
  });

  it('uses an admin-configured reference rate when supplied', () => {
    expect(evaluateExchangeRateReasonableness({ ...base, purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 600 }) }).outcome).toBe('pass');
    const result = evaluateExchangeRateReasonableness({
      ...base,
      purchase: purchase({ originalCurrency: 'USD', originalExpense: '20', convertedTwd: 600 }),
      referenceFxRates: { USD: 33 },
    });
    expect(result.outcome).toBe('fail');
  });
});
