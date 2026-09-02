import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplementPanel } from './supplement-panel';

const api = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  upload: vi.fn(),
  readWithMeta: vi.fn(),
}));

vi.mock('../../lib/public-api', () => ({
  PublicApiClient: class {
    read = api.read;
    mutate = api.mutate;
    upload = api.upload;
    readWithMeta = api.readWithMeta;
  },
  PublicApiError: class extends Error {
    code = '';
  },
}));

describe('SupplementPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let uploaded = false;
    api.read.mockImplementation(async (path: string) => {
      if (path === '/api/v1/tasks?caseId=case-1') return { tasks: [{ id: 'task-1', taskType: 'provide_document', title: '補上完整發票', instructions: '請上傳包含購買日期與金額的完整發票。', acceptedDocumentTypes: ['invoice'], dueAt: '2026-09-08T04:00:00.000Z', createdAt: '2026-09-01T04:00:00.000Z', rowVersion: 1 }] };
      if (path === '/api/v1/cases/case-1/documents') return { documents: uploaded ? [{ id: 'document-1', kind: 'invoice', requirementKey: 'purchase_proof', mediaType: 'application/pdf', byteSize: 1024, status: 'ready', createdAt: '2026-09-01T05:00:00.000Z' }] : [] };
      if (path === '/api/v1/cases/case-1') return { rowVersion: 7 };
      throw new Error(`unexpected read: ${path}`);
    });
    api.readWithMeta.mockResolvedValue({ data: { rowVersion: 7 }, etag: '"7"' });
    api.upload.mockImplementation(async () => { uploaded = true; return {}; });
    api.mutate.mockResolvedValue({ status: 'completed' });
  });

  it('shows natural supplement instructions, uploads the requested file, and submits it', async () => {
    const onCompleted = vi.fn();
    render(<SupplementPanel caseId="case-1" onCompleted={onCompleted} />);

    expect(await screen.findByRole('heading', { name: '請補充資料' })).toBeVisible();
    expect(screen.getByText('補上完整發票')).toBeVisible();
    expect(screen.getByText('請上傳包含購買日期與金額的完整發票。')).toBeVisible();
    expect(screen.queryByText(/待辦|provide_document/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送出補件' })).toBeDisabled();

    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [new File(['invoice'], 'invoice.pdf', { type: 'application/pdf' })] } });

    await waitFor(() => expect(api.upload).toHaveBeenCalledWith('/api/v1/cases/case-1/documents', expect.objectContaining({ kind: 'invoice', requirementKey: 'purchase_proof', ifMatch: '"7"' })));
    await waitFor(() => expect(screen.getByRole('button', { name: '送出補件' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '送出補件' }));

    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('/api/v1/tasks/task-1/complete', { method: 'POST', ifMatch: '"1"', body: { action: 'provide_document' } }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });
});
