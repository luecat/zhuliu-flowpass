import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicApiError } from '../../lib/public-api';
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

const COMPLETE_ANSWERS = {
  material: '照片',
  aiPurpose: '整理',
  sensitiveData: '姓名',
  destinationAndAudience: '團隊雲端',
  requestedTool: 'ChatGPT',
  retentionDuration: '保留 30 天',
  applicantName: '',
};

function useAuthenticatedApi(cases: ListedCase[], options: { answers?: typeof COMPLETE_ANSWERS | null; jobStates?: Array<string | Error>; draftErrors?: Error[] } = {}) {
  const jobStates = [...(options.jobStates ?? [])];
  const draftErrors = [...(options.draftErrors ?? [])];
  const read = vi.fn(async (path: string) => {
    if (path === '/api/v1/cases') return { cases };
    if (path === '/api/v1/programs/current') return { id: 'program-current' };
    if (path.startsWith('/api/v1/jobs/')) {
      const state = jobStates.shift() ?? 'queued';
      if (state instanceof Error) throw state;
      return { state };
    }
    if (path.includes('/passport')) {
      throw new PublicApiError({ code: 'NOT_FOUND', message: 'missing', status: 404 });
    }
    if (path.includes('/ai-drafts')) {
      throw new PublicApiError({ code: 'NOT_FOUND', message: 'missing', status: 404 });
    }
    if (path.startsWith('/api/v1/cases/')) {
      const id = decodeURIComponent(path.slice('/api/v1/cases/'.length));
      if (id === 'new-case') {
        return { id: 'new-case', state: 'draft', rowVersion: 1, updatedAt: '2026-08-31T12:00:00.000Z', answers: options.answers ?? null };
      }
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
    if (path.endsWith('/ai-drafts')) {
      const draftError = draftErrors.shift();
      if (draftError) throw draftError;
      return { jobId: 'job-1', state: 'queued' };
    }
    throw new Error(`unexpected mutation: ${path}`);
  });
  liffSession.value = { api: { read, mutate }, status: 'authenticated', message: '' };
  return { read, mutate };
}

function selectChoice(label: string, optionLabel: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  const listbox = screen.getByRole('listbox');
  fireEvent.click(within(listbox).getByRole('button', { name: new RegExp(optionLabel) }));
}

function selectTool(optionLabel: string) {
  const input = screen.getByRole('combobox', { name: '使用的模型／工具？' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: optionLabel } });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(optionLabel) }));
}

function fillWizard(answers: typeof COMPLETE_ANSWERS = COMPLETE_ANSWERS) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: answers.material } });
  fireEvent.click(screen.getByRole('button', { name: '下一題' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: answers.aiPurpose } });
  fireEvent.click(screen.getByRole('button', { name: '下一題' }));

  selectChoice('是否包含個資或敏感資料？', answers.sensitiveData === '無' || answers.sensitiveData === '不確定' ? answers.sensitiveData : '有');
  if (answers.sensitiveData !== '無' && answers.sensitiveData !== '不確定') {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: answers.sensitiveData } });
  }
  fireEvent.click(screen.getByRole('button', { name: '下一題' }));

  fireEvent.change(screen.getByRole('textbox'), { target: { value: answers.destinationAndAudience } });
  fireEvent.click(screen.getByRole('button', { name: '下一題' }));

  selectTool(answers.requestedTool);
  fireEvent.click(screen.getByRole('button', { name: '下一題' }));

  selectChoice('資料保存期限？', answers.retentionDuration);
}

