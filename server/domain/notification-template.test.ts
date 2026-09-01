import { describe, expect, it } from 'vitest';
import { notificationPresentation, notificationText, notificationUri } from './notification-template';

describe('notification templates', () => {
  it('uses generic copy and a case-free LIFF URL', () => {
    const text = notificationText('task_ready');
    expect(text).not.toMatch(/發票|工具|金額|漏洞/);
    expect(notificationUri('task_ready', '123')).toBe('https://liff.line.me/123/passports');
  });

  it('builds safe state-specific card copy and a Taipei update time', () => {
    expect(notificationPresentation('submission_acknowledged', 'liff-id', '2026-09-01T02:02:00.000Z')).toMatchObject({
      title: '申請已送出',
      actionLabel: '查看申請進度',
      updatedAtLabel: '2026/09/01 10:02',
      uri: 'https://liff.line.me/liff-id/passports',
    });
    expect(notificationPresentation('task_ready', 'liff-id', '2026-09-01T02:02:00.000Z')).toMatchObject({
      title: '需要補件',
      actionLabel: '查看申請紀錄',
      uri: 'https://liff.line.me/liff-id/passports',
    });
    expect(notificationPresentation('review_updated', 'liff-id', '2026-09-01T02:02:00.000Z')).toMatchObject({
      title: '案件狀態更新',
      actionLabel: '查看申請紀錄',
      uri: 'https://liff.line.me/liff-id/passports',
    });
    expect(notificationPresentation('security_alert', 'liff-id', '2026-09-01T02:02:00.000Z')).toMatchObject({
      title: '資安提醒',
      actionLabel: '查看護照',
      uri: 'https://liff.line.me/liff-id/passports',
    });

    const rendered = JSON.stringify(notificationPresentation('task_ready', 'liff-id', '2026-09-01T02:02:00.000Z'));
    expect(rendered).not.toMatch(/發票|工具|金額|漏洞|caseId|token/i);
  });
});
