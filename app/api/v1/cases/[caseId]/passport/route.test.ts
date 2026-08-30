import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../../server/public/runtime';
import { GET } from './route';

const mock = vi.hoisted(() => ({ mode: 'success' as 'success' | 'missing', value: { version: { id: 'passport-v1', versionNo: 1 }, passport: { use_case: { title: '示範', purpose: '整理', intended_outcome: '完成' } }, followUps: [], etag: '"1"' } }));
vi.mock('../../../../../../server/domain/passport-lifecycle', () => ({ createPassportLifecycle: () => ({ getForApplicant: () => mock.mode === 'success' ? mock.value : null }) }));

function request() { return new Request('http://127.0.0.1:38100/api/v1/cases/c/passport', { headers: { cookie: 'flowpass_session=s' } }); }

describe('passport route', () => {
  afterEach(() => { clearPublicRuntime(); mock.mode = 'success'; });
  it('returns the owned passport with an ETag and no mutation headers', async () => {
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', clock: () => new Date('2026-08-30T00:00:00.000Z'), lineSessions: { authenticateApplicant: () => ({ sessionId: 'session', applicantId: 'applicant' }) } } as never);
    const response = await GET(request(), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"1"');
    expect((await response.json()).data.version.id).toBe('passport-v1');
  });
  it('does not reveal an absent or foreign passport', async () => {
    mock.mode = 'missing';
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { authenticateApplicant: () => ({ sessionId: 'session', applicantId: 'applicant' }) } } as never);
    expect((await GET(request(), { params: Promise.resolve({ caseId: 'case' }) })).status).toBe(404);
  });
});
