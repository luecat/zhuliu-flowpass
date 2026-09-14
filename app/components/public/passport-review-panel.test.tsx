import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPassportJson } from '../../../server/domain/passport-validation';
import { PublicApiError } from '../../lib/public-api';
import { FLOWPASS_SAMPLE } from '../../passport-sample';
import { PassportReviewPanel } from './passport-review-panel';

const apiMocks = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return {
    ...actual,
    PublicApiClient: class {
      read = apiMocks.read;
      mutate = apiMocks.mutate;
    },
  };
});

vi.mock('./document-review', () => ({
  DocumentReview: ({ onSubmit, submitting }: { onSubmit?: () => void; submitting?: boolean }) => <section aria-label="附件測試介面"><button type="button" onClick={onSubmit} disabled={submitting}>測試送出申請</button></section>,
}));

const CASE_ID = 'case-1';
const QUESTION_PROMPT = '請補充使用的 AI 工具';
const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;

const passportData = {
  version: { id: 'passport-version-1', versionNo: 1, workflowState: 'follow_up_required' },
  passport,
  followUps: [{
    id: 'question-1',
    questionKey: 'tool',
    passportVersionId: 'passport-version-1',
    versionNo: 1,
    prompt: QUESTION_PROMPT,
    reason: '用來整理資料流向',
    answerSchema: { type: 'text', maxLength: 100 },
    required: true,
    relatedNodeIds: [],
    priority: 'high' as const,
    status: 'open' as const,
  }],
  etag: '"1"',
};

const readyPassportData = {
  ...passportData,
  version: { id: 'passport-version-1', versionNo: 1, workflowState: 'needs_applicant_confirmation' },
  followUps: [],
};

const confirmedPassportData = {
  ...readyPassportData,
  version: { id: 'passport-version-confirmed', versionNo: 1, workflowState: 'confirmed' },
};

function installApi(jobResponse: (path: string, call: number) => unknown | Promise<unknown>) {
  let jobReadCount = 0;
  let passportLoadCount = 0;
  apiMocks.read.mockImplementation(async (path: string) => {
    if (path === `/api/v1/cases/${CASE_ID}/passport`) {
      passportLoadCount += 1;
      return passportData;
    }
    if (path === `/api/v1/cases/${CASE_ID}`) return { rowVersion: 2 };
    if (path.startsWith('/api/v1/jobs/')) {
      jobReadCount += 1;
      return jobResponse(path, jobReadCount);
    }
    throw new Error(`unexpected read: ${path}`);
  });
  apiMocks.mutate.mockImplementation(async (path: string, init?: { body?: { retry?: boolean; operation?: string } }) => {
    if (path === `/api/v1/cases/${CASE_ID}/confirmations`) {
      return { passportVersionId: 'passport-version-1', workflowState: 'follow_up_required' };
    }
    if (path === `/api/v1/cases/${CASE_ID}/ai-drafts`) {
      return { jobId: init?.body?.retry ? 'retry-job' : 'revision-job', state: 'queued' };
    }
    throw new Error(`unexpected mutation: ${path}`);
  });
  return {
    jobReads: () => jobReadCount,
    passportLoads: () => passportLoadCount,
  };
}

async function renderLoadedPanel() {
  render(<PassportReviewPanel caseId={CASE_ID} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('button', { name: '儲存答案' })).toBeInTheDocument();
}

async function submitFollowUp(regenerate = true) {
  fireEvent.change(screen.getByLabelText('使用哪個 AI 工具？'), { target: { value: 'LM Studio' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: regenerate ? '重新產生護照' : '儲存答案' }));
    await Promise.resolve();
  });
}

