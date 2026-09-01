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
    expect(screen.getByText(/確認資料會交給哪個服務處理。/)).toBeInTheDocument();
    expect(screen.queryByText(/assistant|user|對話/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('你會使用哪個 AI 工具？'), { target: { value: '本地工具' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存追問答案' }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q-1', answer: '本地工具' }]);
  });

  it('requires required cards before submit', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={questions} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '儲存追問答案' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('請完成所有必填追問。');
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
    expect(screen.getByRole('heading', { name: '資料中有沒有人臉、姓名或其他個資？' })).toBeVisible();
    expect(screen.getByText(/確認是否需要遮蔽資料或先取得同意。/)).toBeVisible();
  });

  it('renders typed controls and encodes multi-choice answers', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={[{ ...questions[0], answerSchema: { type: 'multi_choice', choices: ['A', 'B'] } }]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('A'));
    fireEvent.click(screen.getByRole('button', { name: '儲存追問答案' }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q-1', answer: '["A"]' }]);
  });

  it('turns abstract storage and retention questions into concrete everyday wording', () => {
    render(<AiFollowUpForm questions={[{
      ...questions[0],
      questionKey: 'storage_retention',
      prompt: '請說明修圖結果的儲存位置與保留期間。',
      reason: '確認資料留存風險。',
    }]} onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '處理完成後，檔案會放在哪裡、保留多久？' })).toBeVisible();
    expect(screen.getByPlaceholderText(/Google Drive 保留 30 天/)).toBeVisible();
  });
});
