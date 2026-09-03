export type NotificationTemplate = 'submission_acknowledged' | 'task_ready' | 'review_updated' | 'security_alert';

const COPY: Record<NotificationTemplate, string> = {
  submission_acknowledged: '申請已送出：您的 FlowPass 申請已送出，請點此查看進度。',
  task_ready: '需要補件：您的 FlowPass 案件有新的待辦，請在期限內開啟查看。',
  review_updated: '審核結果：您的 FlowPass 案件狀態已更新，請開啟查看。',
  security_alert: '資安提醒：您的 FlowPass 護照有一則新的資安提醒，請開啟查看。',
};

const CARD_COPY: Record<NotificationTemplate, { title: string; body: string; actionLabel: string }> = {
  submission_acknowledged: {
    title: '申請已送出',
    body: '申請已成功送出；後續狀態有變更時，FlowPass 會再通知您。',
    actionLabel: '查看申請進度',
  },
  task_ready: {
    title: '需要補件',
    body: '案件有新的待辦，請開啟 FlowPass 查看補件內容與期限。',
    actionLabel: '查看申請紀錄',
  },
  review_updated: {
    title: '案件狀態更新',
    body: '',
    actionLabel: '查看申請進度',
  },
  security_alert: {
    title: '資安提醒',
    body: '您的 FlowPass 護照有新的資安提醒，請開啟查看。',
    actionLabel: '查看護照',
  },
};

export interface NotificationPresentation {
  text: string;
  title: string;
  body: string;
  bodyLabel?: string;
  amountLabel?: string;
  amountValue?: string;
  actionLabel: string;
  updatedAtLabel: string;
  uri: string;
}

export interface NotificationCaseContext {
  state?: string;
  reason?: string | null;
  approvedAmountTwd?: number | null;
  disbursedAmountTwd?: number | null;
}

const REVIEW_STATUS_LABELS: Record<string, string> = {
  submitted: '已送出',
  under_review: '已開始審核',
  awaiting_documents: '需要補充資料',
  returned_for_correction: '需要修正資料',
  resubmitted: '已補充資料',
  approved: '審核通過',
  rejected: '未通過',
  awaiting_disbursement: '等待撥款',
  disbursed: '已撥款',
  closed: '已結案',
};

const LINE_ALT_TEXT_MAX = 400;
const LINE_BODY_TEXT_MAX = 2000;

export function reviewStatusLabel(state: string | undefined): string {
  if (!state) return CARD_COPY.review_updated.title;
  return REVIEW_STATUS_LABELS[state] ?? '處理中';
}

function clipLineText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function notificationText(template: NotificationTemplate): string {
  return COPY[template];
}

export function notificationUri(template: NotificationTemplate, liffId: string): string {
  return `https://liff.line.me/${encodeURIComponent(liffId)}/passports`;
}

function taipeiTimestampLabel(timestamp: string): string {
  const shifted = new Date(new Date(timestamp).getTime() + 8 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 10).replaceAll('-', '/')} ${shifted.slice(11, 16)}`;
}

export function notificationPresentation(
  template: NotificationTemplate,
  liffId: string,
  updatedAt: string,
  context: NotificationCaseContext = {},
): NotificationPresentation {
  if (template === 'review_updated') {
    const title = reviewStatusLabel(context.state);
    const suppliedReason = typeof context.reason === 'string' ? clipLineText(context.reason, LINE_BODY_TEXT_MAX) : '';
    const reason = suppliedReason || '案件狀態已更新，請開啟 FlowPass 查看詳情。';
    const amount = context.state === 'approved'
      ? context.approvedAmountTwd
      : context.state === 'disbursed'
        ? context.disbursedAmountTwd
        : null;
    const amountLabel = context.state === 'approved'
      ? '核定金額'
      : context.state === 'disbursed'
        ? '匯款金額'
        : null;
    const hasAmount = amountLabel
      && typeof amount === 'number'
      && Number.isSafeInteger(amount)
      && amount >= 0;
    const amountValue = hasAmount ? `NT$${amount.toLocaleString('en-US')}` : undefined;
    const text = clipLineText(
      suppliedReason || (hasAmount ? `${title}：${amountLabel} ${amountValue}` : title),
      LINE_ALT_TEXT_MAX,
    );
    return {
      text: suppliedReason ? clipLineText(`${title}：${suppliedReason}`, LINE_ALT_TEXT_MAX) : text,
      title,
      body: reason,
      ...(suppliedReason ? { bodyLabel: '原因' } : {}),
      ...(hasAmount ? { amountLabel: amountLabel ?? undefined, amountValue } : {}),
      actionLabel: CARD_COPY.review_updated.actionLabel,
      updatedAtLabel: taipeiTimestampLabel(updatedAt),
      uri: notificationUri(template, liffId),
    };
  }

  return {
    text: notificationText(template),
    ...CARD_COPY[template],
    updatedAtLabel: taipeiTimestampLabel(updatedAt),
    uri: notificationUri(template, liffId),
  };
}
