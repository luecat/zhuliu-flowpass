import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getCase } from './cases/[caseId]/route';
import { GET as getJob } from './jobs/[jobId]/route';
import { FieldCrypto, type Keyring } from '../../../server/crypto/field-crypto';
import { openDatabase } from '../../../server/db/connection';
import { migrateDatabase } from '../../../server/db/migrate';
import { createSessionRepository } from '../../../server/db/repositories/sessions';
import { createLineSessionService } from '../../../server/domain/line-session-service';
import { SessionService } from '../../../server/domain/session-service';
import { clearPublicRuntime, configurePublicRuntime } from '../../../server/public/runtime';

const ORIGIN = 'http://127.0.0.1:38100';
const STAMP = '2026-08-30T00:00:00.000Z';
const IDS = {
  applicantA: '0198f051-0000-7000-8000-000000000001',
  applicantB: '0198f051-0000-7000-8000-000000000002',
  programCycle: '0198f051-0000-7000-8000-000000000003',
  ruleVersion: '0198f051-0000-7000-8000-000000000004',
  caseA: '0198f051-0000-7000-8000-000000000005',
  jobA: '0198f051-0000-7000-8000-000000000006',
  missing: '0198f051-0000-7000-8000-000000000099',
} as const;

function createIds(): () => string {
  let sequence = 100;
  return () => `0198f052-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

function createTokens(): () => string {
  let sequence = 1;
  return () => Buffer.alloc(32, sequence++).toString('base64url');
}

function createCrypto(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey: (id) => (id === 'test-v1' ? Buffer.alloc(32, 0x41) : undefined),
  };
  return new FieldCrypto(keyring);
}

function seed(database: Database.Database): void {
  for (const applicantId of [IDS.applicantA, IDS.applicantB]) {
    database.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, 'active', ?, ?, 1)`,
    ).run(applicantId, 'sealed', STAMP, STAMP);
  }
  database.prepare(
    `INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version)
     VALUES (?, 'CYCLE-A', 'FlowPass', 2026, 'active', '{}', ?, ?, 1)`,
  ).run(IDS.programCycle, STAMP, STAMP);
  database.prepare(
    `INSERT INTO program_rule_versions (
      id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd,
      rounding_mode, required_documents_json, rules_json, created_at
    ) VALUES (?, ?, 1, 'draft', 5000, 10000, 'floor', '[]', '{}', ?)`,
  ).run(IDS.ruleVersion, IDS.programCycle, STAMP);
  database.prepare(
    `INSERT INTO cases (
      id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state,
      created_at, updated_at, row_version
    ) VALUES (?, 'CASE-A', ?, ?, ?, 'draft', ?, ?, 7)`,
  ).run(IDS.caseA, IDS.applicantA, IDS.programCycle, IDS.ruleVersion, STAMP, STAMP);
  database.prepare(
    `INSERT INTO jobs (
      id, job_type, payload_json, state, unique_key, attempts, max_attempts, available_at,
      lease_owner, lease_until, last_error_code, created_at, completed_at
    ) VALUES (?, 'ai_draft', ?, 'queued', 'unique-secret', 0, 5, ?, 'lease-secret', ?, 'error-secret', ?, NULL)`,
  ).run(IDS.jobA, JSON.stringify({ caseId: IDS.caseA, originalPrompt: 'sensitive prompt' }), STAMP, STAMP, STAMP);
}

function context(name: 'caseId' | 'jobId', value: string): { params: Promise<Record<typeof name, string>> } {
  return { params: Promise.resolve({ [name]: value } as Record<typeof name, string>) };
}