describe('PassportReviewPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    window.history.replaceState(null, '', '/app/apply');
    apiMocks.read.mockReset();
    apiMocks.mutate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden without a case identifier and does not submit data', () => {
    render(<PassportReviewPanel />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '送出申請' })).not.toBeInTheDocument();
  });

  it('waits for passport-ready before loading a newly queued case', async () => {
    const counters = installApi(() => ({ state: 'queued' }));
    render(<PassportReviewPanel />);
    window.history.replaceState(null, '', `/app/apply?caseId=${CASE_ID}`);

    await act(async () => { window.dispatchEvent(new CustomEvent('flowpass-case-ready', { detail: { caseId: CASE_ID } })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(counters.passportLoads()).toBe(0);

    await act(async () => { window.dispatchEvent(new CustomEvent('flowpass-passport-ready')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(counters.passportLoads()).toBe(1);
    expect(screen.getByRole('button', { name: '儲存答案' })).toBeInTheDocument();
  });

  it('shows real waiting phases, polls every 5 seconds, and keeps waiting while active', async () => {
    const counters = installApi((_path, call) => ({ state: call % 2 === 0 ? 'leased' : 'queued' }));
    await renderLoadedPanel();
    await submitFollowUp();

    expect(screen.getByRole('status')).toHaveTextContent(/排隊中|整理中|已送出/);
    expect(screen.queryByRole('button', { name: '儲存答案' })).not.toBeInTheDocument();
    expect(counters.jobReads()).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(counters.jobReads()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
    expect(screen.getByRole('status')).toHaveTextContent(/仍在處理中|整理中|排隊中/);
    expect(counters.jobReads()).toBeGreaterThan(1);
  });

  it('loads the new passport when a later poll reports completion', async () => {
    const counters = installApi((_path, call) => ({ state: call === 1 ? 'leased' : 'completed' }));
    await renderLoadedPanel();
    await submitFollowUp();

    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });

    expect(counters.jobReads()).toBe(2);
    expect(counters.passportLoads()).toBe(2);
    expect(screen.queryByText('排隊中')).not.toBeInTheDocument();
    expect(screen.queryByText('整理中')).not.toBeInTheDocument();
  });

  it.each([
    ['failed_terminal', () => ({ state: 'failed_terminal' })],
    ['a missing job', () => { throw new PublicApiError({ code: 'NOT_FOUND', message: 'missing', status: 404 }); }],
    ['an unexpected state', () => ({ state: 'cancelled' })],
  ])('shows a retryable failure for %s', async (_label, response) => {
    installApi(() => response());
    await renderLoadedPanel();
    await submitFollowUp();

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(screen.getByText('處理失敗，請稍後再試。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新整理' })).toBeEnabled();
    expect(screen.queryByText('排隊中')).not.toBeInTheDocument();
    expect(screen.queryByText('整理中')).not.toBeInTheDocument();
  });

  it('retries the saved answers through the revise job without resubmitting confirmations', async () => {
    installApi((path) => ({ state: path.endsWith('/revision-job') ? 'failed_terminal' : 'completed' }));
    await renderLoadedPanel();
    await submitFollowUp();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
      await Promise.resolve();
    });

    expect(apiMocks.mutate).toHaveBeenCalledWith(
      `/api/v1/cases/${CASE_ID}/ai-drafts`,
      expect.objectContaining({ body: { operation: 'revise', retry: true } }),
    );
    expect(apiMocks.mutate.mock.calls.filter(([path]) => String(path).endsWith('/confirmations'))).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/排隊中|已送出|整理中/);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(screen.queryByText('處理失敗，請稍後再試。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新整理' })).not.toBeInTheDocument();
  });

  it('opens attachments after confirmation and submits only from the second stage', async () => {
    let passportReads = 0;
    apiMocks.read.mockImplementation(async (path: string) => {
      if (path === `/api/v1/cases/${CASE_ID}`) return { state: 'draft', rowVersion: 4 };
      if (path === `/api/v1/cases/${CASE_ID}/passport`) return passportReads++ === 0 ? readyPassportData : confirmedPassportData;
      throw new Error(`unexpected read: ${path}`);
    });
    apiMocks.mutate.mockImplementation(async (path: string) => {
      if (path === `/api/v1/cases/${CASE_ID}/confirmations`) return { passportVersionId: 'passport-version-confirmed' };
      if (path === `/api/v1/cases/${CASE_ID}/submission`) return { case: { state: 'submitted' } };
      throw new Error(`unexpected mutation: ${path}`);
    });

    render(<PassportReviewPanel caseId={CASE_ID} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: '確認無誤，前往附件' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(apiMocks.mutate).toHaveBeenNthCalledWith(1,
      `/api/v1/cases/${CASE_ID}/confirmations`,
      expect.objectContaining({ body: expect.objectContaining({ passportVersionId: 'passport-version-1' }) }),
    );
    expect(apiMocks.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: '申請內容已完成' })).toBeVisible();
    expect(screen.getByRole('region', { name: '附件測試介面' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '測試送出申請' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(apiMocks.mutate).toHaveBeenNthCalledWith(2,
      `/api/v1/cases/${CASE_ID}/submission`,
      expect.objectContaining({ ifMatch: '"4"', body: { passportVersionId: 'passport-version-confirmed' } }),
    );
    expect(screen.getByRole('heading', { name: '申請已送出' })).toBeVisible();
    expect(screen.getByText(/請至 LINE 選單的「進度查詢」/)).toBeVisible();
    expect(screen.queryByRole('link', { name: '查看申請進度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '測試送出申請' })).not.toBeInTheDocument();
  });

  it('recovers as submitted when the server committed but the browser missed the response', async () => {
    let caseReads = 0;
    let passportReads = 0;
    apiMocks.read.mockImplementation(async (path: string) => {
      if (path === `/api/v1/cases/${CASE_ID}`) {
        caseReads += 1;
        return caseReads < 4 ? { state: 'draft', rowVersion: 4 } : { state: 'submitted', rowVersion: 5 };
      }
      if (path === `/api/v1/cases/${CASE_ID}/passport`) return passportReads++ === 0 ? readyPassportData : confirmedPassportData;
      throw new Error(`unexpected read: ${path}`);
    });
    apiMocks.mutate.mockImplementation(async (path: string) => {
      if (path === `/api/v1/cases/${CASE_ID}/confirmations`) return { passportVersionId: 'passport-version-confirmed' };
      if (path === `/api/v1/cases/${CASE_ID}/submission`) throw new TypeError('network response lost');
      throw new Error(`unexpected mutation: ${path}`);
    });

    render(<PassportReviewPanel caseId={CASE_ID} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: '確認無誤，前往附件' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: '測試送出申請' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByRole('heading', { name: '申請已送出' })).toBeVisible();
    expect(screen.queryByText('送出失敗，請稍後再試。')).not.toBeInTheDocument();
  });
});
