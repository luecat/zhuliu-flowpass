import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/connection';
import { migrateDatabase } from '../server/db/migrate';
import { getDocumentForApplicant } from '../server/db/repositories/documents';
import { getCaseTaskForApplicant } from '../server/db/repositories/tasks';
import { createPublicRouteHandlers } from '../server/public/public-routes';
import { FieldCrypto } from '../server/crypto/field-crypto';
import { encryptDatabaseText } from '../server/db/repositories/encrypted-fields';

const STAMP = '2026-08-30T00:00:00.000Z';
/** Draft cases are cleared once idle past the TTL, so this fixture keeps CASE-A freshly touched. */
const FRESH_STAMP = new Date().toISOString();
const IDS = {
  applicantA: '0198f051-0000-7000-8000-000000000001',
  applicantB: '0198f051-0000-7000-8000-000000000002',
  programCycle: '0198f051-0000-7000-8000-000000000003',
  ruleVersion: '0198f051-0000-7000-8000-000000000004',
  caseA: '0198f051-0000-7000-8000-000000000005',
  documentA: '0198f051-0000-7000-8000-000000000006',
  taskA: '0198f051-0000-7000-8000-000000000007',
  jobA: '0198f051-0000-7000-8000-000000000008',
};

function seed(database: Database.Database, crypto: FieldCrypto): void {
  for (const applicant of [IDS.applicantA, IDS.applicantB]) {
    database.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, 'active', ?, ?, 1)`,
    ).run(applicant, 'sealed', STAMP, STAMP);
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
  ).run(IDS.caseA, IDS.applicantA, IDS.programCycle, IDS.ruleVersion, STAMP, FRESH_STAMP);
  const answerVersion = '0198f051-0000-7000-8000-000000000009';
  const answerText = JSON.stringify({ material: '照片', aiPurpose: '整理', sensitiveData: '姓名', destinationAndAudience: '團隊雲端', requestedTool: 'ChatGPT', retentionDuration: '保留 30 天', applicantName: '測試申請人' });
  database.prepare(
    `INSERT INTO answer_versions (
      id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at
    ) VALUES (?, ?, 1, ?, 'answer-hash', ?, ?)`,
  ).run(answerVersion, IDS.caseA, encryptDatabaseText(crypto, 'answer_versions', 'answers_enc', answerVersion, answerText), IDS.applicantA, STAMP);
  database.prepare('UPDATE cases SET current_answer_version_id = ? WHERE id = ?').run(answerVersion, IDS.caseA);
  database.prepare(
    `INSERT INTO documents (
      id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size,
      original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version
    ) VALUES (?, ?, 'invoice', 'storage-secret', 'key-secret', 'hash-secret', 'application/pdf', 10,
      'name-secret', 'ready', 'applicant', ?, ?, 1)`,
  ).run(IDS.documentA, IDS.caseA, IDS.applicantA, STAMP);
  database.prepare(
    `INSERT INTO case_tasks (
      id, case_id, task_type, title, instructions_enc, accepted_document_types_json, status,
      created_by_type, created_by_id, created_at, row_version
    ) VALUES (?, ?, 'provide_document', 'Upload', 'instructions-secret', '[]', 'open', 'system', 'worker', ?, 1)`,
  ).run(IDS.taskA, IDS.caseA, STAMP);
  database.prepare(
    `INSERT INTO jobs (
      id, job_type, payload_json, state, unique_key, attempts, max_attempts, available_at,
      lease_owner, lease_until, last_error_code, created_at, completed_at
    ) VALUES (?, 'ai_draft', ?, 'queued', 'unique-secret', 0, 5, ?, 'lease-secret', ?, 'error-secret', ?, NULL)`,
  ).run(IDS.jobA, JSON.stringify({ caseId: IDS.caseA, originalPrompt: 'sensitive prompt' }), STAMP, STAMP, STAMP);
}

function request(cookie: string): Request {
  return new Request('https://flowpass.luecat.com/api/v1/cases/example', {
    headers: { cookie },
  });
}

describe('public applicant authorization boundary', () => {
  let directory: string;
  let database: Database.Database;
  let handlers: ReturnType<typeof createPublicRouteHandlers>;
  let crypto: FieldCrypto;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-authorization-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    crypto = new FieldCrypto({ activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x34) : undefined });
    seed(database, crypto);
    handlers = createPublicRouteHandlers({
      database,
      crypto,
      sessionReader: {
        authenticateApplicant(value) {
          if (value === 'session-a') return { sessionId: 'session-a', applicantId: IDS.applicantA };
          if (value === 'session-b') return { sessionId: 'session-b', applicantId: IDS.applicantB };
          return null;
        },
      },
      requestIdGenerator: () => 'request-id',
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('returns owner-safe case and job projections with an ETag', async () => {
    const caseResponse = await handlers.getCase(request('flowpass_session=session-a'), IDS.caseA);
    const jobResponse = await handlers.getJob(request('flowpass_session=session-a'), IDS.jobA);

    expect(caseResponse.status).toBe(200);
    expect(caseResponse.headers.get('etag')).toBe('"7"');
    expect(await caseResponse.json()).toMatchObject({ data: { id: IDS.caseA, caseCode: 'CASE-A', answers: { material: '照片', aiPurpose: '整理' } } });
    expect(jobResponse.status).toBe(200);
    const jobBody = await jobResponse.json();
    expect(jobBody).toMatchObject({ data: { id: IDS.jobA, state: 'queued' } });
    // Word-bounded so the applicant-facing `errorCode` field (e.g. "AI_INPUT_INVALID",
    // read by the wizard to show tailored failure copy) doesn't false-positive on "error".
    expect(JSON.stringify(jobBody)).not.toMatch(/\b(payload|lease|error|unique|prompt|caseId)\b/i);
  });

  it('answers an idle draft with DRAFT_EXPIRED so the applicant is sent back to re-fill', async () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    database.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(stale, IDS.caseA);

    const response = await handlers.getCase(request('flowpass_session=session-a'), IDS.caseA);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'DRAFT_EXPIRED' } });
  });

  it('still hides a foreign expired draft behind the generic 404', async () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    database.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(stale, IDS.caseA);

    const response = await handlers.getCase(request('flowpass_session=session-b'), IDS.caseA);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not expose unsubmitted cases through the applicant record list', async () => {
    const response = await handlers.listCases(request('flowpass_session=session-a'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { cases: [] } });
    const foreign = await handlers.listCases(request('flowpass_session=session-b'));
    await expect(foreign.json()).resolves.toMatchObject({ data: { cases: [] } });
  });

  it('makes foreign and absent case/job resources indistinguishable as a public 404', async () => {
    const foreignCase = await handlers.getCase(request('flowpass_session=session-b'), IDS.caseA);
    const absentCase = await handlers.getCase(request('flowpass_session=session-b'), '0198f051-0000-7000-8000-000000000099');
    const foreignJob = await handlers.getJob(request('flowpass_session=session-b'), IDS.jobA);
    const absentJob = await handlers.getJob(request('flowpass_session=session-b'), '0198f051-0000-7000-8000-000000000099');

    for (const response of [foreignCase, absentCase, foreignJob, absentJob]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('etag')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('does not accept an admin cookie or authorization header as an applicant credential', async () => {
    const adminCookie = await handlers.getCase(request('flowpass_admin_session=admin-secret'), IDS.caseA);
    const header = await handlers.getCase(
      new Request('https://flowpass.luecat.com/api/v1/cases/example', {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      IDS.caseA,
    );

    expect(adminCookie.status).toBe(401);
    expect(header.status).toBe(401);
  });

  it('keeps existing document/task scoped queries null for a foreign applicant before future handlers decrypt anything', () => {
    expect(getDocumentForApplicant(database, { applicantId: IDS.applicantB }, IDS.documentA)).toBeNull();
    expect(getCaseTaskForApplicant(database, { applicantId: IDS.applicantB }, crypto, IDS.taskA)).toBeNull();
  });
});