describe('public owned-resource route entrypoints', () => {
  let directory: string;
  let database: Database.Database;
  let applicantAToken: string;
  let applicantBToken: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-owned-route-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    seed(database);
    const crypto = createCrypto();
    const ids = createIds();
    const sessionService = new SessionService({
      repository: createSessionRepository(database),
      clock: () => new Date(STAMP),
      idGenerator: ids,
      tokenFactory: createTokens(),
      ipHasher: (value) => crypto.hmacLookup(value, 'session-ip'),
    });
    applicantAToken = sessionService.issueApplicant({ applicantId: IDS.applicantA, createdIp: '198.51.100.10' }).sessionToken;
    applicantBToken = sessionService.issueApplicant({ applicantId: IDS.applicantB, createdIp: '198.51.100.11' }).sessionToken;
    configurePublicRuntime({
      database,
      crypto,
      lineSessions: createLineSessionService({
        database,
        crypto,
        sessionService,
        lineLoginClient: {
          verifyIdToken: async () => ({
            subject: 'route-subject-sentinel',
            audience: 'channel',
            issuer: 'https://access.line.me',
            expiresAt: '2026-08-30T00:01:00.000Z',
          }),
        },
        publicOrigin: ORIGIN,
        allowInsecureLoopbackTest: true,
        clock: () => new Date(STAMP),
        idGenerator: ids,
        tokenFactory: createTokens(),
        clientIpResolver: () => '198.51.100.11',
        requestIdGenerator: () => 'request-owned-route',
      }),
      publicOrigin: ORIGIN,
      requestIdGenerator: () => 'request-owned-route',
      clock: () => new Date(STAMP),
    });
  });

  afterEach(() => {
    clearPublicRuntime();
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('serves owner-scoped case and job DTOs with no worker internals', async () => {
    const caseResponse = await getCase(
      new Request(`${ORIGIN}/api/v1/cases/${IDS.caseA}`, { headers: { cookie: `flowpass_session=${applicantAToken}` } }),
      context('caseId', IDS.caseA),
    );
    const jobResponse = await getJob(
      new Request(`${ORIGIN}/api/v1/jobs/${IDS.jobA}`, { headers: { cookie: `flowpass_session=${applicantAToken}` } }),
      context('jobId', IDS.jobA),
    );

    expect(caseResponse.status).toBe(200);
    expect(caseResponse.headers.get('etag')).toBe('"7"');
    await expect(caseResponse.json()).resolves.toMatchObject({ data: { id: IDS.caseA, caseCode: 'CASE-A' } });
    expect(jobResponse.status).toBe(200);
    const jobBody = await jobResponse.json();
    expect(jobBody).toMatchObject({ data: { id: IDS.jobA, state: 'queued' } });
    expect(JSON.stringify(jobBody)).not.toMatch(/payload|lease|error|unique|prompt|caseId/i);
  });

  it('turns both foreign and absent resources into the same public 404', async () => {
    const foreignCase = await getCase(
      new Request(`${ORIGIN}/api/v1/cases/${IDS.caseA}`, { headers: { cookie: `flowpass_session=${applicantBToken}` } }),
      context('caseId', IDS.caseA),
    );
    const absentCase = await getCase(
      new Request(`${ORIGIN}/api/v1/cases/${IDS.missing}`, { headers: { cookie: `flowpass_session=${applicantBToken}` } }),
      context('caseId', IDS.missing),
    );
    const foreignJob = await getJob(
      new Request(`${ORIGIN}/api/v1/jobs/${IDS.jobA}`, { headers: { cookie: `flowpass_session=${applicantBToken}` } }),
      context('jobId', IDS.jobA),
    );
    const absentJob = await getJob(
      new Request(`${ORIGIN}/api/v1/jobs/${IDS.missing}`, { headers: { cookie: `flowpass_session=${applicantBToken}` } }),
      context('jobId', IDS.missing),
    );

    for (const response of [foreignCase, absentCase, foreignJob, absentJob]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('etag')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('does not treat an admin cookie or authorization header as public applicant authentication', async () => {
    const adminCookie = await getCase(
      new Request(`${ORIGIN}/api/v1/cases/${IDS.caseA}`, { headers: { cookie: 'flowpass_admin_session=admin-secret' } }),
      context('caseId', IDS.caseA),
    );
    const authorizationHeader = await getJob(
      new Request(`${ORIGIN}/api/v1/jobs/${IDS.jobA}`, { headers: { authorization: 'Bearer admin-secret' } }),
      context('jobId', IDS.jobA),
    );

    expect(adminCookie.status).toBe(401);
    expect(authorizationHeader.status).toBe(401);
  });
});
