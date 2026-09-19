import { describe, expect, it } from 'vitest';
import { evaluateSoftwareBlacklist } from './software-blacklist-rules';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';

const base = { ruleVersionId: 'rule', inputSnapshotHash: 'h', evaluatedAt: '2026-09-19T00:00:00.000Z' };

function purchaseWithSoftware(softwareName: string): PurchaseDetails {
  return {
    billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null,
    softwareName, companyName: 'Example Inc.', purchaseDate: '2026-08-30', payerType: 'self_card',
    originalCurrency: 'TWD', otherCurrency: null, originalExpense: '1000', convertedTwd: 1000,
    specialStatus: false, invoiceNumber: null, paymentSourceFingerprint: null,
    subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
    applicantName: '測試申請人', receiptBuyerName: null, birthDate: null, nationalId: null, householdAddress: null,
  };
}

describe('evaluateSoftwareBlacklist', () => {
  it('needs review when the declared software matches an entry regardless of spacing or case', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('  Some-Blocked Tool '), blacklist: ['some blocked tool'] });
    expect(result.outcome).toBe('needs_review');
    expect(result.reasonCode).toBe('software_blacklisted');
  });

  it('passes when nothing on the list matches', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('ChatGPT'), blacklist: ['some blocked tool'] });
    expect(result.outcome).toBe('pass');
    expect(result.reasonCode).toBe('not_blacklisted');
  });

  it('passes when no blacklist is configured for this rule version', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('ChatGPT'), blacklist: [] });
    expect(result.outcome).toBe('pass');
    expect(result.reasonCode).toBe('blacklist_not_configured');
  });

  it('reports missing when the software name is not yet confirmed', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware(''), blacklist: ['x'] });
    expect(result.outcome).toBe('missing');
  });
});
