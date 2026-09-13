import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityAlerts } from './security-alerts';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = mocks.read; } };
});

describe('SecurityAlerts', () => {
  beforeEach(() => {
    mocks.read.mockReset();
    mocks.read.mockResolvedValue({ alerts: [] });
  });

  it('owns a single heading, shows a quiet empty state, and allows retry after failure', async () => {
    render(<SecurityAlerts caseId="case" />);
    expect(screen.getByRole('status')).toHaveTextContent('資安提醒載入中…');
    expect(await screen.findByText('目前沒有需要處理的資安提醒。')).toBeVisible();
    expect(screen.getAllByRole('heading', { name: /資安提醒/ })).toHaveLength(1);

    mocks.read.mockRejectedValueOnce(new Error('offline'));
    render(<SecurityAlerts caseId="case-2" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('資安提醒暫時無法載入');
    expect(screen.getByRole('button', { name: '重新載入' })).toBeVisible();
  });

  it('shows applicant labels instead of raw alert enums', async () => {
    mocks.read.mockResolvedValue({ alerts: [{ id: 'alert', status: 'open', severity: 'high', summary: '影片工具分享連結事件', guidance: '請把雲端資料夾改為限定成員。', createdAt: '2026-09-01T00:00:00.000Z', resolvedAt: null }] });
    render(<SecurityAlerts caseId="case" />);

    expect(await screen.findByRole('heading', { name: '影片工具分享連結事件' })).toBeVisible();
    expect(screen.getByText('待處理')).toBeVisible();
    expect(screen.getByText('高風險')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bopen\b|\bhigh\b/);
  });
});
