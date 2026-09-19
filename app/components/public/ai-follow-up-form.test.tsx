import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiFollowUpForm } from './ai-follow-up-form';

const questions = [
  { id: 'q-1', questionKey: 'tool', passportVersionId: 'v1', versionNo: 1, prompt: '使用哪個工具？', reason: '工具會影響資料處理方式。', answerSchema: { type: 'text', maxLength: 400 }, required: true, relatedNodeIds: [], priority: 'high' as const, status: 'open' as const },
  { id: 'q-2', questionKey: 'audience', passportVersionId: 'v1', versionNo: 1, prompt: '誰會看到？', reason: '分享範圍需要本人確認。', answerSchema: { type: 'text', maxLength: 400 }, required: false, relatedNodeIds: [], priority: 'medium' as const, status: 'open' as const },
];

describe('AiFollowUpForm', () => {
  it('renders guided cards and submits keyed answers without chat bubbles', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={questions} onSubmit={onSubmit} />);
    expect(screen.getAllByTestId('ai-follow-up-card')).toHaveLength(2);
    expect(screen.getByText(/確認資料處理的服務來源。/)).toBeInTheDocument();
    expect(screen.queryByText(/assistant|user|對話/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('使用哪個 AI 工具？'), { target: { value: '本地工具' } });
    fireEvent.click(screen.getByRole('button', { name: '繼續' }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q-1', answer: '本地工具' }]);
  });

  it('requires required cards before submit', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={questions} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '繼續' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('請完成所有必填問題。');
  });

  it('uses natural applicant copy when model text exposes internal fields', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={[{
      ...questions[0],
      questionKey: 'personal_or_sensitive_data',
      prompt: '請確認 personal_or_sensitive_data 欄位',
      reason: '因 audience 為 public',
    }]} onSubmit={onSubmit} />);

    expect(document.body.textContent).not.toMatch(/personal_or_sensitive_data|audience|public/i);
    expect(screen.getByRole('heading', { name: '資料可能包含哪些敏感內容？' })).toBeVisible();
    expect(screen.getByText(/系統需依此評估風險/)).toBeVisible();
  });

  it('renders typed controls and encodes multi-choice answers', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={[{ ...questions[0], answerSchema: { type: 'multi_choice', choices: ['A', 'B'] } }]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('A'));
    fireEvent.click(screen.getByRole('button', { name: '繼續' }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q-1', answer: '["A"]' }]);
  });

  it('does not auto-regenerate after answering; regenerate requires an explicit CTA', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const onRegenerate = vi.fn();
    render(<AiFollowUpForm
      questions={[
        { ...questions[0], answerSchema: { type: 'single_choice', choices: ['ChatGPT', 'Claude'] } },
        { ...questions[1], required: true, answerSchema: { type: 'multi_choice', choices: ['完全沒有', '不確定'] } },
      ]}
      onSubmit={onSubmit}
      onRegenerate={onRegenerate}
    />);

    const toolInput = screen.getByRole('combobox', { name: '使用哪個 AI 工具？' });
    fireEvent.focus(toolInput);
    fireEvent.change(toolInput, { target: { value: 'ChatGPT' } });
    const chatgptOption = screen.getAllByRole('button').find((node) => (node.textContent ?? '').includes('ChatGPT') && (node.textContent ?? '').includes('OpenAI'));
    expect(chatgptOption).toBeTruthy();
    fireEvent.click(chatgptOption!);
    fireEvent.click(screen.getByLabelText('完全沒有'));
    vi.advanceTimersByTime(1_000);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onRegenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '繼續' }));
    expect(onRegenerate).toHaveBeenCalledWith([
      { questionId: 'q-1', answer: 'ChatGPT' },
      { questionId: 'q-2', answer: '["完全沒有"]' },
    ]);
    vi.useRealTimers();
  });

  it('shows an immediate security tip when a cloud choice is selected', () => {
    render(<AiFollowUpForm questions={[{
      ...questions[0],
      answerSchema: { type: 'multi_choice', choices: ['Google Drive / Dropbox 等雲端', '只留在手機或電腦'] },
    }]} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Google Drive / Dropbox 等雲端'));
    expect(screen.getByText(/雲端硬碟的預設連結可能具有公開風險/)).toBeVisible();
  });

  it('turns abstract storage and retention questions into concrete everyday wording', () => {
    render(<AiFollowUpForm questions={[{
      ...questions[0],
      questionKey: 'storage_retention',
      prompt: '請說明修圖結果的儲存位置與保留期間。',
      reason: '確認資料留存風險。',
    }]} onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '處理完成後，檔案存放在哪裡、保留多久？' })).toBeVisible();
    expect(screen.getByPlaceholderText(/存於手機且上傳後刪除/)).toBeVisible();
  });

  it('allows answering optional cards and includes them in the payload', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={questions} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('使用哪個 AI 工具？'), { target: { value: '本地工具' } });
    fireEvent.change(screen.getByLabelText('完成後檔案存放在哪裡、分享給誰？'), { target: { value: '社團成員' } });
    fireEvent.click(screen.getByRole('button', { name: '繼續' }));
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: 'q-1', answer: '本地工具' },
      { questionId: 'q-2', answer: '社團成員' },
    ]);
  });
});
