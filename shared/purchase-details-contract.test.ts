import { describe, expect, it } from 'vitest';
import { PurchaseDetailsWriteSchema } from './purchase-details-contract';

const completeWrite = {
  billingCycle: 'annual' as const,
  billingPeriods: null,
  softwareFunction: 'imaging' as const,
  otherFunction: null,
  softwareName: '修圖工具',
  companyName: 'Example Inc.',
  purchaseDate: '2026-08-30',
  payerType: 'self_card' as const,
  originalCurrency: 'TWD' as const,
  otherCurrency: null,
  originalExpense: '1200',
  convertedTwd: 1200,
  specialStatus: false,
  invoiceNumber: null,
  subscriptionStartDate: '2026-08-01',
  subscriptionEndDate: '2027-07-31',
  applicantName: '測試申請人',
  receiptBuyerName: '測試申請人',
  birthDate: null,
  nationalId: 'A123456789',
  householdAddress: '臺北市中正區測試路 1 號',
  cardLastFour: '4242',
  cardholderName: '測試持卡人',
};

describe('PurchaseDetailsWriteSchema', () => {
  it('accepts a full payment payload', () => {
    expect(PurchaseDetailsWriteSchema.safeParse(completeWrite).success).toBe(true);
  });

  it('rejects a missing card pair unless payment is deferred or kept', () => {
    const parsed = PurchaseDetailsWriteSchema.safeParse({
      ...completeWrite,
      cardLastFour: null,
      cardholderName: null,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === 'cardLastFour')).toBe(true);
  });

  it('allows deferPaymentSource to persist OCR-page fields without a card pair', () => {
    const parsed = PurchaseDetailsWriteSchema.safeParse({
      ...completeWrite,
      cardLastFour: null,
      cardholderName: null,
      deferPaymentSource: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('still requires the card pair together when deferPaymentSource is set', () => {
    const parsed = PurchaseDetailsWriteSchema.safeParse({
      ...completeWrite,
      cardLastFour: '4242',
      cardholderName: null,
      deferPaymentSource: true,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === 'cardholderName')).toBe(true);
  });
});
