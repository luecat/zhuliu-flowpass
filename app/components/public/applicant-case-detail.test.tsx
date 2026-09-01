import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPassportJson } from '../../../server/domain/passport-validation';
import { FLOWPASS_SAMPLE } from '../../passport-sample';
import { ApplicantCaseDetail } from './applicant-case-detail';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = mocks.read; } };
});

const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;

describe('ApplicantCaseDetail', () => {
  beforeEach(() => {
    mocks.read.mockReset();
    mocks.read.mockImplementation(async (path: string) => {
      if (path === '/api/v1/cases/case') return { id: 'case', state: 'under_review', approvedAmountTwd: null, submittedAt: '2026-09-01T04:59:37.894Z', updatedAt: '2026-09-01T05:10:04.889Z' };
      if (path === '/api/v1/passports') return { passports: [{ id: 'case', caseCode: 'FP-SECRET', programName: '軟體補助申請', year: 2026, state: 'under_review', submittedAt: '2026-09-01T04:59:37.894Z', unresolvedTaskCount: 0, securityAlert: false }] };
      if (path === '/api/v1/cases/case/timeline') return { events: [
        { id: 'received', eventType: 'received', publicSummary: '案件已收件', createdAt: '2026-09-01T04:56:19.065Z' },
        { id: 'submitted', eventType: 'submitted', publicSummary: '申請已送出', createdAt: '2026-09-01T04:59:37.894Z' },
        { id: 'review', eventType: 'review_started', publicSummary: '已開始審查', createdAt: '2026-09-01T05:10:04.889Z' },
      ] };
      if (path === '/api/v1/cases/case/passport') return { version: { workflowState: 'confirmed' }, passport };
      throw new Error(`unexpected path: ${path}`);
    });
  });

  it('shows the current public status without submission or internal workflow screens', async () => {
    render(<ApplicantCaseDetail caseId="case" />);

    expect(await screen.findByRole('heading', { name: '軟體補助申請' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '審查中' })).toBeVisible();
    expect(screen.getByText('承辦人員正在確認申請內容，暫時不需要進行其他操作。')).toBeVisible();
    expect(await screen.findByText('已開始審查')).toBeVisible();
    expect(await screen.findByText('已確認的資料流向')).toBeVisible();
    expect(screen.queryByText('申請已正式送出')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/FP-SECRET|under_review|received|review_started|資安提醒|護照版本/);
  });

  it('shows only the supplement task when the case is waiting for documents', async () => {
    mocks.read.mockImplementation(async (path: string) => {
      if (path === '/api/v1/cases/case') return { id: 'case', state: 'awaiting_documents', approvedAmountTwd: null, submittedAt: '2026-09-01T04:59:37.894Z', updatedAt: '2026-09-01T05:10:04.889Z' };
      if (path === '/api/v1/tasks?caseId=case') return { tasks: [{ id: 'task-1', taskType: 'provide_document', title: '發票', instructions: '不夠完整', acceptedDocumentTypes: ['invoice'], dueAt: null, createdAt: '2026-09-01T05:10:04.889Z', rowVersion: 1 }] };
      if (path === '/api/v1/cases/case/documents') return { documents: [] };
      throw new Error(`unexpected path: ${path}`);
    });

    render(<ApplicantCaseDetail caseId="case" />);

    expect(await screen.findByRole('heading', { name: '請補充資料' })).toBeVisible();
    expect(screen.getByText('發票')).toBeVisible();
    expect(screen.getByText('不夠完整')).toBeVisible();
    expect(screen.queryByText('目前狀態')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '處理進度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '資料流向' })).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/passports');
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/cases/case/timeline');
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/cases/case/passport');
  });
});
