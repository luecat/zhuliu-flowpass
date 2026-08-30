import { describe, expect, it } from 'vitest';
import { notificationText, notificationUri } from './notification-template';

describe('notification templates', () => {
  it('uses generic copy and a case-free LIFF URL', () => {
    const text = notificationText('task_ready');
    expect(text).not.toMatch(/發票|工具|金額|漏洞/);
    expect(notificationUri('task_ready', '123')).toBe('https://liff.line.me/123/tasks');
  });
});
