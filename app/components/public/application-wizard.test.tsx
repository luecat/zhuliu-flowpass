import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApplicationWizard } from './application-wizard';

describe('ApplicationWizard boundaries', () => {
  it('guides four fields and presents a review before draft generation', () => {
    render(<ApplicationWizard />);
    for (const [index, value] of ['照片', '整理', '姓名', '團隊雲端'].entries()) {
      fireEvent.change(screen.getByRole('textbox'), { target: { value } });
      if (index < 3) fireEvent.click(screen.getByRole('button', { name: '下一題' }));
    }
    fireEvent.click(screen.getByRole('button', { name: '檢查答案' }));
    expect(screen.getByRole('heading', { name: '送出前確認' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '整理護照草稿' })).toBeDisabled();
  });

  it('marks every field required and rejects Unicode scalar overflow without UTF-16 maxLength', () => {
    render(<ApplicationWizard />);
    const input = screen.getByRole('textbox');
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: '😀'.repeat(501) } });
    expect(screen.getByRole('alert')).toHaveTextContent('超過上限');
    expect(screen.getByRole('button', { name: '下一題' })).toBeDisabled();
    expect(input).not.toHaveAttribute('maxLength');
  });
});
