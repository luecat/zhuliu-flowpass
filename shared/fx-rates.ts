/** Demo/reference mid-market rates to TWD. An admin can override these per program rule version. */
export const REFERENCE_FX_RATES_TWD: Record<string, number> = {
  TWD: 1,
  USD: 31.5,
  JPY: 0.21,
  EUR: 34.2,
  AUD: 20.8,
  HKD: 4.05,
};

/**
 * Declared conversion band. Card fees and rate spread only ever push the
 * actual TWD charge up, never down, so the band is asymmetric: this ratio
 * bounds how far BELOW the reference estimate a declared amount may fall
 * before it looks suspicious. There is no corresponding upper bound here —
 * see evaluateExchangeRateReasonableness, which is the caller that decides
 * outcomes from this estimate.
 */
export const FX_TOLERANCE_RATIO = 0.05;

export function estimateConvertedTwd(input: {
  originalCurrency: string;
  otherCurrency: string | null;
  originalExpense: string;
}, referenceRates: Record<string, number> = REFERENCE_FX_RATES_TWD): { currency: string; referenceRate: number | null; estimatedTwd: number | null } {
  const currency =
    input.originalCurrency === 'OTHER'
      ? (input.otherCurrency ?? 'OTHER').trim().toUpperCase()
      : input.originalCurrency;
  const amount = Number(input.originalExpense);
  if (!Number.isFinite(amount) || amount < 0) {
    return { currency, referenceRate: null, estimatedTwd: null };
  }
  if (currency === 'TWD') {
    return { currency, referenceRate: 1, estimatedTwd: Math.round(amount) };
  }
  const referenceRate = referenceRates[currency] ?? null;
  if (referenceRate == null) return { currency, referenceRate: null, estimatedTwd: null };
  return { currency, referenceRate, estimatedTwd: Math.round(amount * referenceRate) };
}
