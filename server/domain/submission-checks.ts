import { createHash } from 'node:crypto';
import type { FlowPassDatabase } from '../db/connection';
import type { FlowPassPassport } from '../../shared/passport-contract';
import type { PurchaseDetails } from '../../shared/purchase-details-contract';
import type { RuleEvaluation, RuleStep, SubsidyCalculation } from '../../shared/rule-contract';

const FINGERPRINT_STEP_LABEL = '交易指紋';

export function normalizeToolLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_/·・.，,（）()【】［］[\]]+/g, '')
    .trim();
}

export function toolLabelsMatch(declared: string, candidate: string): boolean {
  const left = normalizeToolLabel(declared);
  const right = normalizeToolLabel(candidate);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

export function passportToolLabels(passport: FlowPassPassport): string[] {
  const labels = passport.nodes
    .filter((node) => node.kind === 'ai_tool' || node.kind === 'plugin')
    .map((node) => node.label.trim())
    .filter(Boolean);
  const requested = passport.administrative_hints.requested_tool.trim();
  if (requested && requested !== 'unknown') labels.push(requested);
  return [...new Set(labels)];
}

export function evaluateToolConsistency(input: {
  purchase: PurchaseDetails;
  passport: FlowPassPassport;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const declared = input.purchase.softwareName.trim();
  const candidates = passportToolLabels(input.passport);
  const steps: RuleStep[] = [
    { label: '申報軟體', value: declared || '待確認' },
    { label: '護照工具', value: candidates.length > 0 ? candidates.join('、') : '未記載' },
  ];

  if (!declared) {
    return {
      ruleCode: 'tool_consistency',
      outcome: 'missing',
      reasonCode: 'software_name_missing',
      explanation: '申報軟體名稱尚未確認。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  if (candidates.length === 0) {
    return {
      ruleCode: 'tool_consistency',
      outcome: 'needs_review',
      reasonCode: 'passport_tool_missing',
      explanation: '護照未記載可用的工具節點，無法自動比對申報軟體。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps,
    };
  }

  const matched = candidates.some((candidate) => toolLabelsMatch(declared, candidate));
  return {
    ruleCode: 'tool_consistency',
    outcome: matched ? 'pass' : 'needs_review',
    reasonCode: matched ? 'tool_matches_passport' : 'tool_mismatch',
    explanation: matched
      ? '申報軟體名稱與護照工具節點相符。'
      : `申報「${declared}」與護照工具「${candidates.join('、')}」不一致，請人工確認。`,
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps,
  };
}

export function buildTransactionFingerprint(details: PurchaseDetails): string {
  const currency =
    details.originalCurrency === 'OTHER'
      ? (details.otherCurrency ?? 'OTHER').trim().toUpperCase()
      : details.originalCurrency;
  const material = [
    normalizeToolLabel(details.softwareName),
    normalizeToolLabel(details.companyName),
    currency,
    details.originalExpense,
    details.purchaseDate,
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

const PAYMENT_SOURCE_STEP_LABEL = '付款來源指紋';
const INVOICE_STEP_LABEL = '發票指紋';

function findRuleFingerprintMatches(
  database: FlowPassDatabase,
  caseId: string,
  ruleCode: string,
  stepLabel: string,
  fingerprint: string,
): Array<{ caseId: string; caseCode: string }> {
  const rows = database
    .prepare(
      `SELECT re.case_id AS case_id, c.case_code AS case_code, re.result_json AS result_json
       FROM rule_evaluations re
       JOIN cases c ON c.id = re.case_id AND c.deleted_at IS NULL
       WHERE re.case_id != ?
         AND c.state != 'draft'
         AND json_extract(re.result_json, '$.ruleCode') = ?
       ORDER BY re.created_at DESC, re.id DESC`,
    )
    .all(caseId, ruleCode) as Array<{ case_id: string; case_code: string; result_json: string }>;

  const seen = new Set<string>();
  const matches: Array<{ caseId: string; caseCode: string }> = [];
  for (const row of rows) {
    if (seen.has(row.case_id)) continue;
    let fingerprintValue: string | null = null;
    try {
      const parsed = JSON.parse(row.result_json) as { steps?: Array<{ label?: string; value?: string }> };
      fingerprintValue = parsed.steps?.find((step) => step.label === stepLabel)?.value ?? null;
    } catch {
      fingerprintValue = null;
    }
    if (fingerprintValue !== fingerprint) continue;
    seen.add(row.case_id);
    matches.push({ caseId: row.case_id, caseCode: row.case_code });
  }
  return matches;
}

export function findTransactionFingerprintMatches(
  database: FlowPassDatabase,
  caseId: string,
  fingerprint: string,
): Array<{ caseId: string; caseCode: string }> {
  return findRuleFingerprintMatches(database, caseId, 'transaction_fingerprint', FINGERPRINT_STEP_LABEL, fingerprint);
}

export function evaluateTransactionFingerprint(input: {
  database: FlowPassDatabase;
  caseId: string;
  purchase: PurchaseDetails;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const fingerprint = buildTransactionFingerprint(input.purchase);
  const matches = findTransactionFingerprintMatches(input.database, input.caseId, fingerprint);
  const steps: RuleStep[] = [
    { label: FINGERPRINT_STEP_LABEL, value: fingerprint },
    {
      label: '比對結果',
      value:
        matches.length === 0
          ? '未發現相同交易指紋'
          : `相同工具／金額／日期曾出現於 ${matches.length} 件案件：${matches.map((item) => item.caseCode).join('、')}`,
    },
  ];

  return {
    ruleCode: 'transaction_fingerprint',
    outcome: matches.length > 0 ? 'needs_review' : 'pass',
    reasonCode: matches.length > 0 ? 'duplicate_transaction_signal' : 'unique_transaction',
    explanation:
      matches.length > 0
        ? `相同工具、供應商、幣別、金額與購買日期曾出現於 ${matches.length} 件案件，請人工確認是否重複請領。`
        : '未發現相同交易指紋。',
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps,
  };
}

export function evaluatePaymentSourceFingerprint(input: {
  database: FlowPassDatabase;
  caseId: string;
  purchase: PurchaseDetails;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const fingerprint = input.purchase.paymentSourceFingerprint;
  if (!fingerprint) {
    return {
      ruleCode: 'payment_source_fingerprint',
      outcome: 'missing',
      reasonCode: 'payment_source_missing',
      explanation: '尚未登記付款來源指紋（信用卡末四碼雜湊），待補件或人工確認。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps: [{ label: '付款來源', value: '未登記' }],
    };
  }

  const matches = findRuleFingerprintMatches(
    input.database,
    input.caseId,
    'payment_source_fingerprint',
    PAYMENT_SOURCE_STEP_LABEL,
    fingerprint,
  );
  return {
    ruleCode: 'payment_source_fingerprint',
    outcome: matches.length > 0 ? 'needs_review' : 'pass',
    reasonCode: matches.length > 0 ? 'shared_payment_source' : 'unique_payment_source',
    explanation:
      matches.length > 0
        ? `此付款來源曾出現於 ${matches.length} 件案件，請人工確認是否為合法代付或重複請領。`
        : '未發現相同付款來源指紋。',
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps: [
      { label: PAYMENT_SOURCE_STEP_LABEL, value: fingerprint },
      {
        label: '比對結果',
        value:
          matches.length === 0
            ? '未發現相同付款來源'
            : `此來源曾出現於 ${matches.length} 件案件：${matches.map((item) => item.caseCode).join('、')}`,
      },
    ],
  };
}

export function evaluateInvoiceFingerprint(input: {
  database: FlowPassDatabase;
  caseId: string;
  purchase: PurchaseDetails;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const invoiceNumber = input.purchase.invoiceNumber?.trim() ?? '';
  if (!invoiceNumber) {
    return {
      ruleCode: 'invoice_fingerprint',
      outcome: 'missing',
      reasonCode: 'invoice_number_missing',
      explanation: '發票號碼尚未填寫，待人工覆核附件。',
      ruleVersionId: input.ruleVersionId,
      inputSnapshotHash: input.inputSnapshotHash,
      evaluatedAt: input.evaluatedAt,
      steps: [{ label: '發票號碼', value: '待確認' }],
    };
  }

  const fingerprint = createHash('sha256').update(normalizeToolLabel(invoiceNumber), 'utf8').digest('hex');
  const matches = findRuleFingerprintMatches(
    input.database,
    input.caseId,
    'invoice_fingerprint',
    INVOICE_STEP_LABEL,
    fingerprint,
  );
  return {
    ruleCode: 'invoice_fingerprint',
    outcome: matches.length > 0 ? 'needs_review' : 'pass',
    reasonCode: matches.length > 0 ? 'duplicate_invoice_number' : 'unique_invoice_number',
    explanation:
      matches.length > 0
        ? `相同發票號碼曾出現於 ${matches.length} 件案件，請人工確認。`
        : '未發現相同發票號碼。',
    ruleVersionId: input.ruleVersionId,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAt: input.evaluatedAt,
    steps: [
      { label: INVOICE_STEP_LABEL, value: fingerprint },
      {
        label: '比對結果',
        value:
          matches.length === 0
            ? '未發現相同發票號碼'
            : `相同發票號碼曾出現於 ${matches.length} 件案件：${matches.map((item) => item.caseCode).join('、')}`,
      },
    ],
  };
}

export function subsidyDerivationSteps(calculation: SubsidyCalculation & { uncappedAmountTwd: number }): RuleStep[] {
  const ratePercent = (calculation.rateBps / 100).toFixed(calculation.rateBps % 100 === 0 ? 0 : 2);
  const capped = calculation.reasonCode === 'cap_applied';
  return [
    { label: '合格購買金額', value: `NT$${calculation.eligiblePurchaseTwd.toLocaleString('zh-TW')}` },
    { label: '補助比例', value: `${ratePercent}%` },
    {
      label: '比例計算',
      value: `NT$${calculation.eligiblePurchaseTwd.toLocaleString('zh-TW')} × ${ratePercent}% = NT$${calculation.uncappedAmountTwd.toLocaleString('zh-TW')}`,
    },
    { label: '補助上限', value: `NT$${calculation.capTwd.toLocaleString('zh-TW')}` },
    {
      label: '核定金額',
      value: capped
        ? `NT$${calculation.calculatedAmountTwd.toLocaleString('zh-TW')}（觸及上限）`
        : `NT$${calculation.calculatedAmountTwd.toLocaleString('zh-TW')}`,
    },
  ];
}
