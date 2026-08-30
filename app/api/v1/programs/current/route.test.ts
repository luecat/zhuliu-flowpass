import { afterEach, describe, expect, it } from 'vitest';
import { configurePublicRuntime, clearPublicRuntime } from '../../../../../server/public/runtime';
import { GET } from './route';

describe('GET /api/v1/programs/current boundary', () => {
  afterEach(() => clearPublicRuntime());
  it('does not treat an admin or bearer header as applicant authentication', async () => {
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { getApplicantCookieNames: () => ({ session: 'flowpass_session', csrf: 'flowpass_csrf', bootstrap: 'b' }), authenticateApplicant: () => null } } as never);
    const response = await GET(new Request('http://127.0.0.1:38100/api/v1/programs/current', { headers: { authorization: 'Bearer admin', cookie: 'flowpass_admin_session=x' } }));
    expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  });
});
