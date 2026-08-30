import { afterEach, describe, expect, it } from 'vitest';
import { clearPublicRuntime, configurePublicRuntime } from '../../../../../../server/public/runtime';
import { GET } from './route';

describe('public security alert route', () => {
  afterEach(() => clearPublicRuntime());
  it('fails closed without an authenticated owner session', async () => {
    configurePublicRuntime({ database: {}, crypto: {}, publicOrigin: 'http://127.0.0.1:38100', lineSessions: { authenticateApplicant: () => null } } as never);
    const response = await GET(new Request('http://127.0.0.1:38100/api/v1/cases/case/alerts'), { params: Promise.resolve({ caseId: 'case' }) });
    expect(response.status).toBe(401);
  });
});
