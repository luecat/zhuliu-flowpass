import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CASE_ID = '0198f0a0-0000-7000-8000-000000000005';
const DOCUMENT_ID = '0198f0a0-0000-7000-8000-000000000006';
const CASE_CODE = 'FP-20260901-5822D6B0';

type ListedCase = {
  id: string;
  case_code: string;
  state: string;
  submitted_at: string;
  updated_at: string;
  row_version: number;
  approved_amount_twd?: number;
};

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubAdmin(cases: ListedCase[]) {
  const reviewBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://127.0.0.1:38101').pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/admin/v1/session') return json({ authenticated: true, displayName: '管理員', mustChangePassword: false });
    if (path === '/admin/v1/cases' && method === 'GET') return json({ cases });
    if (path.startsWith('/admin/v1/cases/') && path.endsWith('/documents')) return json({ documents: [] });
    if (path.startsWith('/admin/v1/cases/') && path.endsWith('/review') && method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      reviewBodies.push(body);
      const source = cases.find((item) => path.includes(item.id)) ?? cases[0];
      return json({ case: { ...source, state: body.toState, row_version: source.row_version + 1 } });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { reviewBodies };
}

async function mountAdmin() {
  document.body.innerHTML = '<div id="root"></div>';
  await import('./main');
}

describe('FlowPass admin attachment panel', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads and renders the selected case attachments with a safe content link', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://127.0.0.1:38101').pathname;
      if (path === '/admin/v1/session') return json({ authenticated: true, displayName: '管理員', mustChangePassword: false });
      if (path === '/admin/v1/cases') return json({ cases: [{ id: CASE_ID, case_code: CASE_CODE, state: 'under_review', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }] });
      if (path === `/admin/v1/cases/${CASE_ID}/documents`) return json({ documents: [{ id: DOCUMENT_ID, kind: 'invoice', requirementKey: 'purchase_proof', mediaType: 'application/pdf', byteSize: 161769, originalName: '九月發票.pdf', status: 'ready', createdAt: '2026-09-01T00:54:00.000Z', rowVersion: 2 }] });
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main');
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));

    expect(await screen.findByRole('heading', { name: '附件（1）' })).toBeInTheDocument();
    expect(screen.getByText('九月發票.pdf')).toBeInTheDocument();
    expect(screen.getByText(/158 KB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '開啟附件 九月發票.pdf' })).toHaveAttribute(
      'href',
      `/admin/v1/documents/${DOCUMENT_ID}/content`,
    );
  });
});

