import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationWizard } from './application-wizard';

const liffSession = vi.hoisted(() => ({
  value: { api: null, status: 'unavailable', message: '' } as {
    api: unknown;
    status: string;
    message: string;
  },
}));

vi.mock('./liff-session-provider', () => ({
  useLiffSession: () => liffSession.value,
}));

interface ListedCase {
  id: string;
  state: string;
  rowVersion: number;
  updatedAt: string;
}

const COMPLETE_ANSWERS = { material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊雲端' };

function useAuthenticatedApi(cases: ListedCase[], options: { answers?: typeof COMPLETE_ANSWERS | null; jobStates?: Array<string | Error> } = {}) {
  const jobStates = [...(options.jobStates ?? [])];
  const read = vi.fn(async (path: string) => {
    if (path === '/api/v1/cases') return { cases };
    if (path === '/api/v1/programs/current') return { id: 'program-current' };
    if (path.startsWith('/api/v1/jobs/')) {
      const state = jobStates.shift() ?? 'queued';
      if (state instanceof Error) throw state;
      return { state };
    }
    if (path.startsWith('/api/v1/cases/')) {
      const id = decodeURIComponent(path.slice('/api/v1/cases/'.length));
      const item = cases.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`unexpected case read: ${path}`);
      return { ...item, answers: options.answers ?? null };
    }
    throw new Error(`unexpected read: ${path}`);
  });
  const mutate = vi.fn(async (path: string) => {
    if (path === '/api/v1/cases') {
      return { case: { id: 'new-case', rowVersion: 1, updatedAt: '2026-08-31T12:00:00.000Z' } };
    }
    if (path.endsWith('/answers')) return { case: { rowVersion: 2 } };
    if (path.endsWith('/ai-drafts')) return { jobId: 'job-1', state: 'queued' };
    throw new Error(`unexpected mutation: ${path}`);
  });
  liffSession.value = { api: { read, mutate }, status: 'authenticated', message: '' };
  return { read, mutate };
}

async function startAiDraft() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  for (const [index, value] of Object.values(COMPLETE_ANSWERS).entries()) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value } });
    if (index < 3) fireEvent.click(screen.getByRole('button', { name: '下一題' }));
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  await act(async () => { await Promise.resolve(); });
}

describe('ApplicationWizard boundaries', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    liffSession.value = { api: null, status: 'unavailable', message: '' };
    window.history.replaceState(null, '', '/app/apply');
  });
  afterEach(() => vi.useRealTimers());

  it('guides four fields and presents a review before draft generation', () => {
    render(<ApplicationWizard />);
    for (const [index, value] of ['照片', '整理', '姓名', '團隊雲端'].entries()) {
      fireEvent.change(screen.getByRole('textbox'), { target: { value } });
      if (index < 3) fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    }
    fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
    expect(screen.getByRole('heading', { name: '送出前確認' })).toBeInTheDocument();
    expect(screen.getByText('送出後需回答後續問題。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    expect(screen.queryByText(/Unicode|四題合計|自述/)).not.toBeInTheDocument();
  });

  it('marks every field required and rejects Unicode scalar overflow without UTF-16 maxLength', () => {
    render(<ApplicationWizard />);
    const input = screen.getByRole('textbox');
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: '😀'.repeat(501) } });
    expect(screen.getByRole('alert')).toHaveTextContent('超過上限');
    expect(screen.getByRole('button', { name: '下一題' })).toBeDisabled();
    expect(input).not.toHaveAttribute('maxLength');
    expect(screen.getByText('必填 · 501/500')).toBeInTheDocument();
  });

  it('always starts a new application instead of resuming an old unsubmitted case', async () => {
    const { read, mutate } = useAuthenticatedApi([
      { id: 'old-unsubmitted', state: 'draft', rowVersion: 8, updatedAt: '2026-08-31T11:59:59.999Z' },
    ]);

    render(<ApplicationWizard />);

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/v1/cases', expect.objectContaining({ method: 'POST' })));
    expect(read).not.toHaveBeenCalledWith('/api/v1/cases');
    expect(read).not.toHaveBeenCalledWith('/api/v1/cases/old-unsubmitted');
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('continues the active application when the current flow supplies its case id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T12:00:00.000Z'));
    const { read, mutate } = useAuthenticatedApi([
      { id: 'expired', state: 'draft', rowVersion: 8, updatedAt: '2026-08-30T12:00:00.000Z' },
    ]);
    window.history.replaceState(null, '', '/app/apply?caseId=expired');

    render(<ApplicationWizard />);

    await waitFor(() => expect(read).toHaveBeenCalledWith('/api/v1/cases/expired'));
    expect(read).not.toHaveBeenCalledWith('/api/v1/cases');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows 0 to 99 percent progress and reads the AI job every 20 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { read } = useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: ['queued'] });
    render(<ApplicationWizard />);
    await startAiDraft();

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('思考中…');
    expect(screen.getByText('完成度 0%')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(19_000); });
    expect(screen.getByText('完成度 9%')).toBeInTheDocument();
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('完成度 10%')).toBeInTheDocument();
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(1);
  });

  it('holds at 99 percent after 200 seconds and keeps polling queued or leased jobs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { read } = useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: [...Array(9).fill('queued'), 'leased', 'queued'] });
    render(<ApplicationWizard />);
    await startAiDraft();

    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
    expect(screen.getByText('完成度 99%')).toBeInTheDocument();
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(10);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByText('完成度 99%')).toBeInTheDocument();
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(11);
  });

  it('dispatches passport ready when the job completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: ['completed'] });
    const ready = vi.fn();
    const caseReady = vi.fn();
    window.addEventListener('flowpass-passport-ready', ready, { once: true });
    window.addEventListener('flowpass-case-ready', caseReady);
    render(<ApplicationWizard />);
    await startAiDraft();

    expect(caseReady).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(caseReady).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '已完成' })).toBeDisabled();
    window.removeEventListener('flowpass-case-ready', caseReady);
  });

  it.each([
    ['failed terminal', 'failed_terminal'],
    ['unexpected state', 'cancelled'],
    ['request error', new Error('offline')],
  ])('shows the retry message for %s', async (_label, terminalState) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: [terminalState] });
    render(<ApplicationWizard />);
    await startAiDraft();

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByText('處理失敗，請重試')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });
});
