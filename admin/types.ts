export type Session = { authenticated: boolean; displayName: string; mustChangePassword: boolean; passwordExpiresAt?: string };

export type Case = {
  id: string;
  caseCode: string;
  state: string;
  submittedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  rowVersion?: string | number;
  applicantName?: string;
  programName?: string;
  requestedAmountTwd?: number;
  calculatedAmountTwd?: number;
  approvedAmountTwd?: number;
  disbursedAmountTwd?: number;
  needsReviewCount?: number;
};

export type RuleEvaluationView = {
  id: string;
  ruleCode: string;
  outcome: string;
  explanation: string;
  steps: Array<{ label: string; value: string }>;
  createdAt?: string;
};

export type Attachment = {
  id: string;
  kind: string;
  requirementKey?: string;
  mediaType: string;
  byteSize: number;
  originalName: string;
  status: string;
  createdAt?: string;
  rowVersion?: number;
};

export type Review = {
  action: string;
  toState: string;
  label: string;
  cta: string;
  fromStates: string[];
  reasonLabel?: string;
  reasonPlaceholder?: string;
  amount?: 'approved' | 'disbursed';
  supplement?: 'documents' | 'correction';
  confirm?: boolean;
  danger?: boolean;
};

export type ReviewDecision = {
  reason?: string;
  approvedAmountTwd?: number;
  disbursedAmountTwd?: number;
  title?: string;
  instructions?: string;
  passportReconfirmationRequired?: boolean;
};

export type AiUsage = {
  provider: string;
  minuteKey: string;
  dayKey: string;
  models: Array<{
    id: string;
    requestsThisMinute: number;
    inputTokensThisMinute: number;
    requestsToday: number;
    inputTokensToday: number;
    recordedRuns: number;
    averageDurationMs: number;
  }>;
};

export const REVIEWS: Review[] = [
  { action: 'start_review', toState: 'under_review', label: '開始審核', cta: '開始審核', fromStates: ['submitted', 'resubmitted', 'awaiting_documents', 'returned_for_correction'] },
  { action: 'request_documents', toState: 'awaiting_documents', label: '要求補件', cta: '要求補件', fromStates: ['under_review'], supplement: 'documents', confirm: true },
  { action: 'approve', toState: 'approved', label: '核准', cta: '核准案件', fromStates: ['under_review'], reasonLabel: '核准說明', reasonPlaceholder: '請填寫核准原因或審核摘要', amount: 'approved', confirm: true },
  { action: 'reject', toState: 'rejected', label: '駁回', cta: '駁回案件', fromStates: ['under_review', 'awaiting_documents', 'returned_for_correction'], reasonLabel: '駁回原因', reasonPlaceholder: '請具體說明駁回原因', confirm: true, danger: true },
  { action: 'await_disbursement', toState: 'awaiting_disbursement', label: '列入撥款', cta: '列入撥款', fromStates: ['approved'], reasonLabel: '列入撥款說明', reasonPlaceholder: '請留下撥款排程或核對說明', confirm: true },
  { action: 'disburse', toState: 'disbursed', label: '標記已撥款', cta: '確認已撥款', fromStates: ['awaiting_disbursement'], reasonLabel: '撥款紀錄', reasonPlaceholder: '請留下撥款日期或核對資訊', amount: 'disbursed', confirm: true },
  { action: 'close', toState: 'closed', label: '結案', cta: '結案', fromStates: ['disbursed'], reasonLabel: '結案說明', reasonPlaceholder: '請說明結案原因', confirm: true },
];
