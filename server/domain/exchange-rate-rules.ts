import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { REFERENCE_FX_RATES_TWD, FX_TOLERANCE_RATIO, estimateConvertedTwd } from '../../shared/fx-rates';

export { REFERENCE_FX_RATES_TWD, FX_TOLERANCE_RATIO, estimateConvertedTwd } from '../../shared/fx-rates';

/**
 * Card fees, currency spread, and rate movement between purchase and billing
 * only ever push the actual TWD charge above a mid-market estimate, never
 * below it. A declared amount that undercuts the estimate by more than the
 * tolerance is therefore the suspicious direction; one that overshoots it is
 * the expected, normal direction and is never flagged on that basis alone.
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
  const steps: RuleStep[] = [
    { label: '原幣金額', value: `${input.purchase.originalCurrency} ${input.purchase.originalExpense}` },
    { label: '申報台幣', value: `NT$${input.purchase.convertedTwd.toLocaleString('zh-TW')}` },
  ];

  if (estimate.estimatedTwd == null || estimate.referenceRate == null) {
    return {
      ruleCode: 'exchange_rate_reasonableness',
      outcome: 'missing',
      reasonCode: 'reference_rate_unavailable',
      explanation: '尚無對應幣別的參考匯率，待人工確認換算。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps: [...steps, { label: '參考試算', value: '待確認' }],
    };
  }

  steps.push({ label: '參考匯率', value: String(estimate.referenceRate) });
  steps.push({ label: '系統試算', value: `NT$${estimate.estimatedTwd.toLocaleString('zh-TW')}` });

  const declared = input.purchase.convertedTwd;
  const delta = declared - estimate.estimatedTwd;
  const lowerBound = estimate.estimatedTwd - Math.max(1, Math.round(estimate.estimatedTwd * FX_TOLERANCE_RATIO));
  steps.push({
    label: '差異',
    value: `${delta >= 0 ? '+' : ''}NT$${delta.toLocaleString('zh-TW')}（容許低於試算 ${(FX_TOLERANCE_RATIO * 100).toFixed(0)}%，偏高不設上限）`,
  });

  if (declared < lowerBound) {
    return {
      ruleCode: 'exchange_rate_reasonableness',
      outcome: 'needs_review',
      reasonCode: 'exchange_rate_below_band',
      explanation: `申報 ${declared.toLocaleString('zh-TW')} 低於系統試算 ${estimate.estimatedTwd.toLocaleString('zh-TW')} 超過容許區間，請人工確認。`,
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  return {
    ruleCode: 'exchange_rate_reasonableness',
    outcome: 'pass',
    reasonCode: 'exchange_rate_within_band',
    explanation: '匯率換算落在合理區間內。',
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps,
  };
}
