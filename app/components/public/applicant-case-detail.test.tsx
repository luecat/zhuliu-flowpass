import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPassportJson } from '../../../server/domain/passport-validation';
import { FLOWPASS_SAMPLE } from '../../passport-sample';
import { ApplicantCaseDetail } from './applicant-case-detail';

const mocks = vi.hoisted(() => ({ read: vi.fn(), readWithMeta: vi.fn() }));

vi.mock('../../lib/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/public-api')>();
  return { ...actual, PublicApiClient: class { read = mocks.read; readWithMeta = mocks.readWithMeta; } };
});

const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;

describe('ApplicantCaseDetail', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    mocks.read.mockReset();
    mocks.readWithMeta.mockReset();
    mocks.readWithMeta.mockResolvedValue({ data: { rowVersion: 3 }, etag: '"3"' });
    mocks.read.mockImplementation(async (path: string) => {
      if (path === '/api/v1/cases/case') return { id: 'case', state: 'under_review', approvedAmountTwd: null, submittedAt: '2026-09-01T04:59:37.894Z', updatedAt: '2026-09-01T05:10:04.889Z' };
      if (path === '/api/v1/cases/case/timeline') return { events: [
        { id: 'received', eventType: 'received', publicSummary: '案件已收件', createdAt: '2026-09-01T04:56:19.065Z' },
        { id: 'submitted', eventType: 'submitted', publicSummary: '申請已送出', createdAt: '2026-09-01T04:59:37.894Z' },
        { id: 'review', eventType: 'review_started', publicSummary: '已開始審查', createdAt: '2026-09-01T05:10:04.889Z' },
      ] };
      if (path === '/api/v1/cases/case/passport') return { version: { workflowState: 'confirmed' }, passport };
      if (path === '/api/v1/cases/case/alerts') return { alerts: [] };
      if (path === '/api/v1/cases/case/rules') return { evaluations: [] };
      if (path === '/api/v1/cases/case/safety-card') return { model: { title: 't', purpose: 'p', flow: [], beforeUpload: [], whileUsing: [], beforePublish: [], incidentSteps: [], meta: { tool: 'x', audience: 'public', retention: '待確認' } } };
      throw new Error(`unexpected path: ${path}`);
    });
  });

  it('titles the record by its use case and shows each section once', async () => {
    render(<ApplicantCaseDetail caseId="case" />);

    expect(await screen.findByRole('heading', { level: 1, name: FLOWPASS_SAMPLE.passport_draft.use_case.title })).toBeVisible();
    expect(screen.getByText('申請進度')).toBeVisible();
    expect(screen.getByRole('heading', { name: '審查中' })).toBeVisible();
    expect(screen.getByText('承辦人員審查中，目前無須進行操作。')).toBeVisible();
    expect(await screen.findByText('審查進行中')).toBeVisible();
    expect(await screen.findByText('目前無待處理之資安提醒。')).toBeVisible();
    expect(screen.getAllByRole('heading', { name: /資安提醒/ })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '護照' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: '安全檢查重點' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /SVG/ })).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/passports');
    expect(document.body.textContent).not.toMatch(/FP-SECRET|軟體補助申請|under_review|received|review_started|資料流向版本/);
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
    expect(screen.queryByRole('heading', { name: '護照' })).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/passports');
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/cases/case/timeline');
    expect(mocks.read).not.toHaveBeenCalledWith('/api/v1/cases/case/passport');
  });
});
