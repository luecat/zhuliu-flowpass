import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { estimateConvertedTwd, FX_TOLERANCE_RATIO } from '../../shared/fx-rates';

export { REFERENCE_FX_RATES_TWD, FX_TOLERANCE_RATIO, estimateConvertedTwd } from '../../shared/fx-rates';

export function evaluateExchangeRateReasonableness(input: {
  purchase: PurchaseDetails;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const estimate = estimateConvertedTwd(input.purchase);
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
  const delta = Math.abs(declared - estimate.estimatedTwd);
  const allowed = Math.max(1, Math.round(estimate.estimatedTwd * FX_TOLERANCE_RATIO));
  const ratio = estimate.estimatedTwd === 0 ? 0 : delta / estimate.estimatedTwd;
  steps.push({
    label: '差異',
    value: `NT$${delta.toLocaleString('zh-TW')}（${(ratio * 100).toFixed(1)}%，容許 ±${(FX_TOLERANCE_RATIO * 100).toFixed(0)}%）`,
  });

  if (delta > allowed) {
    return {
      ruleCode: 'exchange_rate_reasonableness',
      outcome: 'needs_review',
      reasonCode: 'exchange_rate_out_of_band',
      explanation: `申報 ${declared.toLocaleString('zh-TW')}，系統試算 ${estimate.estimatedTwd.toLocaleString('zh-TW')}，差異超出容許區間，請人工確認。`,
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
    explanation: '匯率換算落在參考區間內。',
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps,
  };
}
