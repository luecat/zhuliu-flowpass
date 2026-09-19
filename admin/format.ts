export function date(value?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function money(value?: number) {
  return typeof value === 'number' ? new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(value) : '—';
}

export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function label(state: string) {
  return ({
    draft: '草稿',
    submitted: '待審',
    under_review: '審核中',
    awaiting_documents: '待補件',
    returned_for_correction: '退回修正',
    approved: '已核准',
    rejected: '已駁回',
    awaiting_disbursement: '待撥款',
    disbursed: '已撥款',
    closed: '已結案',
  } as Record<string, string>)[state] ?? state;
}

export function ruleLabel(code: string) {
  return (
    ({
      submission_window: '申請期程',
      purchase_window: '購買期程',
      age_eligibility: '年齡資格',
      applicant_name_consistency: '申請人姓名一致性',
      software_blacklist: '軟體黑名單',
      invoice_duplicate: '發票重複',
      invoice_fingerprint: '發票指紋',
      transaction_fingerprint: '交易指紋',
      payment_source_fingerprint: '付款來源指紋',
      exchange_rate_reasonableness: '收據與付款金額',
      tool_consistency: '工具一致性',
      subsidy_estimate: '補助試算',
      admin_data_recalculation: '補助重算',
      personal_data: '個人資料風險',
      health_data: '健康資料風險',
      public_destination: '公開用途風險',
      plugin_use: '外掛使用',
      deletion_period: '刪除期限',
      access_control: '存取控管',
      deidentification: '去識別化',
    } as Record<string, string>)[code] ?? '勾稽項目'
  );
}

export function outcomeLabel(outcome: string) {
  return ({ pass: '通過', fail: '不符', needs_review: '紅燈', missing: '待補' } as Record<string, string>)[outcome] ?? outcome;
}

const REQUIREMENT_LABELS: Record<string, string> = {
  identity_front: '身分證正面',
  identity_back: '身分證反面',
  special_status_proof: '資格證明',
  purchase_proof: '購買憑證或發票',
  vendor_receipt: '官方收據',
  card_transaction: '刷卡單筆明細',
  passbook_cover: '存摺封面影本',
  affidavit: '切結書',
  representative_affidavit: '代付切結書',
};

const KIND_LABELS: Record<string, string> = {
  invoice: '發票／購買憑證',
  eligibility_proof: '資格證明',
  supplement: '補充文件',
  other: '其他附件',
};

export function attachmentLabel(doc: { requirementKey?: string; kind: string }) {
  return REQUIREMENT_LABELS[doc.requirementKey ?? ''] ?? KIND_LABELS[doc.kind] ?? '附件';
}

export function uuid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
