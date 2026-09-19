import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  return left.length > 0 && left === right;
}

/**
 * Who the official vendor receipt's buyer name should match depends on who
 * paid: the applicant themselves, or a representative (parent, spouse, legal
 * guardian) who signed the co-payment affidavit. That affidavit document is a
 * separate hard requirement enforced at submission (see
 * submission-service.ts requiredDocumentKeys) — this rule only judges whether
 * the receipt's name is consistent with the declared payer, not whether the
 * affidavit was uploaded.
 *
 * cardholderName only exists as plaintext for the duration of the
 * purchase-details write request that carries it (it is discarded to an HMAC
 * fingerprint immediately after), so this must run there rather than at
 * final submission — see purchase-details-materialize.ts and the PUT route.
 */
export function evaluateApplicantNameConsistency(input: {
  applicantName: string | null;
  cardholderName: string | null;
  payerType: 'self_card' | 'representative';
  receiptBuyerName: string | null;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const receiptName = input.receiptBuyerName?.trim() ?? '';
  const steps: RuleStep[] = [
    { label: '收據買受人', value: receiptName || '尚未辨識' },
    { label: '申請人姓名', value: input.applicantName ?? '待確認' },
    { label: '付款人別', value: input.payerType === 'representative' ? '代付' : '本人信用卡' },
  ];

  if (!receiptName) {
    return {
      ruleCode: 'applicant_name_consistency',
      outcome: 'missing',
      reasonCode: 'receipt_name_unread',
      explanation: '收據上尚未辨識或填寫買受人姓名，待確認。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  if (input.applicantName && namesMatch(receiptName, input.applicantName)) {
    return {
      ruleCode: 'applicant_name_consistency',
      outcome: 'pass',
      reasonCode: 'matches_applicant',
      explanation: '收據買受人與申請人姓名相符。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  if (input.payerType === 'representative' && input.cardholderName && namesMatch(receiptName, input.cardholderName)) {
    return {
      ruleCode: 'applicant_name_consistency',
      outcome: 'pass',
      reasonCode: 'matches_representative',
      explanation: `收據買受人與代付人（持卡人）${input.cardholderName}相符。`,
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  return {
    ruleCode: 'applicant_name_consistency',
    outcome: 'needs_review',
    reasonCode: 'name_mismatch',
    explanation: `收據買受人「${receiptName}」與申請人${input.payerType === 'representative' ? '及代付人' : ''}姓名皆不符，請人工確認。`,
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps,
  };
}
