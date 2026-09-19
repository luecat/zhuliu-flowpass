import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { toolLabelsMatch } from './submission-checks';

/**
 * The approved-tool list is already close to exhaustive (see
 * shared/approved-ai-tools.ts), so disqualifying software is tracked as a
 * denylist an admin maintains per rule version instead of a second allowlist.
 * Applies equally to a declared "other" software name.
 */
export function evaluateSoftwareBlacklist(input: {
  purchase: PurchaseDetails;
  blacklist: readonly string[];
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const declared = input.purchase.softwareName.trim();
  const base = { ruleCode: 'software_blacklist', ruleVersionId: input.ruleVersionId, inputSnapshotHash: input.inputSnapshotHash, evaluatedAt: input.evaluatedAt };
  const steps: RuleStep[] = [{ label: '申報軟體', value: declared || '待確認' }];

  if (!declared) {
    return { ...base, outcome: 'missing', reasonCode: 'software_name_missing', explanation: '申報軟體名稱尚未確認。', steps };
  }
  if (input.blacklist.length === 0) {
    return { ...base, outcome: 'pass', reasonCode: 'blacklist_not_configured', explanation: '本方案尚未設定軟體黑名單。', steps };
  }

  const matched = input.blacklist.find((entry) => toolLabelsMatch(declared, entry));
  return {
    ...base,
    outcome: matched ? 'needs_review' : 'pass',
    reasonCode: matched ? 'software_blacklisted' : 'not_blacklisted',
    explanation: matched
      ? `申報軟體「${declared}」命中不予補助清單（${matched}），請人工確認。`
      : '申報軟體未命中不予補助清單。',
    steps: matched ? [...steps, { label: '命中項目', value: matched }] : steps,
  };
}
