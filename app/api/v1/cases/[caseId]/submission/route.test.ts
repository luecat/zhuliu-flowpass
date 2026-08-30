import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../../server/public/runtime';
import { POST } from './route';

const mock = vi.hoisted(() => { class MockSubmissionCommandError extends Error { constructor(readonly code: string) { super(code); } } return { mode: 'success' as 'success' | 'ready', MockSubmissionCommandError }; });
vi.mock('../../../../../../server/domain/submission-service', () => ({ SubmissionCommandError: mock.MockSubmissionCommandError, createSubmissionService: () => ({ submit: () => { if (mock.mode === 'ready') throw new mock.MockSubmissionCommandError('PASSPORT_NOT_READY'); return { case: { id: 'case', rowVersion: 4, state: 'submitted' }, passportVersionId: 'v1', submittedAt: '2026-08-30T00:00:00.000Z' }; } }) }));
vi.mock('../../../../../../server/public/public-mutations', () => ({ isValidMutationKey: (value: string | null) => Boolean(value), readApplicantMutation: () => null, reserveApplicantMutation: () => ({ kind: 'reserved', scope: 'scope', requestHash: 'hash', expiresAt: '2026-08-31T00:00:00.000Z' }), finalizeApplicantMutation: () => true, deleteApplicantMutationReservation: () => undefined }));

function runtime() { return { database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: (value: string | null) => value === 'http://127.0.0.1:38100', verifyApplicantCsrf: () => ({ applicantId: 'applicant' }) } }; }
function request(headers: Record<string, string> = {}) { return new Request('http://127.0.0.1:38100/api/v1/cases/c/submission', { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'submission-1', 'if-match': '"3"', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ passportVersionId: 'v1' }) }); }

describe('submission route', () => {
  afterEach(() => { clearPublicRuntime(); mock.mode = 'success'; });
  it('returns a submitted case with a fresh case ETag', async () => {
    configurePublicRuntime(runtime() as never);
    const response = await POST(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"4"');
  });
  it('rejects a passport that is not ready', async () => {
    mock.mode = 'ready';
    configurePublicRuntime(runtime() as never);
    const response = await POST(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(422);
  });
});
