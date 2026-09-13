export type ApplicantCaseTone = 'neutral' | 'progress' | 'attention' | 'success' | 'danger';

export interface ApplicantCaseStatusCopy {
  label: string;
  description: string;
  tone: ApplicantCaseTone;
}

const CASE_STATUS_COPY: Record<string, ApplicantCaseStatusCopy> = {
  draft: { label: '填寫中', description: '申請仍在填寫階段。', tone: 'neutral' },
  submitted: { label: '已送出', description: '申請已收件，將安排審查。', tone: 'progress' },
  under_review: { label: '審查中', description: '承辦人員審查中，目前無須進行操作。', tone: 'progress' },
  awaiting_documents: { label: '待補件', description: '請依最新通知補齊資料。', tone: 'attention' },
  returned_for_correction: { label: '待修正', description: '請依最新通知修改申請內容。', tone: 'attention' },
  resubmitted: { label: '已補件', description: '補充資料已收件，等待重新審查。', tone: 'progress' },
  approved: { label: '審核通過', description: '申請已核定，進度將持續更新。', tone: 'success' },
  rejected: { label: '未通過', description: '審查已結束。', tone: 'danger' },
  awaiting_disbursement: { label: '待撥款', description: '申請已核定，款項安排中。', tone: 'success' },
  disbursed: { label: '已撥款', description: '款項已完成撥付。', tone: 'success' },
  closed: { label: '已結案', description: '申請流程已結束。', tone: 'neutral' },
};

/** Applicant-facing program name; the stored cycle name is an administrative label. */
export const APPLICANT_PROGRAM_LABEL = '青年 AI 工具補助';

type ToneLabel = { label: string; tone: ApplicantCaseTone };

export const SECURITY_SEVERITY_COPY: Record<string, ToneLabel> = {
  critical: { label: '緊急', tone: 'danger' },
  high: { label: '高風險', tone: 'danger' },
  medium: { label: '中風險', tone: 'attention' },
  low: { label: '低風險', tone: 'neutral' },
  info: { label: '資訊', tone: 'neutral' },
};

export const SECURITY_ALERT_STATUS_COPY: Record<string, ToneLabel> = {
  open: { label: '待處理', tone: 'attention' },
  acknowledged: { label: '已確認收到', tone: 'progress' },
  resolved: { label: '已處理', tone: 'success' },
};

export function securitySeverity(severity: string): ToneLabel {
  return SECURITY_SEVERITY_COPY[severity] ?? { label: '風險待確認', tone: 'neutral' };
}

export function securityAlertStatus(status: string): ToneLabel {
  return SECURITY_ALERT_STATUS_COPY[status] ?? { label: '處理中', tone: 'progress' };
}

export function applicantCaseStatus(state: string): ApplicantCaseStatusCopy {
  return CASE_STATUS_COPY[state] ?? { label: '處理中', description: '進度更新中，請稍後查看。', tone: 'progress' };
}

export function formatTaipeiDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return '時間待確認';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '時間待確認';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
}

export function formatTwd(value: number): string {
  return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(value);
}
