import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApplicantHome from './page';

describe('ApplicantHome', () => {
  it('explains the journey without offering other in-app destinations', () => {
    render(<ApplicantHome />);
    expect(screen.getByText(/預估需 10–15 分鐘/)).toBeVisible();
    expect(screen.getByText(/身分證、購買憑證/)).toBeVisible();
    expect(screen.getByText(/申請、進度查詢與檢測請由 LINE 選單進入/)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
