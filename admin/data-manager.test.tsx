import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminPassportDataSnapshot, PurgePreview } from '../shared/admin-data-management-contract';
import { DataManager } from './data-manager';

const snapshot: AdminPassportDataSnapshot = {
  caseId: 'case-1', caseCode: 'FP-20260901-001', state: 'under_review', stateLabel: '審查中', applicantLabel: '王小竹', updatedAt: '2026-09-01T08:00:00.000Z', requiresAiRefresh: false,
  groups: [{ key: 'case', label: '案件與申請人答案', records: [{ resource: 'answer_versions', table: 'answer_versions', id: 'answer-1', rowVersion: 3, kind: 'history', title: '申請答案 第 1 版', fields: [{ key: 'material', label: '會使用的資料', type: 'text', value: '照片', editable: true, storage: { encrypted: true } }] }] }],
};

describe('DataManager', () => {
  it('shows readable data and overwrites an editable field', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { rowVersion: 4, requiresAiRefresh: true, recalculated: [] };
      return snapshot;
    });
    render(<DataManager caseId="case-1" caseCode={snapshot.caseCode} request={request as never} onBack={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText('會使用的資料')).toBeInTheDocument();
    expect(screen.getByText('照片')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '編輯' }));
    const input = screen.getByLabelText('會使用的資料');
    await userEvent.clear(input); await userEvent.type(input, '產品文件');
    await userEvent.click(screen.getByRole('button', { name: '確認覆寫' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/admin/v1/data/passports/case-1/fields', expect.objectContaining({ method: 'PATCH' })));
    const patch = JSON.parse(String((request.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1] as RequestInit).body));
    expect(patch).toMatchObject({ resource: 'answer_versions', recordId: 'answer-1', field: 'material', value: '產品文件', expectedRowVersion: 3 });
  });

  it('requires exact case code and password before permanent purge', async () => {
    const preview: PurgePreview = { caseId: 'case-1', caseCode: snapshot.caseCode, passportId: 'passport-1', applicantLabel: '王小竹', preservedSiblingCases: 2, tables: [{ table: 'cases', count: 1, ids: ['case-1'] }], attachments: [], attachmentBytes: 0, backups: [], previewHash: 'preview-hash', generatedAt: '2026-09-01T08:00:00.000Z' };
    const deleted = vi.fn();
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/purge-preview')) return preview;
      if (url.endsWith('/purge-authorizations')) return { token: 'one-use-token', expiresAt: '2026-09-01T08:05:00.000Z' };
      if (url.endsWith('/purge')) return { caseCode: snapshot.caseCode, removedRows: 1, removedAttachments: 0, removedBackups: 0, completedAt: '2026-09-01T08:01:00.000Z' };
      return snapshot;
    });
    render(<DataManager caseId="case-1" caseCode={snapshot.caseCode} request={request as never} onBack={() => {}} onDeleted={deleted} />);
    await userEvent.click(await screen.findByRole('button', { name: '永久刪除這本護照' }));
    expect(await screen.findByText('保留的其他護照')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '永久刪除全部相關資料' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(`輸入案件編號「${snapshot.caseCode}」`), snapshot.caseCode);
    await userEvent.type(screen.getByLabelText('管理員密碼'), 'correct-password');
    expect(submit).toBeEnabled(); await userEvent.click(submit);
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(expect.objectContaining({ caseCode: snapshot.caseCode })));
  });
});