describe('FlowPass admin review actions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows only legal actions for the selected case state', async () => {
    const closedId = '0198f0a0-0000-7000-8000-000000000007';
    const closedCode = 'FP-20260901-CLOSED00';
    stubAdmin([
      { id: CASE_ID, case_code: CASE_CODE, state: 'under_review', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 },
      { id: closedId, case_code: closedCode, state: 'closed', submitted_at: '2026-08-31T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 7 },
    ]);
    await mountAdmin();

    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    const select = await screen.findByRole('combobox', { name: '審核動作' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '請選擇處理方式',
      '要求補件',
      '退回修正',
      '核准',
      '駁回',
    ]);
    expect(screen.queryByRole('option', { name: '開始審核' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog', { name: CASE_CODE })).getByRole('button', { name: '關閉案件詳情' }));

    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${closedCode}` }));
    expect(await screen.findByText('這個狀態目前沒有可執行的審核動作。')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '審核動作' })).not.toBeInTheDocument();
  });

  it('uses action-specific required fields, guidance, and CTA labels', async () => {
    stubAdmin([{ id: CASE_ID, case_code: CASE_CODE, state: 'under_review', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }]);
    await mountAdmin();
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    const select = await screen.findByRole('combobox', { name: '審核動作' });

    fireEvent.change(select, { target: { value: 'request_documents' } });
    expect(screen.getByRole('textbox', { name: '補件項目（必填）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '給申請人的補件說明（必填）' })).toBeInTheDocument();
    expect(screen.getByText('尚需填寫：補件項目、給申請人的補件說明')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送出補件要求' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /我確認要執行/ })).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'return_correction' } });
    expect(screen.getByRole('textbox', { name: '需修正項目（必填）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '給申請人的修正說明（必填）' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '修正後請申請人重新確認申請內容' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退回申請人修正' })).toBeDisabled();

    fireEvent.change(select, { target: { value: 'approve' } });
    expect(screen.getByRole('spinbutton', { name: '核准金額（新台幣，必填）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '核准說明（必填）' })).toBeInTheDocument();
    expect(screen.getByText('原因會被申請者看到')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '核准案件' })).toBeDisabled();

    fireEvent.change(select, { target: { value: 'reject' } });
    expect(screen.getByRole('textbox', { name: '駁回原因（必填）' })).toBeInTheDocument();
    expect(screen.getByText('原因會被申請者看到')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '駁回案件' })).toBeDisabled();
  });

  it('starts review without requiring an applicant-visible reason', async () => {
    const { reviewBodies } = stubAdmin([{ id: CASE_ID, case_code: CASE_CODE, state: 'submitted', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }]);
    await mountAdmin();
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    fireEvent.change(await screen.findByRole('combobox', { name: '審核動作' }), { target: { value: 'start_review' } });
    expect(screen.queryByRole('textbox', { name: '原因（必填）' })).not.toBeInTheDocument();
    expect(screen.queryByText('原因會被申請者看到')).not.toBeInTheDocument();
    const start = screen.getByRole('button', { name: '開始審核' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(reviewBodies).toHaveLength(1));
    expect(reviewBodies[0]).toMatchObject({ action: 'start_review', toState: 'under_review', reason: '開始審查' });
  });

  it('confirms a complete supplement request before sending the backend contract', async () => {
    const { reviewBodies } = stubAdmin([{ id: CASE_ID, case_code: CASE_CODE, state: 'under_review', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }]);
    await mountAdmin();
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    fireEvent.change(await screen.findByRole('combobox', { name: '審核動作' }), { target: { value: 'request_documents' } });
    fireEvent.change(screen.getByRole('textbox', { name: '補件項目（必填）' }), { target: { value: '九月發票' } });
    fireEvent.change(screen.getByRole('textbox', { name: '給申請人的補件說明（必填）' }), { target: { value: '請補上完整、可清楚辨識的發票影像。' } });

    const openConfirmation = screen.getByRole('button', { name: '送出補件要求' });
    expect(openConfirmation).toBeEnabled();
    fireEvent.click(openConfirmation);
    const dialog = await screen.findByRole('dialog', { name: '確認送出補件要求' });
    expect(within(dialog).getByText('九月發票')).toBeInTheDocument();
    expect(within(dialog).getByText('請補上完整、可清楚辨識的發票影像。')).toBeInTheDocument();
    expect(reviewBodies).toHaveLength(0);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '確認送出補件要求' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(openConfirmation);

    fireEvent.click(openConfirmation);
    const reopenedDialog = await screen.findByRole('dialog', { name: '確認送出補件要求' });

    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '返回修改' }));
    expect(screen.queryByRole('dialog', { name: '確認送出補件要求' })).not.toBeInTheDocument();
    expect(reviewBodies).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '送出補件要求' }));
    fireEvent.click(await screen.findByRole('button', { name: '確認送出補件要求' }));
    await waitFor(() => expect(reviewBodies).toHaveLength(1));
    expect(reviewBodies[0]).toEqual({
      action: 'request_documents',
      toState: 'awaiting_documents',
      reason: '請補上完整、可清楚辨識的發票影像。',
      title: '九月發票',
      instructions: '請補上完整、可清楚辨識的發票影像。',
    });
  });

  it('shows the passport reconfirmation consequence in the return-correction summary', async () => {
    stubAdmin([{ id: CASE_ID, case_code: CASE_CODE, state: 'under_review', submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }]);
    await mountAdmin();
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    fireEvent.change(await screen.findByRole('combobox', { name: '審核動作' }), { target: { value: 'return_correction' } });
    fireEvent.change(screen.getByRole('textbox', { name: '需修正項目（必填）' }), { target: { value: '申請內容' } });
    fireEvent.change(screen.getByRole('textbox', { name: '給申請人的修正說明（必填）' }), { target: { value: '請補充具體用途。' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '修正後請申請人重新確認申請內容' }));
    fireEvent.click(screen.getByRole('button', { name: '退回申請人修正' }));

    const dialog = await screen.findByRole('dialog', { name: '確認退回申請人修正' });
    expect(within(dialog).getByText('申請人需重新確認')).toBeInTheDocument();
    expect(within(dialog).getByText('是')).toBeInTheDocument();
  });

  it('prefills the transfer amount from approval and sends the confirmed actual amount', async () => {
    const { reviewBodies } = stubAdmin([{ id: CASE_ID, case_code: CASE_CODE, state: 'awaiting_disbursement', approved_amount_twd: 2000, submitted_at: '2026-09-01T00:53:00.000Z', updated_at: '2026-09-01T00:59:00.000Z', row_version: 15 }]);
    await mountAdmin();
    fireEvent.click(await screen.findByRole('button', { name: `開啟案件 ${CASE_CODE}` }));
    fireEvent.change(await screen.findByRole('combobox', { name: '審核動作' }), { target: { value: 'disburse' } });

    const amount = screen.getByRole('spinbutton', { name: '匯款金額（新台幣，必填）' });
    expect(amount).toHaveValue(2000);
    fireEvent.change(amount, { target: { value: '1850' } });
    fireEvent.change(screen.getByRole('textbox', { name: '撥款紀錄（必填）' }), { target: { value: '已於今日完成轉帳。' } });
    fireEvent.click(screen.getByRole('button', { name: '確認已撥款' }));

    const dialog = await screen.findByRole('dialog', { name: '確認確認已撥款' });
    expect(within(dialog).getByText('匯款金額')).toBeInTheDocument();
    expect(within(dialog).getByText('$1,850')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '確認確認已撥款' }));
    await waitFor(() => expect(reviewBodies).toHaveLength(1));
    expect(reviewBodies[0]).toEqual({
      action: 'disburse',
      toState: 'disbursed',
      reason: '已於今日完成轉帳。',
      disbursedAmountTwd: 1850,
    });
  });
});
