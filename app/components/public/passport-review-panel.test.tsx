import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PassportReviewPanel } from './passport-review-panel';

describe('PassportReviewPanel', () => {
  it('stays pending without a case identifier and does not submit data', () => {
    render(<PassportReviewPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('完成申請草稿後');
    expect(screen.queryByRole('button', { name: '送出申請' })).not.toBeInTheDocument();
  });
});
