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
    expect(screen.getByText(/工具會影響資料處理方式。/)).toBeInTheDocument();
    expect(screen.queryByText(/assistant|user|對話/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('使用哪個工具？'), { target: { value: '本地工具' } });
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

  it('renders typed controls and encodes multi-choice answers', () => {
    const onSubmit = vi.fn();
    render(<AiFollowUpForm questions={[{ ...questions[0], answerSchema: { type: 'multi_choice', choices: ['A', 'B'] } }]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('A'));
    fireEvent.click(screen.getByRole('button', { name: '儲存追問答案' }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q-1', answer: '["A"]' }]);
  });
});