async function startAiDraft() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  while (screen.queryByRole('button', { name: '上一題' }) && !(screen.getByRole('button', { name: '上一題' }) as HTMLButtonElement).disabled) {
    fireEvent.click(screen.getByRole('button', { name: '上一題' }));
  }
  fillWizard();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
  fireEvent.click(screen.getByRole('button', { name: '產生資料流向草稿' }));
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

  it('guides six fields and presents a review before draft generation', () => {
    render(<ApplicationWizard />);
    fillWizard();
    fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
    expect(screen.getByRole('heading', { name: '送出前確認' })).toBeInTheDocument();
    expect(screen.getByText('確認後會產生資料流向草稿，之後可能還需回答追問並上傳附件。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '產生資料流向草稿' })).toBeDisabled();
    expect(screen.queryByText(/Unicode|四題合計|自述/)).not.toBeInTheDocument();
  });

  it('asks for a detail box when sensitive data is present, and skips follow-up copy when absent', () => {
    render(<ApplicationWizard />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '照片' } });
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '整理' } });
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    expect(screen.getByRole('heading', { name: '是否包含個資或敏感資料？' })).toBeInTheDocument();
    selectChoice('是否包含個資或敏感資料？', '有');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', '例如：人臉、姓名、金鑰');
    expect(screen.getByText(/選「有」時請簡述類型/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '姓名' } });
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '團隊雲端' } });
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    selectTool('ChatGPT');
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    selectChoice('資料保存期限？', '保留 30 天');
    fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
    expect(screen.getByText(/可能還需回答追問/)).toBeInTheDocument();
  });

  it('marks text fields required and rejects Unicode scalar overflow without UTF-16 maxLength', () => {
    render(<ApplicationWizard />);
    const input = screen.getByRole('textbox');
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: '😀'.repeat(501) } });
    expect(screen.getByRole('alert')).toHaveTextContent('超過上限');
    expect(screen.getByRole('button', { name: '下一題' })).toBeDisabled();
    expect(input).not.toHaveAttribute('maxLength');
    expect(screen.getByText('必填 · 501/500')).toBeInTheDocument();
  });

  it('opens or resumes a draft through the create endpoint without listing old cases first', async () => {
    const { read, mutate } = useAuthenticatedApi([
      { id: 'old-unsubmitted', state: 'draft', rowVersion: 8, updatedAt: '2026-08-31T11:59:59.999Z' },
    ]);

    render(<ApplicationWizard />);

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/v1/cases', expect.objectContaining({ method: 'POST' })));
    expect(read).not.toHaveBeenCalledWith('/api/v1/cases');
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

  it('shows real waiting phases and reads the AI job every 5 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { read } = useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: ['queued'] });
    render(<ApplicationWizard />);
    await startAiDraft();

    expect(screen.getByText('準備中')).toBeInTheDocument();
    expect(screen.queryByText(/申請人數較多/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('排隊中')).toBeInTheDocument();
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(1);
  });

  it('keeps polling queued or leased jobs without inventing a completion percent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { read } = useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], { answers: COMPLETE_ANSWERS, jobStates: [...Array(39).fill('queued'), 'leased', 'queued'] });
    render(<ApplicationWizard />);
    await startAiDraft();

    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
    expect(screen.getByRole('status')).toHaveTextContent(/仍在處理中/);
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(40);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(read.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/jobs/'))).toHaveLength(41);
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
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(caseReady).not.toHaveBeenCalled();
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

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText('處理失敗，請稍後再試。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '產生資料流向草稿' })).toBeEnabled();
  });

  it('blocks regenerating unsafe answers until they change and drops the stale warning after editing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { mutate } = useAuthenticatedApi([
      { id: 'active', state: 'draft', rowVersion: 2, updatedAt: '2026-08-31T11:55:00.000Z' },
    ], {
      answers: COMPLETE_ANSWERS,
      jobStates: ['queued'],
      draftErrors: [new PublicApiError({ code: 'AI_INPUT_UNSAFE', message: 'unsafe', status: 422 })],
    });
    render(<ApplicationWizard />);
    await startAiDraft();
    await act(async () => { await Promise.resolve(); });

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('內容包含系統指令');
    const generate = screen.getByRole('button', { name: '產生資料流向草稿' });
    expect(generate).toBeDisabled();
    // The warning sits before the action buttons so short screens show it without scrolling.
    expect(warning.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(generate);
    expect(mutate.mock.calls.filter(([path]) => String(path).endsWith('/ai-drafts'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    while (screen.queryByRole('button', { name: '上一題' }) && !(screen.getByRole('button', { name: '上一題' }) as HTMLButtonElement).disabled) {
      fireEvent.click(screen.getByRole('button', { name: '上一題' }));
    }
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '團隊雲端，只給社團幹部' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));

    expect(screen.queryByText(/內容包含系統指令/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '產生資料流向草稿' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '產生資料流向草稿' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mutate.mock.calls.filter(([path]) => String(path).endsWith('/ai-drafts'))).toHaveLength(2);
  });
});
