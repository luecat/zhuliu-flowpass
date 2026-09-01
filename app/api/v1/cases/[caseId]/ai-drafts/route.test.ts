import { describe, expect, it } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../../server/public/runtime';
import { vi } from 'vitest';
import { POST } from './route';

const routeMocks = vi.hoisted(() => ({ mode: 'success' as 'success' | 'not-found' | 'etag' | 'rate' | 'active' }));
vi.mock('../../../../../../server/db/repositories/cases', () => ({ getCaseForApplicant: () => routeMocks.mode === 'not-found' ? null : { id: 'case', rowVersion: 1 } }));
vi.mock('../../../../../../server/db/repositories/jobs', () => ({ getApplicantActiveAiDraftJob: () => routeMocks.mode === 'active' ? { id: 'active-job', state: 'leased', createdAt: '2026-08-30T00:00:00.000Z', completedAt: null } : null }));
vi.mock('../../../../../../server/domain/ai-draft-service', () => {
  class MockAiDraftCommandError extends Error { constructor(readonly code: string) { super(code); } }
  return { AiDraftCommandError: MockAiDraftCommandError, createAiDraftService: () => ({ enqueue: () => {
    if (routeMocks.mode === 'rate') throw new MockAiDraftCommandError('RATE_LIMITED');
    return { job: { id: 'opaque-job', state: 'queued' }, inputTokens: 1 };
  } }) };
});
vi.mock('../../../../../../server/public/public-mutations', () => ({
  isValidMutationKey: () => true,
  readApplicantMutation: () => null,
  reserveApplicantMutation: () => ({ kind: 'reserved', token: 'reservation' }),
  finalizeApplicantMutation: () => true,
  deleteApplicantMutationReservation: () => undefined,
}));

describe('AI draft route boundary', () => {
  it('fails closed when trusted startup dependencies are not configured', async () => {
    clearPublicRuntime();
    const response = await POST(new Request('http://127.0.0.1/api/v1/cases/x/ai-drafts', { method: 'POST', body: '{}' }), { params: Promise.resolve({ caseId: 'x' }) });
    expect(response.status).toBe(503);
  });

  const request = (headers: Record<string, string> = {}) => new Request('http://127.0.0.1:38100/api/v1/cases/case/ai-drafts', { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'ai-key', 'if-match': '"1"', 'content-type': 'application/json', ...headers }, body: '{}' });
  const runtime = () => ({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', requestIdGenerator: () => 'request', clock: () => new Date('2026-08-30T00:00:00.000Z'), lineSessions: { isPublicOrigin: (origin: string | null) => origin === 'http://127.0.0.1:38100', verifyApplicantCsrf: () => ({ applicantId: 'applicant' }) } });

  it('returns an opaque 202 job for the current owner and maps stale/unknown cases', async () => {
    configurePublicRuntime(runtime() as never);
    routeMocks.mode = 'success';
    const response = await POST(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(202);
    expect(JSON.stringify(await response.json())).not.toContain('material');
    routeMocks.mode = 'not-found';
    expect((await POST(request(), { params: Promise.resolve({ caseId: 'case' }) })).status).toBe(404);
  });

  it('reconnects to the current applicant-owned active draft job', async () => {
    configurePublicRuntime(runtime() as never);
    routeMocks.mode = 'active';
    const response = await POST(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { jobId: 'active-job', state: 'leased' } });
  });

  it('rejects wrong origin, missing If-Match and admission rate limits before creating a job', async () => {
    configurePublicRuntime(runtime() as never);
    expect((await POST(request({ origin: 'https://evil.invalid' }), { params: Promise.resolve({ caseId: 'case' }) })).status).toBe(403);
    expect((await POST(request({ 'if-match': '' }), { params: Promise.resolve({ caseId: 'case' }) })).status).toBe(400);
    routeMocks.mode = 'rate';
    expect((await POST(request(), { params: Promise.resolve({ caseId: 'case' }) })).status).toBe(429);
  });
});
