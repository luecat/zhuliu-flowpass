import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApplicantHome from './page';

describe('ApplicantHome', () => {
  it('explains the journey without offering other in-app destinations', () => {
    render(<ApplicantHome />);
    expect(screen.getByRole('heading', { name: '用清楚的資料流向，申請 AI 工具補助' })).toBeVisible();
    expect(screen.getByText(/給已購買核准 AI 工具/)).toBeVisible();
    expect(screen.getByText(/AI 只協助整理流向，不決定能不能補助/)).toBeVisible();
    expect(screen.getByText(/預估需 10–15 分鐘/)).toBeVisible();
    expect(screen.getByText(/官方收據、刷卡單筆明細/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'LINE 可以幫你什麼' })).toBeVisible();
    expect(screen.getByText(/申請、進度查詢與工具檢測請由 LINE 選單進入/)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
