import type { FieldCrypto } from '../crypto/field-crypto';
import type { PurchaseDetails, PurchaseDetailsWrite } from '../../shared/purchase-details-contract';

export const PAYMENT_SOURCE_HMAC_PURPOSE = 'payment-source-fingerprint';

export function normalizeCardholderName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildPaymentSourceFingerprint(
  crypto: FieldCrypto,
  cardLastFour: string,
  cardholderName: string,
): string {
  const material = `${cardLastFour}\n${normalizeCardholderName(cardholderName)}`;
  return crypto.hmacLookup(material, PAYMENT_SOURCE_HMAC_PURPOSE);
}

export function materializePurchaseDetails(input: {
  write: PurchaseDetailsWrite;
  crypto: FieldCrypto;
  previous?: PurchaseDetails | null;
}): PurchaseDetails {
  const { write, crypto, previous } = input;
  let paymentSourceFingerprint: string | null = null;
  if (write.cardLastFour && write.cardholderName) {
    paymentSourceFingerprint = buildPaymentSourceFingerprint(crypto, write.cardLastFour, write.cardholderName);
  } else if (write.keepExistingPaymentSource && previous?.paymentSourceFingerprint) {
    paymentSourceFingerprint = previous.paymentSourceFingerprint;
  }

  return {
    billingCycle: write.billingCycle,
    billingPeriods: write.billingPeriods,
    softwareFunction: write.softwareFunction,
    otherFunction: write.otherFunction,
    softwareName: write.softwareName,
    companyName: write.companyName,
    purchaseDate: write.purchaseDate,
    payerType: write.payerType,
    originalCurrency: write.originalCurrency,
    otherCurrency: write.otherCurrency,
    originalExpense: write.originalExpense,
    convertedTwd: write.convertedTwd,
    specialStatus: write.specialStatus,
    invoiceNumber: write.invoiceNumber,
    subscriptionStartDate: write.subscriptionStartDate,
    subscriptionEndDate: write.subscriptionEndDate,
    applicantName: write.applicantName,
    receiptBuyerName: write.receiptBuyerName,
    birthDate: write.birthDate,
    paymentSourceFingerprint,
  };
}
