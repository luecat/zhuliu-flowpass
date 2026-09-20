import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProgramSettings } from './program-settings';
import type { AdminRequest } from './api';

const CYCLES = { cycles: [
  { id: 'cycle-1', code: 'TEST', name: '測試方案', year: 2026, status: 'active' },
  { id: 'cycle-demo', code: 'ZZ-DEMO-100-PASSPORTS', name: '【測試】FlowPass 百件測試護照', year: 2000, status: 'closed' },
] };

function harness(settings: Record<string, unknown>, onPut?: (body: unknown) => unknown) {
  const requestMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/v1/program-cycles') return CYCLES;
    if (url === '/admin/v1/program-cycles/cycle-1/settings') {
      if (init?.method === 'PUT') return onPut?.(JSON.parse(String(init.body)));
      return { ruleVersionId: 'rule-1', versionNo: 1, publishedAt: null, settings };
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { requestMock, request: requestMock as unknown as AdminRequest };
}

describe('ProgramSettings', () => {
  it('keeps closed cycles out of the picker and selects the active one', async () => {
    const { request } = harness({ softwareBlacklist: [], ageEligibility: {} });
    render(<ProgramSettings request={request} onBack={vi.fn()} />);
    await screen.findByRole('textbox', { name: '不予補助清單' });
    // A closed demo programme is not configurable and must not be offered.
    expect(screen.queryByText(/百件測試護照/)).toBeNull();
  });

  it('shows the published blacklist and birth cohort, and saves the edits', async () => {
    const saved: unknown[] = [];
    const { request } = harness(
      { softwareBlacklist: ['Blocked Vendor'], ageEligibility: { birthDateFrom: '2008-01-01' } },
      (body) => { saved.push(body); return { ruleVersionId: 'rule-2', versionNo: 2, publishedAt: '2026-09-19T00:00:00.000Z', settings: { softwareBlacklist: ['Blocked Vendor', 'Other Co'], ageEligibility: { birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } } }; },
    );

    render(<ProgramSettings request={request} onBack={vi.fn()} />);
    const list = await screen.findByRole('textbox', { name: '不予補助清單' });
    expect(list).toHaveValue('Blocked Vendor');
    expect(screen.getByLabelText('出生日期起（含當日）')).toHaveValue('2008-01-01');

    fireEvent.change(list, { target: { value: 'Blocked Vendor\n  Other Co  \n\n' } });
    fireEvent.change(screen.getByLabelText('出生日期迄（含當日）'), { target: { value: '2014-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存並發布新版本' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    // Blank lines and stray spacing never reach the API.
    expect(saved[0]).toEqual({ softwareBlacklist: ['Blocked Vendor', 'Other Co'], ageEligibility: { birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } });
    expect(await screen.findByText(/發布為規則版本 v2/)).toBeVisible();
  });

  it('keeps a non-numeric age out of the request and explains why', async () => {
    const { request, requestMock } = harness({ softwareBlacklist: [], ageEligibility: {} });
    render(<ProgramSettings request={request} onBack={vi.fn()} />);
    await screen.findByRole('textbox', { name: '不予補助清單' });

    fireEvent.change(screen.getByLabelText('最小年齡（送件時足歲）'), { target: { value: '十二' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存並發布新版本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('年齡請填 0 至 150 的整數');
    expect(requestMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('translates a server rejection into the offending field', async () => {
    const { request } = harness({ softwareBlacklist: [], ageEligibility: {} }, () => { throw Object.assign(new Error('birth_date_range_inverted'), { status: 400 }); });
    render(<ProgramSettings request={request} onBack={vi.fn()} />);
    await screen.findByRole('textbox', { name: '不予補助清單' });

    fireEvent.change(screen.getByLabelText('出生日期起（含當日）'), { target: { value: '2014-01-01' } });
    fireEvent.change(screen.getByLabelText('出生日期迄（含當日）'), { target: { value: '2008-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存並發布新版本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('出生起日不可晚於出生迄日。');
  });
});
