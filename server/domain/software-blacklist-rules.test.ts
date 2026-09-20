import { describe, expect, it } from 'vitest';
import { evaluateSoftwareBlacklist } from './software-blacklist-rules';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';

const base = { ruleVersionId: 'rule', inputSnapshotHash: 'h', evaluatedAt: '2026-09-19T00:00:00.000Z' };

function purchaseWithSoftware(softwareName: string, companyName = 'Example Inc.', receiptVendorName: string | null = null): PurchaseDetails {
  return {
    billingCycle: 'annual', billingPeriods: null, softwareFunction: 'general', otherFunction: null,
    softwareName, companyName, purchaseDate: '2026-08-30', payerType: 'self_card',
    originalCurrency: 'TWD', otherCurrency: null, originalExpense: '1000', convertedTwd: 1000,
    specialStatus: false, invoiceNumber: null, paymentSourceFingerprint: null,
    subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
    applicantName: '測試申請人', receiptBuyerName: null, receiptVendorName, birthDate: null, nationalId: null, householdAddress: null,
  };
}

describe('evaluateSoftwareBlacklist', () => {
  it('fails when the declared software matches an entry regardless of spacing or case', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('  Some-Blocked Tool '), blacklist: ['some blocked tool'] });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('software_blacklisted');
  });

  it('fails when the vendor read from the receipt matches an entry, whatever the software is called', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('Some Tool', 'Blocked Vendor Inc.'), blacklist: ['blocked vendor'] });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('vendor_blacklisted');
    expect(result.steps.map((step) => step.label)).toContain('申報廠商');
  });

  it('fails on the vendor OCR read off the receipt even when the declared fields look clean', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('Claude', 'Anthropic', 'Blocked Vendor (Singapore) Private Limited'), blacklist: ['blocked vendor'] });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('vendor_blacklisted');
    expect(result.explanation).toContain('Blocked Vendor (Singapore) Private Limited');
  });

  it('matches a denylist entry across scripts, so 騰訊 and 腾讯 are the same vendor', () => {
    const traditional = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('騰訊混元'), blacklist: ['腾讯'] });
    expect(traditional.outcome).toBe('fail');
    const simplified = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('腾讯混元'), blacklist: ['騰訊'] });
    expect(simplified.outcome).toBe('fail');
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

  it('still screens the vendor when the software name is not yet confirmed', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('', 'Blocked Vendor Inc.'), blacklist: ['blocked vendor'] });
    expect(result.outcome).toBe('fail');
    expect(result.reasonCode).toBe('vendor_blacklisted');
  });

  it('reports missing when neither the software name nor the vendor is confirmed', () => {
    const result = evaluateSoftwareBlacklist({ ...base, purchase: purchaseWithSoftware('', ''), blacklist: ['x'] });
    expect(result.outcome).toBe('missing');
  });
});
