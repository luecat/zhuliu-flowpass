import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CorrectionPanel } from './correction-panel';

const api = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('../../lib/public-api', () => ({
  PublicApiClient: class {
    read = api.read;
    mutate = api.mutate;
  },
  PublicApiError: class PublicApiError extends Error {
    code: string;
    constructor(input: { code: string; message: string }) {
      super(input.message);
      this.code = input.code;
    }
  },
}));

describe('CorrectionPanel', () => {
  beforeEach(() => {
    api.read.mockReset();
    api.mutate.mockReset();
  });

  it('shows correction instructions without upload controls and completes revise_passport', async () => {
    api.read.mockImplementation(async (path: string) => {
      if (path === '/api/v1/tasks?caseId=case-1') {
        return {
          tasks: [{
            id: 'task-1',
            taskType: 'revise_passport',
            title: '修正用途說明',
            instructions: '請把用途改成實際工作流程。',
            dueAt: null,
            createdAt: '2026-09-01T04:00:00.000Z',
            rowVersion: 1,
          }],
        };
      }
      throw new Error(path);
    });
    api.mutate.mockResolvedValue({});
    const onCompleted = vi.fn();

    render(<CorrectionPanel caseId="case-1" onCompleted={onCompleted} />);

    expect(await screen.findByRole('heading', { name: '請修正申請資料' })).toBeVisible();
    expect(screen.getByText('請把用途改成實際工作流程。')).toBeVisible();
    expect(screen.queryByRole('button', { name: /選擇檔案|重新上傳/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/選擇檔案/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往修改申請內容' })).toHaveAttribute('href', '/app/apply?caseId=case-1');

    fireEvent.click(screen.getByRole('checkbox', { name: /我已依說明完成修正/ }));
    fireEvent.click(screen.getByRole('button', { name: '送出修正' }));

    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith(
      '/api/v1/tasks/task-1/complete',
      expect.objectContaining({ body: { action: 'revise_passport' } }),
    ));
    expect(onCompleted).toHaveBeenCalled();
  });
});
