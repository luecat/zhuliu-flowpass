import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApplicantHome from './page';

describe('ApplicantHome', () => {
  it('offers application and record lookup without a work-queue destination', () => {
    render(<ApplicantHome />);
    expect(screen.getByRole('link', { name: '送出申請' })).toHaveAttribute('href', '/app/apply');
    expect(screen.getByRole('link', { name: '查詢申請進度' })).toHaveAttribute('href', '/app/passports');
    expect(screen.queryByRole('link', { name: /待辦/ })).not.toBeInTheDocument();
  });
});
