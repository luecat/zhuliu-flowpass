export type ApplicantCaseTone = 'neutral' | 'progress' | 'attention' | 'success' | 'danger';

export interface ApplicantCaseStatusCopy {
  label: string;
  description: string;
  tone: ApplicantCaseTone;
}

const CASE_STATUS_COPY: Record<string, ApplicantCaseStatusCopy> = {
  draft: { label: '填寫中', description: '這份申請仍在填寫中。', tone: 'neutral' },
  submitted: { label: '已送出', description: '申請已收到，接下來將安排審查。', tone: 'progress' },
  under_review: { label: '審查中', description: '承辦人員正在確認申請內容，暫時不需要進行其他操作。', tone: 'progress' },
  awaiting_documents: { label: '需要補充資料', description: '請依照最新通知補上所需資料。', tone: 'attention' },
  returned_for_correction: { label: '需要修正資料', description: '請依照最新通知更新申請內容。', tone: 'attention' },
  resubmitted: { label: '已補充資料', description: '補充資料已收到，正在等待重新審查。', tone: 'progress' },
  approved: { label: '審核通過', description: '申請已核定，後續進度會在這裡更新。', tone: 'success' },
  rejected: { label: '未通過', description: '本次申請已完成審查。', tone: 'danger' },
  awaiting_disbursement: { label: '等待撥款', description: '申請已核定，款項正在安排中。', tone: 'success' },
  disbursed: { label: '已撥款', description: '核定款項已完成撥付。', tone: 'success' },
  closed: { label: '已結案', description: '這筆申請流程已完成。', tone: 'neutral' },
};

export function applicantCaseStatus(state: string): ApplicantCaseStatusCopy {
  return CASE_STATUS_COPY[state] ?? { label: '處理中', description: '最新進度整理中，請稍後再查看。', tone: 'progress' };
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
