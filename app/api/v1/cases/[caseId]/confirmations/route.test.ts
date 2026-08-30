import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../../server/public/runtime';
import { POST } from './route';

const mock = vi.hoisted(() => ({ called: false }));
vi.mock('../../../../../../server/domain/passport-lifecycle', () => ({ createPassportLifecycle: () => ({ answerFollowUps: (input: unknown) => { mock.called = Boolean(input); return { id: 'v1', versionNo: 1, workflowState: 'follow_up_required' }; }, confirmVersion: (input: unknown) => { mock.called = Boolean(input); return { id: 'v1', versionNo: 1, workflowState: 'confirmed' }; } }) }));
vi.mock('../../../../../../server/public/public-mutations', () => ({ isValidMutationKey: (value: string | null) => Boolean(value), readApplicantMutation: () => null, reserveApplicantMutation: () => ({ kind: 'reserved', scope: 'scope', requestHash: 'hash', expiresAt: '2026-08-31T00:00:00.000Z' }), finalizeApplicantMutation: () => true, deleteApplicantMutationReservation: () => undefined }));

function runtime() { return { database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: (value: string | null) => value === 'http://127.0.0.1:38100', verifyApplicantCsrf: () => ({ applicantId: 'applicant' }) } }; }
function request(headers: Record<string, string> = {}) { return new Request('http://127.0.0.1:38100/api/v1/cases/c/confirmations', { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'confirmation-1', 'if-match': '"1"', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ passportVersionId: 'v1', answers: [], declarations: [] }) }); }

describe('confirmation route', () => {
  afterEach(() => { clearPublicRuntime(); mock.called = false; });
  it('requires an idempotency key before invoking the lifecycle', async () => {
    configurePublicRuntime(runtime() as never);
    const response = await POST(request({ 'idempotency-key': '' }), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(400);
    expect(mock.called).toBe(false);
  });
  it('accepts a guarded confirmation mutation', async () => {
    configurePublicRuntime(runtime() as never);
    const response = await POST(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(201);
    expect(mock.called).toBe(true);
  });
});
