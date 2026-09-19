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
  return ({
    submission_window: '申請期程',
    purchase_window: '購買期程',
    invoice_duplicate: '發票重複',
    invoice_fingerprint: '發票指紋',
    transaction_fingerprint: '交易指紋',
    payment_source_fingerprint: '付款來源指紋',
    exchange_rate_reasonableness: '匯率合理性',
    tool_consistency: '工具一致性',
    subsidy_estimate: '補助試算',
    admin_data_recalculation: '補助重算',
  } as Record<string, string>)[code] ?? code;
}

export function outcomeLabel(outcome: string) {
  return ({ pass: '通過', fail: '不符', needs_review: '紅燈', missing: '待補' } as Record<string, string>)[outcome] ?? outcome;
}

export function uuid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
