import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PassportCasePage from './page';

describe('PassportCasePage', () => {
  it('keeps the applicant detail focused on progress and data flow', async () => {
    render(await PassportCasePage({ params: Promise.resolve({ caseId: 'case' }) }));
    expect(screen.getByRole('region', { name: '申請進度' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /返回申請紀錄/ })).toHaveAttribute('href', '/app/passports');
    expect(screen.getByText('正在載入申請進度…')).toBeInTheDocument();
    expect(screen.queryByText('資安提醒')).not.toBeInTheDocument();
    expect(screen.queryByText('護照紀錄')).not.toBeInTheDocument();
  });
});
