import { afterEach, describe, expect, it } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../server/public/runtime';
import { POST } from './route';

const runtime = { database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { isPublicOrigin: (origin: string | null) => origin === 'http://127.0.0.1:38100', verifyApplicantCsrf: () => ({ applicantId: '0198f050-0000-7000-8000-000000000001' }) } } as never;
function request(body: unknown, headers: Record<string, string> = {}) { return new Request('http://127.0.0.1:38100/api/v1/cases', { method: 'POST', headers: { origin: 'http://127.0.0.1:38100', cookie: 'flowpass_session=s; flowpass_csrf=c', 'x-flowpass-csrf': 'c', 'idempotency-key': 'case-test', ...headers }, body: JSON.stringify(body) }); }

describe('POST /api/v1/cases boundary', () => {
  afterEach(() => clearPublicRuntime());
  it('returns a public invalid-request envelope for a malformed body after auth guards', async () => { configurePublicRuntime(runtime); const response = await POST(request({ unexpected: true })); expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_REQUEST'); });
  it('rejects a missing exact origin before reading case input', async () => { configurePublicRuntime(runtime); const response = await POST(request({}, { origin: 'https://evil.example' })); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('CSRF_FAILED'); });
});
