export type NotificationTemplate = 'submission_acknowledged' | 'task_ready' | 'review_updated' | 'security_alert';

const COPY: Record<NotificationTemplate, string> = {
  submission_acknowledged: '申請已送出：您的 FlowPass 申請已送出，請點此查看進度。',
  task_ready: '需要補件：您的 FlowPass 案件有新的待辦，請在期限內開啟查看。',
  review_updated: '審核結果：您的 FlowPass 案件狀態已更新，請開啟查看。',
  security_alert: '資安提醒：您的 FlowPass 護照有一則新的資安提醒，請開啟查看。',
};

export function notificationText(template: NotificationTemplate): string { return COPY[template]; }
export function notificationUri(template: NotificationTemplate, liffId: string): string { const path = template === 'submission_acknowledged' ? 'status' : template === 'security_alert' ? 'passports' : 'tasks'; return `https://liff.line.me/${encodeURIComponent(liffId)}/${path}`; }
