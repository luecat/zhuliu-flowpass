import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../../server/public/runtime';
import { PUT } from './route';

const mock = vi.hoisted(() => ({ mode: 'success' as 'success' | 'not-found' | 'submitted' | 'etag' }));
vi.mock('../../../../../../server/domain/case-service', () => {
  class MockCaseCommandError extends Error { constructor(readonly code: string) { super(code); } }
  return { CaseCommandError: MockCaseCommandError, createCaseService: () => ({ saveAnswers: () => {
    if (mock.mode === 'not-found') throw new MockCaseCommandError('NOT_FOUND');
    if (mock.mode === 'submitted') throw new MockCaseCommandError('INVALID_STATE');
    if (mock.mode === 'etag') throw new MockCaseCommandError('ETAG_MISMATCH');
    return { case: { id: '0198f050-0000-7000-8000-000000000002', rowVersion: 2 }, answerVersion: { id: '0198f050-0000-7000-8000-000000000003', versionNo: 1, createdAt: '2026-08-30T00:00:00.000Z' } };
  } }) };
});

describe('PUT /api/v1/cases/:caseId/answers boundary', () => {
  afterEach(() => clearPublicRuntime());
  const makeRequest = (extra: Record<string, string> = {}) => new Request('http://127.0.0.1:38100/api/v1/cases/c/answers', { method: 'PUT', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'content-type': 'application/json', 'idempotency-key': 'answers-test', 'if-match': '"1"', ...extra }, body: JSON.stringify({ material: '資料', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' }) });
  it('requires the idempotency and If-Match mutation headers', async () => {
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: () => true, verifyApplicantCsrf: () => ({ applicantId: '0198f050-0000-7000-8000-000000000001' }) } } as never);
    const response = await PUT(new Request('http://127.0.0.1:38100/api/v1/cases/0198f050-0000-7000-8000-000000000002/answers', { method: 'PUT', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ caseId: '0198f050-0000-7000-8000-000000000002' }) });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_REQUEST');
  });
  it('returns 201 for a guarded answer mutation and maps ownership/state conflicts safely', async () => {
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: () => true, verifyApplicantCsrf: () => ({ applicantId: '0198f050-0000-7000-8000-000000000001' }) } } as never);
    mock.mode = 'success'; expect((await PUT(makeRequest(), { params: Promise.resolve({ caseId: '0198f050-0000-7000-8000-000000000002' }) })).status).toBe(201);
    mock.mode = 'not-found'; expect((await PUT(makeRequest(), { params: Promise.resolve({ caseId: '0198f050-0000-7000-8000-000000000002' }) })).status).toBe(404);
    mock.mode = 'submitted'; expect((await PUT(makeRequest(), { params: Promise.resolve({ caseId: '0198f050-0000-7000-8000-000000000002' }) })).status).toBe(409);
    mock.mode = 'etag'; expect((await PUT(makeRequest(), { params: Promise.resolve({ caseId: '0198f050-0000-7000-8000-000000000002' }) })).status).toBe(409);
  });
});
