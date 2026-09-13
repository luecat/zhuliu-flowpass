import type { SubsidyCalculation } from '../../shared/rule-contract';

export type SubsidyCalculationResult = SubsidyCalculation & { uncappedAmountTwd: number };

export function calculateSubsidy(input: {
  eligiblePurchaseTwd: number;
  rateBps: number;
  capTwd: number;
  roundingMode?: 'floor' | 'half_up';
}): SubsidyCalculationResult {
  if (
    !Number.isSafeInteger(input.eligiblePurchaseTwd) ||
    input.eligiblePurchaseTwd < 0 ||
    !Number.isSafeInteger(input.rateBps) ||
    input.rateBps < 0 ||
    input.rateBps > 10_000 ||
    !Number.isSafeInteger(input.capTwd) ||
    input.capTwd < 0
  ) {
    throw new Error('subsidy input is invalid');
  }
  const numerator = BigInt(input.eligiblePurchaseTwd) * BigInt(input.rateBps);
  const denominator = BigInt(10_000);
  const rounded =
    input.roundingMode === 'half_up'
      ? (numerator + denominator / BigInt(2)) / denominator
      : numerator / denominator;
  const capped = rounded > BigInt(input.capTwd) ? BigInt(input.capTwd) : rounded;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || capped > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('subsidy result is invalid');
  }
  const uncappedAmountTwd = Number(rounded);
  const amount = Number(capped);
  return {
    eligiblePurchaseTwd: input.eligiblePurchaseTwd,
    rateBps: input.rateBps,
    capTwd: input.capTwd,
    calculatedAmountTwd: amount,
    uncappedAmountTwd,
    roundingMode: input.roundingMode ?? 'floor',
    reasonCode: amount === input.capTwd ? 'cap_applied' : 'rate_applied',
  };
}
