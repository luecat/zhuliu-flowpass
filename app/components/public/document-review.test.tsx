import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseDetails } from '../../../shared/purchase-details-contract';
import { DocumentReview } from './document-review';

const CASE_ID = '0198f090-0000-7000-8000-000000000001';
const apiMocks = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), upload: vi.fn(), readWithMeta: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = apiMocks.read; mutate = apiMocks.mutate; upload = apiMocks.upload; readWithMeta = apiMocks.readWithMeta; } };
});

const details: PurchaseDetails = {
  billingCycle: 'annual', billingPeriods: null, softwareFunction: 'imaging', otherFunction: null,
  softwareName: '修圖工具', companyName: 'Example Inc.', purchaseDate: '2026-08-30',
  payerType: 'self_card', originalCurrency: 'TWD', otherCurrency: null,
  originalExpense: '1200', convertedTwd: 1200, specialStatus: false, invoiceNumber: null,
  paymentSourceFingerprint: null, subscriptionStartDate: '2026-08-01', subscriptionEndDate: '2027-07-31',
  applicantName: '測試申請人', receiptBuyerName: '測試申請人', birthDate: null,
};

type PublicDetails = Omit<PurchaseDetails, 'paymentSourceFingerprint'> & { paymentSourceRegistered: boolean };

function toPublic(saved: PurchaseDetails | null): PublicDetails | null {
  if (!saved) return null;
  const { paymentSourceFingerprint, ...rest } = saved;
  return { ...rest, paymentSourceRegistered: Boolean(paymentSourceFingerprint) };
}

function installApi(saved: PurchaseDetails | null = null, options: { ocr?: { lines: Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }> } | null } = {}) {
  apiMocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith('/purchase-details')) return { details: toPublic(saved) };
    if (path.endsWith('/documents')) return { documents: [] };
    if (path === `/api/v1/cases/${CASE_ID}`) return { rowVersion: 3, state: 'draft' };
    if (path.includes('/ocr')) return { ocr: options.ocr === undefined ? null : options.ocr };
    throw new Error(`unexpected read: ${path}`);
  });
  apiMocks.readWithMeta.mockResolvedValue({ data: { rowVersion: 3, state: 'draft' }, etag: '"3"' });
  apiMocks.mutate.mockResolvedValue({ details: toPublic(saved ?? details) });
  apiMocks.upload.mockResolvedValue({ document: { id: 'document-1' } });
}

function fileInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

function ocrReads(): string[] {
  return apiMocks.read.mock.calls.map(([path]) => String(path)).filter((path) => path.includes('/ocr'));
}

describe('DocumentReview', () => {
  beforeEach(() => {
    apiMocks.read.mockReset(); apiMocks.mutate.mockReset(); apiMocks.upload.mockReset(); apiMocks.readWithMeta.mockReset();
  });

  it('shows a guided purchase-details and attachment checklist', async () => {
    installApi();
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByRole('heading', { name: '購買資料與附件' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '填寫購買資料' })).toBeInTheDocument();
    expect(screen.getByText('申請人姓名', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '1. 購買資料' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/信用卡資訊用途/)).toBeInTheDocument();
    expect(screen.getByText('具低收／中低收入戶資格')).toBeInTheDocument();
    expect(screen.queryByText('文化語言保存者')).not.toBeInTheDocument();
    expect(screen.queryByText(/OCR/i)).not.toBeInTheDocument();
  });

  it('prefills the approved tool and company selected during follow-up', async () => {
    installApi();
    render(<DocumentReview
      suppliedCaseId={CASE_ID}
      prefilledTool={{ id: 'chatgpt', label: 'ChatGPT', company: 'OpenAI', category: 'chat_search' }}
    />);

    await screen.findByRole('heading', { name: '填寫購買資料' });
    expect(screen.getByRole('combobox', { name: '軟體名稱 ＊' })).toHaveValue('ChatGPT');
    expect(screen.getByLabelText('軟體公司名稱 ＊')).toHaveValue('OpenAI');
  });

  it('adds only the conditional proof files selected by the applicant', async () => {
    installApi({ ...details, payerType: 'representative', specialStatus: true });
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByText('資格證明')).toBeInTheDocument();
    expect(screen.getByText('代付切結書')).toBeInTheDocument();
    expect(screen.getByText('0 / 8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送出申請' })).toBeDisabled();
  });

  it('labels a vendor receipt upload with its document requirement', async () => {
    installApi(details);
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '上傳必備文件' });
    expect(screen.getByText(/不支援 HEIC/)).toBeInTheDocument();
    fireEvent.change(fileInputs(container)[2], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalled());
    expect(apiMocks.upload).toHaveBeenCalledWith(
      `/api/v1/cases/${CASE_ID}/documents`,
      expect.objectContaining({ kind: 'invoice', requirementKey: 'vendor_receipt' }),
    );
  });

  it('reads OCR after a vendor receipt upload and shows 套用 when lines match purchase fields', async () => {
    installApi(details, {
      ocr: {
        lines: [
          { text: 'Invoice number KS98K7HU-0002', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } },
          { text: '2026-06-11', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      },
    });
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '上傳必備文件' });
    fireEvent.change(fileInputs(container)[2], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(ocrReads()).toEqual([`/api/v1/documents/document-1/ocr`]));
    expect(await screen.findByLabelText('官方收據辨識結果')).toBeInTheDocument();
    expect(screen.getByText('發票號碼：KS98K7HU-0002')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '套用' }).length).toBeGreaterThan(0);
  });

  it('does not call OCR after an identity upload', async () => {
    installApi(details);
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '上傳必備文件' });
    fireEvent.change(fileInputs(container)[0], { target: { files: [new File(['id'], 'id.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByText(/身分證正面已上傳/)).toBeInTheDocument());
    expect(ocrReads()).toEqual([]);
  });

  it('keeps the upload when OCR returns nothing', async () => {
    installApi(details, { ocr: null });
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '上傳必備文件' });
    fireEvent.change(fileInputs(container)[2], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(ocrReads()).toEqual([`/api/v1/documents/document-1/ocr`]));
    expect(screen.getByText(/官方收據已上傳/)).toBeInTheDocument();
    expect(screen.queryByLabelText('官方收據辨識結果')).not.toBeInTheDocument();
  });
});
