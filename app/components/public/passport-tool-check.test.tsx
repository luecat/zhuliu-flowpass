import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicApiError } from '../../lib/public-api';
import { PassportToolCheck } from './passport-tool-check';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = mocks.read; } };
});

describe('PassportToolCheck', () => {
  beforeEach(() => { mocks.read.mockReset(); });

  it('leads with a verdict and shows incidents in applicant language without case codes or enums', async () => {
    mocks.read.mockResolvedValue({
      tools: ['Runway'],
      cases: [{ caseCode: 'FP-SECRET', tools: ['Runway'] }],
      incidents: [{ toolName: 'Runway', vendor: 'Runway AI', title: '素材分享連結外洩', severity: 'high', incidentStartAt: '2026-08-01T00:00:00.000Z', incidentEndAt: null, sourceTitle: '官方公告', sourceUrl: 'https://example.com/notice', publishedAt: null, recommendedActions: ['撤銷公開分享連結'] }],
      impacts: [{
        caseId: 'case-1',
        caseCode: 'FP-SECRET',
        passportTitle: '短影音後製流程',
        status: 'open',
        severity: 'high',
        summary: '可能受影響的資安提醒',
        incidentTitle: '素材分享連結外洩',
        guidance: '請檢查雲端資料夾權限',
        affectedDataKinds: ['活動照片'],
        sharingAudience: null,
      }],
    });

    render(<PassportToolCheck />);

    expect(await screen.findByRole('heading', { name: '有 1 則專屬提醒需要你處理' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '短影音後製流程' })).toBeVisible();
    expect(screen.getAllByText('素材分享連結外洩').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('影響程度：高')).toBeVisible();
    expect(screen.getByText('可能相關資料：活動照片')).toBeVisible();
    expect(screen.getByText('請檢查雲端資料夾權限')).toBeVisible();
    expect(screen.getByRole('link', { name: '查看此護照 ›' })).toHaveAttribute('href', '/app/passports/case-1');
    expect(screen.getByText('撤銷公開分享連結')).toBeVisible();
    expect(screen.getByRole('link', { name: /官方公告/ })).toHaveAttribute('href', 'https://example.com/notice');
    expect(document.body.textContent).not.toMatch(/FP-SECRET|\bhigh\b|\bopen\b/);
  });

  it('offers a retry after a failure and still shows the public incidents section', async () => {
    mocks.read.mockRejectedValueOnce(new Error('offline'));
    mocks.read.mockResolvedValueOnce({ tools: [], cases: [], incidents: [], impacts: [] });

    render(<PassportToolCheck />);
    fireEvent.click(await screen.findByRole('button', { name: '再試一次' }));

    expect(await screen.findByRole('heading', { name: '目前沒有公開資安事件' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '公開資安事件' })).toBeVisible();
  });

  it('asks the applicant to reopen from LINE when the session expired', async () => {
    mocks.read.mockRejectedValue(new PublicApiError({ code: 'UNAUTHENTICATED', message: 'expired', status: 401 }));
    render(<PassportToolCheck />);
    expect(await screen.findByRole('heading', { name: '載入失敗' })).toBeVisible();
  });
});
