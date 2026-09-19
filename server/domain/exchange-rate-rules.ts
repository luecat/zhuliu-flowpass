import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { REFERENCE_FX_RATES_TWD, FX_TOLERANCE_RATIO, estimateConvertedTwd } from '../../shared/fx-rates';

export { REFERENCE_FX_RATES_TWD, FX_TOLERANCE_RATIO, estimateConvertedTwd } from '../../shared/fx-rates';

/**
 * Cross-check the official receipt amount against the bank / card payment
 * screenshot amount (`convertedTwd`).
 *
 * - TWD receipts: the two figures must match exactly (rounded).
 * - Foreign currency: card fees only push the TWD charge up, so a payment
 *   more than FX_TOLERANCE_RATIO below the mid-market estimate is treated as
 *   inconsistent and fails — not merely needs_review.
 */
export function evaluateExchangeRateReasonableness(input: {
  purchase: PurchaseDetails;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
  referenceFxRates?: Record<string, number>;
}): RuleEvaluation {
  const referenceRates = input.referenceFxRates ?? REFERENCE_FX_RATES_TWD;
  const estimate = estimateConvertedTwd(input.purchase, referenceRates);
  const paid = input.purchase.convertedTwd;
  const steps: RuleStep[] = [
    { label: '官方收據金額', value: `${input.purchase.originalCurrency} ${input.purchase.originalExpense}` },
    { label: '銀行付款實付台幣', value: `NT$${paid.toLocaleString('zh-TW')}` },
  ];

  const base = {
    ruleCode: 'exchange_rate_reasonableness' as const,
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
  };

  if (estimate.estimatedTwd == null || estimate.referenceRate == null) {
    return {
      ...base,
      outcome: 'missing',
      reasonCode: 'reference_rate_unavailable',
      explanation: '尚無對應幣別的參考匯率，無法交叉比對官方收據與銀行付款金額。',
      steps: [...steps, { label: '收據試算台幣', value: '待確認' }],
    };
  }

  steps.push({ label: '參考匯率', value: String(estimate.referenceRate) });
  steps.push({ label: '收據試算台幣', value: `NT$${estimate.estimatedTwd.toLocaleString('zh-TW')}` });

  // Domestic receipts: bank screenshot must match the receipt figure exactly.
  if (estimate.currency === 'TWD') {
    steps.push({
      label: '比對結果',
      value: paid === estimate.estimatedTwd ? '一致' : '不一致',
    });
    if (paid !== estimate.estimatedTwd) {
      return {
        ...base,
        outcome: 'fail',
        reasonCode: 'receipt_payment_amount_mismatch',
        explanation: `官方收據金額 NT$${estimate.estimatedTwd.toLocaleString('zh-TW')} 與銀行付款實付台幣 NT$${paid.toLocaleString('zh-TW')} 不一致。`,
        steps,
      };
    }
    return {
      ...base,
      outcome: 'pass',
      reasonCode: 'receipt_payment_amount_match',
      explanation: '官方收據金額與銀行付款實付台幣一致。',
      steps,
    };
  }

  const delta = paid - estimate.estimatedTwd;
  const lowerBound = estimate.estimatedTwd - Math.max(1, Math.round(estimate.estimatedTwd * FX_TOLERANCE_RATIO));
  steps.push({
    label: '差異',
    value: `${delta >= 0 ? '+' : ''}NT$${delta.toLocaleString('zh-TW')}（容許低於試算 ${(FX_TOLERANCE_RATIO * 100).toFixed(0)}%，偏高視為手續費）`,
  });

  if (paid < lowerBound) {
    return {
      ...base,
      outcome: 'fail',
      reasonCode: 'receipt_payment_amount_mismatch',
      explanation: `銀行付款實付台幣 NT$${paid.toLocaleString('zh-TW')} 明顯低於官方收據試算 NT$${estimate.estimatedTwd.toLocaleString('zh-TW')}，交叉比對失敗。`,
      steps,
    };
  }

  return {
    ...base,
    outcome: 'pass',
    reasonCode: 'receipt_payment_amount_consistent',
    explanation: '官方收據金額與銀行付款實付台幣交叉比對一致。',
    steps,
  };
}
