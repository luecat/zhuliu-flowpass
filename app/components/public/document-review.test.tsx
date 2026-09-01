import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseDetails } from '../../../shared/purchase-details-contract';
import { DocumentReview } from './document-review';

const CASE_ID = '0198f090-0000-7000-8000-000000000001';
const apiMocks = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), upload: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = apiMocks.read; mutate = apiMocks.mutate; upload = apiMocks.upload; } };
});

const details: PurchaseDetails = {
  billingCycle: 'annual', billingPeriods: null, softwareFunction: 'imaging', otherFunction: null,
  softwareName: '修圖工具', companyName: 'Example Inc.', purchaseDate: '2026-08-30',
  payerType: 'self_card', originalCurrency: 'TWD', otherCurrency: null,
  originalExpense: '1200', convertedTwd: 1200, specialStatus: false,
};

function installApi(saved: PurchaseDetails | null = null) {
  apiMocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith('/purchase-details')) return { details: saved };
    if (path.endsWith('/documents')) return { documents: [] };
    if (path === `/api/v1/cases/${CASE_ID}`) return { rowVersion: 3, state: 'draft' };
    throw new Error(`unexpected read: ${path}`);
  });
  apiMocks.mutate.mockResolvedValue({ details: saved ?? details });
  apiMocks.upload.mockResolvedValue({ document: { id: 'document-1' } });
}

describe('DocumentReview', () => {
  beforeEach(() => {
    apiMocks.read.mockReset(); apiMocks.mutate.mockReset(); apiMocks.upload.mockReset();
  });

  it('shows a guided purchase-details and attachment checklist', async () => {
    installApi();
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByRole('heading', { name: '購買資料與附件' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '填寫購買資料' })).toBeInTheDocument();
    expect(screen.getByText(/JPEG、PNG 或非加密 PDF/)).toBeInTheDocument();
    expect(screen.getByText('身分證正面')).toBeInTheDocument();
    expect(screen.getByText('身分證反面')).toBeInTheDocument();
    expect(screen.getByText('購買憑證或發票')).toBeInTheDocument();
    expect(screen.getByText('存摺封面影本')).toBeInTheDocument();
    expect(screen.getByText('切結書')).toBeInTheDocument();
    expect(screen.queryByText(/OCR/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正式送出申請' })).toBeDisabled();
  });

  it('adds only the conditional proof files selected by the applicant', async () => {
    installApi({ ...details, payerType: 'representative', specialStatus: true });
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByText('特定對象或文化語言保存者證明')).toBeInTheDocument();
    expect(screen.getByText('代付切結書')).toBeInTheDocument();
    expect(screen.getByText('0 / 7')).toBeInTheDocument();
  });

  it('labels a purchase proof upload with its document requirement', async () => {
    installApi(details);
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '上傳必要文件' });
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    const purchaseProof = inputs[2];
    fireEvent.change(purchaseProof, { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalled());
    expect(apiMocks.upload).toHaveBeenCalledWith(
      `/api/v1/cases/${CASE_ID}/documents`,
      expect.objectContaining({ kind: 'invoice', requirementKey: 'purchase_proof' }),
    );
  });
});
