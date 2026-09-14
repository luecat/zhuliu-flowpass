import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecurityAlertPublisher, type AdminRequest } from './security-alert-publisher';

describe('SecurityAlertPublisher', () => {
  it('walks create → preview → confirm publish with readable match basis', async () => {
    const requestMock = vi.fn(async (url: string) => {
      if (url === '/admin/v1/tools') {
        return { tools: [{ id: 'tool-1', vendor: 'OpenAI', canonicalName: 'ChatGPT', status: 'active' }] };
      }
      if (url === '/admin/v1/incidents') return { id: 'incident-1' };
      if (url === '/admin/v1/incidents/incident-1/preview-matches') {
        return {
          candidates: [{
            matchId: 'match-1',
            caseId: 'case-1',
            passportVersionId: 'version-1',
            basis: ['tool_and_version', 'usage_within_window'],
          }],
        };
      }
      if (url === '/admin/v1/incidents/incident-1/confirm-alerts') {
        return { alerts: [{ id: 'alert-1' }], notificationJobIds: ['job-1'] };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const request = requestMock as unknown as AdminRequest;

    render(<SecurityAlertPublisher request={request} onBack={vi.fn()} />);
    expect(await screen.findByText('系統如何預覽相符案件')).toBeVisible();
    expect(await screen.findByDisplayValue(/ChatGPT/)).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: '事件標題' }), { target: { value: 'ChatGPT 安全更新' } });
    fireEvent.change(screen.getByRole('textbox', { name: '官方公告網址（HTTPS）' }), { target: { value: 'https://status.example/advisory' } });
    fireEvent.change(screen.getByRole('textbox', { name: '公告名稱' }), { target: { value: '官方公告' } });

    fireEvent.click(screen.getByRole('button', { name: '公告發布時間' }));
    const dialog = await screen.findByRole('dialog', { name: '公告發布時間' });
    const day = within(dialog).getAllByRole('button').find((button) => button.textContent === '15');
    expect(day).toBeTruthy();
    fireEvent.click(day!);
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));

    fireEvent.change(screen.getByRole('textbox', { name: '內部審核備註（僅後台可見）' }), { target: { value: '版本受到影響。' } });
    fireEvent.change(screen.getByRole('textbox', { name: '給申請人的處理指引' }), { target: { value: '請先更新至安全版本。' } });
    fireEvent.click(screen.getByRole('button', { name: '建立事件並比對案件' }));

    expect(await screen.findByRole('heading', { name: '確認受影響案件' })).toBeVisible();
    expect(screen.getByText('案件 case-1')).toBeVisible();
    expect(screen.getByText('工具名稱與版本相符')).toBeVisible();
    expect(screen.getByText('使用時間落在影響區間')).toBeVisible();
    expect(screen.getByRole('button', { name: /發布 1 筆資安提醒/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /我已確認比對結果/ }));
    fireEvent.click(screen.getByRole('button', { name: /發布 1 筆資安提醒/ }));

    await waitFor(() => expect(requestMock).toHaveBeenCalledWith(
      '/admin/v1/incidents/incident-1/confirm-alerts',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByRole('heading', { name: '已完成發布' })).toBeVisible();
  });
});
