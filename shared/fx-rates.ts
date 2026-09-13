/** Demo/reference mid-market rates to TWD. Policy band is ±3%. */
export const REFERENCE_FX_RATES_TWD: Record<string, number> = {
  TWD: 1,
  USD: 31.5,
  JPY: 0.21,
  EUR: 34.2,
  AUD: 20.8,
  HKD: 4.05,
};

export const FX_TOLERANCE_RATIO = 0.03;

export function estimateConvertedTwd(input: {
  originalCurrency: string;
  otherCurrency: string | null;
  originalExpense: string;
}): { currency: string; referenceRate: number | null; estimatedTwd: number | null } {
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
  const referenceRate = REFERENCE_FX_RATES_TWD[currency] ?? null;
  if (referenceRate == null) return { currency, referenceRate: null, estimatedTwd: null };
  return { currency, referenceRate, estimatedTwd: Math.round(amount * referenceRate) };
}
