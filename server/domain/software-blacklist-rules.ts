import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { toolLabelsMatch } from './submission-checks';

/**
 * The approved-tool list is already close to exhaustive (see
 * shared/approved-ai-tools.ts), so disqualifying software is tracked as a
 * denylist an admin maintains per rule version instead of a second allowlist.
 * Applies equally to a declared "other" software name.
 *
 * Both the software name and the vendor (軟體公司名稱) are checked: the
 * vendor receipt's OCR pass fills both fields (see
 * app/lib/ocr-field-extraction.ts), and a denylisted vendor disqualifies the
 * purchase whichever product name is printed on the receipt.
 *
 * A hit is 'fail', not 'needs_review': the submission service rejects the
 * attempt outright rather than letting it through for a reviewer.
 */
export function evaluateSoftwareBlacklist(input: {
  purchase: PurchaseDetails;
  blacklist: readonly string[];
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const declared = input.purchase.softwareName.trim();
  const vendor = input.purchase.companyName.trim();
  // What OCR read off the receipt, when it read one — the only vendor value
  // the applicant never types (see shared/purchase-details-contract.ts).
  const receiptVendor = (input.purchase.receiptVendorName ?? '').trim();
  const base = { ruleCode: 'software_blacklist', ruleVersionId: input.ruleVersionId, inputSnapshotHash: input.inputSnapshotHash, evaluatedAt: input.evaluatedAt };
  const steps: RuleStep[] = [
    { label: '申報軟體', value: declared || '待確認' },
    { label: '申報廠商', value: vendor || '待確認' },
    { label: '收據開立廠商', value: receiptVendor || '未辨識' },
  ];

  if (!declared && !vendor && !receiptVendor) {
    return { ...base, outcome: 'missing', reasonCode: 'software_name_missing', explanation: '申報軟體名稱尚未確認。', steps };
  }
  if (input.blacklist.length === 0) {
    return { ...base, outcome: 'pass', reasonCode: 'blacklist_not_configured', explanation: '本方案尚未設定軟體黑名單。', steps };
  }

  const matchOn = (value: string) => value ? input.blacklist.find((entry) => toolLabelsMatch(value, entry)) : undefined;
  const softwareMatch = matchOn(declared);
  const vendorMatch = softwareMatch ? undefined : (matchOn(vendor) ?? matchOn(receiptVendor));
  const matched = softwareMatch ?? vendorMatch;

  if (!matched) {
    return { ...base, outcome: 'pass', reasonCode: 'not_blacklisted', explanation: '申報軟體與廠商未命中不予補助清單。', steps };
  }
  return {
    ...base,
    outcome: 'fail',
    reasonCode: softwareMatch ? 'software_blacklisted' : 'vendor_blacklisted',
    explanation: softwareMatch
      ? `申報軟體「${declared}」命中不予補助清單（${matched}），無法受理送件。`
      : `申報廠商「${matchOn(vendor) ? vendor : receiptVendor}」命中不予補助清單（${matched}），無法受理送件。`,
    steps: [...steps, { label: '命中項目', value: matched }],
  };
}
