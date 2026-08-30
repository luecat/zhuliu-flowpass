import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentReview } from './document-review';

describe('DocumentReview', () => {
  it('shows the guided upload limits and does not invent an upload without a selected file', () => {
    render(<DocumentReview suppliedCaseId="0198f090-0000-7000-8000-000000000001" />);
    expect(screen.getByRole('heading', { name: '附件' })).toBeInTheDocument();
    expect(screen.getByText(/JPEG、PNG 或非加密 PDF/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上傳文件' })).toBeDisabled();
  });

  it('prevents submitting the upload action until a file is chosen', () => {
    render(<DocumentReview suppliedCaseId="0198f090-0000-7000-8000-000000000001" />);
    const button = screen.getByRole('button', { name: '上傳文件' });
    expect(button).toBeDisabled();
    vi.restoreAllMocks();
  });
});
