import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRequirementKey, PurchaseDetails } from '../../../shared/purchase-details-contract';
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
  applicantName: '測試申請人', receiptBuyerName: '測試申請人', receiptVendorName: null, birthDate: null,
  nationalId: 'A123456789', householdAddress: '臺北市中正區重慶南路一段122號',
};

const paidDetails: PurchaseDetails = {
  ...details,
  paymentSourceFingerprint: 'abcdefghijklmnop',
};

type PublicDetails = Omit<PurchaseDetails, 'paymentSourceFingerprint'> & { paymentSourceRegistered: boolean };

function toPublic(saved: PurchaseDetails | null): PublicDetails | null {
  if (!saved) return null;
  const { paymentSourceFingerprint, ...rest } = saved;
  return { ...rest, paymentSourceRegistered: Boolean(paymentSourceFingerprint) };
}

function readyDocument(id: string, requirementKey: DocumentRequirementKey) {
  return { id, kind: 'invoice', requirementKey, mediaType: 'image/png', byteSize: 12, status: 'ready', rowVersion: 1 };
}

function installApi(saved: PurchaseDetails | null = null, options: {
  ocr?: { lines: Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }> } | null;
  documents?: Array<ReturnType<typeof readyDocument>>;
} = {}) {
  const documents = [...(options.documents ?? [])];
  apiMocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith('/purchase-details')) return { details: toPublic(saved) };
    if (path.endsWith('/documents')) return { documents: documents.map((item) => ({ ...item })) };
    if (path === `/api/v1/cases/${CASE_ID}`) return { rowVersion: 3, state: 'draft' };
    if (path.includes('/ocr')) return { ocr: options.ocr === undefined ? null : options.ocr };
    throw new Error(`unexpected read: ${path}`);
  });
  apiMocks.readWithMeta.mockResolvedValue({ data: { rowVersion: 3, state: 'draft' }, etag: '"3"' });
  apiMocks.mutate.mockImplementation(async (_path: string, input: { body?: Record<string, unknown> }) => {
    const body = input.body ?? {};
    return {
      details: {
        ...(toPublic(saved ?? details) ?? {}),
        ...body,
        paymentSourceRegistered: Boolean(body.cardLastFour) || Boolean(saved?.paymentSourceFingerprint) || Boolean(body.keepExistingPaymentSource),
        cardLastFour: undefined,
        cardholderName: undefined,
        deferPaymentSource: undefined,
        keepExistingPaymentSource: undefined,
      },
    };
  });
  apiMocks.upload.mockImplementation(async (_path: string, input: { kind: string; requirementKey: DocumentRequirementKey }) => {
    const document = readyDocument(`document-${documents.length + 1}`, input.requirementKey);
    documents.push(document);
    return { document };
  });
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

  it('starts on the OCR upload page instead of the old typing form', async () => {
    installApi();
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByRole('heading', { name: '購買資料與附件' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '辨識購買資料' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '1. 辨識購買資料' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: /官方收據/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /刷卡單筆明細/ })).toBeInTheDocument();
    expect(screen.queryByText('繳費制度')).not.toBeInTheDocument();
    expect(screen.queryByText('軟體公司名稱')).not.toBeInTheDocument();
    expect(screen.queryByText('信用卡末四碼')).not.toBeInTheDocument();
    expect(screen.queryByText('具低收／中低收入戶資格')).not.toBeInTheDocument();
    expect(screen.queryByText('文化語言保存者')).not.toBeInTheDocument();
    expect(screen.queryByText(/OCR/i)).not.toBeInTheDocument();
    expect(screen.queryByText('身分證正面')).not.toBeInTheDocument();
  });

  it('prefills the approved tool and company selected during follow-up', async () => {
    installApi();
    render(<DocumentReview
      suppliedCaseId={CASE_ID}
      prefilledTool={{ id: 'chatgpt', label: 'ChatGPT', company: 'OpenAI', category: 'chat_search' }}
    />);

    expect(await screen.findByLabelText('已帶入的購買資料')).toBeInTheDocument();
    expect(screen.getByText('軟體名稱：ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('軟體公司名稱：OpenAI')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '軟體名稱 ＊' })).not.toBeInTheDocument();
  });

  it('adds only the conditional proof files selected by the applicant', async () => {
    installApi(
      { ...paidDetails, payerType: 'representative', specialStatus: true },
      { documents: [readyDocument('receipt-1', 'vendor_receipt'), readyDocument('card-1', 'card_transaction')] },
    );
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByText('代付切結書')).toBeInTheDocument();
    expect(screen.getByText('具低收／中低收入戶資格')).toBeInTheDocument();
    expect(screen.getAllByText('資格證明').length).toBeGreaterThan(0);
    expect(screen.getByText('0 / 6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送出申請' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: /官方收據/ })).not.toBeInTheDocument();
  });

  it('labels a vendor receipt upload with its document requirement', async () => {
    installApi();
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '辨識購買資料' });
    expect(screen.getByText(/不支援 HEIC/)).toBeInTheDocument();
    fireEvent.change(fileInputs(container)[0], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalled());
    expect(apiMocks.upload).toHaveBeenCalledWith(
      `/api/v1/cases/${CASE_ID}/documents`,
      expect.objectContaining({ kind: 'invoice', requirementKey: 'vendor_receipt' }),
    );
  });

  it('auto-fills OCR hits after a vendor receipt upload and asks for missing fields without 套用', async () => {
    installApi(null, {
      ocr: {
        lines: [
          { text: 'Invoice number KS98K7HU-0002', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } },
          { text: '2026-06-11', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      },
    });
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '辨識購買資料' });
    fireEvent.change(fileInputs(container)[0], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(ocrReads()).toContain(`/api/v1/documents/document-1/ocr`));
    expect(await screen.findByText(/已從收據／明細帶入：/)).toBeInTheDocument();
    expect(screen.getByText('發票號碼：KS98K7HU-0002')).toBeInTheDocument();
    expect(screen.getByText('購買日期：2026-06-11')).toBeInTheDocument();
    expect(await screen.findByText(/請補填辨識不到的資料/)).toBeInTheDocument();
    expect(screen.getByLabelText(/申請人姓名/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '套用' })).not.toBeInTheDocument();
    expect(screen.queryByText('信用卡末四碼')).not.toBeInTheDocument();
  });

  it('does not request identity files on the OCR page', async () => {
    installApi();
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '辨識購買資料' });
    expect(screen.queryByText('身分證正面')).not.toBeInTheDocument();
    expect(screen.queryByText('身分證反面')).not.toBeInTheDocument();
    expect(ocrReads()).toEqual([]);
  });

  it('keeps the upload when OCR returns nothing and shows the gap fields', async () => {
    installApi(null, { ocr: null });
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '辨識購買資料' });
    fireEvent.change(fileInputs(container)[0], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(ocrReads()).toContain(`/api/v1/documents/document-1/ocr`));
    expect(screen.getByText(/官方收據已上傳/)).toBeInTheDocument();
    expect(await screen.findByText(/請補填辨識不到的資料/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '套用' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('官方收據辨識結果')).not.toBeInTheDocument();
  });

  it('keeps filled purchase fields editable instead of removing them', async () => {
    installApi(null, { ocr: null });
    const { container } = render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '辨識購買資料' });
    fireEvent.change(fileInputs(container)[0], { target: { files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })] } });
    const nameInput = await screen.findByLabelText(/申請人姓名/);
    fireEvent.change(nameInput, { target: { value: '陳大文' } });
    expect(screen.getByLabelText(/申請人姓名/)).toHaveValue('陳大文');
    expect(screen.getByLabelText(/官方收據上的買受人姓名/)).toBeInTheDocument();
    expect(screen.getByText(/已帶入的欄位仍可直接修改/)).toBeInTheDocument();
  });

  it('shows payment fields only on the second step', async () => {
    installApi(details, {
      documents: [readyDocument('receipt-1', 'vendor_receipt'), readyDocument('card-1', 'card_transaction')],
    });
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    expect(await screen.findByRole('heading', { name: '付款資訊' })).toBeInTheDocument();
    expect(screen.getByText('信用卡末四碼', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/信用卡資訊用途/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /官方收據/ })).not.toBeInTheDocument();
    expect(screen.queryByText('繳費制度')).not.toBeInTheDocument();
    expect(screen.queryByText('軟體公司名稱')).not.toBeInTheDocument();
  });

  it('requires a full purchase-details save before the remaining attachments step', async () => {
    installApi(details, {
      documents: [readyDocument('receipt-1', 'vendor_receipt'), readyDocument('card-1', 'card_transaction')],
    });
    render(<DocumentReview suppliedCaseId={CASE_ID} />);
    await screen.findByRole('heading', { name: '付款資訊' });
    fireEvent.change(screen.getByPlaceholderText('例如 1234'), { target: { value: '4242' } });
    fireEvent.change(screen.getByPlaceholderText('須與卡片一致'), { target: { value: '測試持卡人' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存並前往附件' }));
    await waitFor(() => expect(apiMocks.mutate).toHaveBeenCalled());
    expect(apiMocks.mutate).toHaveBeenCalledWith(
      `/api/v1/cases/${CASE_ID}/purchase-details`,
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          cardLastFour: '4242',
          cardholderName: '測試持卡人',
          nationalId: 'A123456789',
          householdAddress: '臺北市中正區重慶南路一段122號',
        }),
      }),
    );
    const payload = apiMocks.mutate.mock.calls[0][1] as { body: { deferPaymentSource?: boolean } };
    expect(payload.body.deferPaymentSource).toBeUndefined();
    expect(await screen.findByRole('heading', { name: '上傳其餘附件' })).toBeInTheDocument();
    expect(screen.getByText('身分證正面')).toBeInTheDocument();
  });
});
