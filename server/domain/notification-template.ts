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
    body: '案件有新的審核結果，請開啟 FlowPass 查看最新狀態。',
    actionLabel: '查看申請紀錄',
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
  amountLabel?: string;
  amountValue?: string;
  actionLabel: string;
  updatedAtLabel: string;
  uri: string;
}

export interface NotificationCaseContext {
  state?: string;
  approvedAmountTwd?: number | null;
  disbursedAmountTwd?: number | null;
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
  const amountTitle = context.state === 'approved'
    ? '核定通知'
    : context.state === 'disbursed'
      ? '轉帳成功'
      : null;

  if (
    template === 'review_updated'
    && amountLabel
    && amountTitle
    && typeof amount === 'number'
    && Number.isSafeInteger(amount)
    && amount >= 0
  ) {
    const amountValue = `NT$${amount.toLocaleString('en-US')}`;
    return {
      text: `${amountTitle}：${amountLabel} ${amountValue}，請開啟查看。`,
      title: amountTitle,
      body: context.state === 'approved' ? '您的案件已核定。' : '款項已完成轉帳。',
      amountLabel,
      amountValue,
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
