import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../connection';
import { migrateDatabase } from '../migrate';
import { getCaseForApplicant } from './cases';
import { getDocumentForApplicant } from './documents';
import { listAiRunsForApplicant } from './ai-runs';
import { getPassportForApplicant, listPassportVersionsForApplicant } from './passports';
import { listRuleEvaluationsForApplicant } from './rules';
import { getCaseTaskForApplicant } from './tasks';
import { listTimelineForApplicant } from './timeline';

const STAMP = '2026-08-30T00:00:00.000Z';
const IDS = {
  applicantA: '0198f015-0000-7000-8000-000000000201',
  applicantB: '0198f015-0000-7000-8000-000000000202',
  programCycle: '0198f015-0000-7000-8000-000000000203',
  ruleVersion: '0198f015-0000-7000-8000-000000000204',
  case: '0198f015-0000-7000-8000-000000000205',
  answerVersion: '0198f015-0000-7000-8000-000000000206',
  passport: '0198f015-0000-7000-8000-000000000207',
  passportVersion: '0198f015-0000-7000-8000-000000000208',
  document: '0198f015-0000-7000-8000-000000000209',
  task: '0198f015-0000-7000-8000-000000000210',
  timeline: '0198f015-0000-7000-8000-000000000211',
  ruleEvaluation: '0198f015-0000-7000-8000-000000000212',
  aiRun: '0198f015-0000-7000-8000-000000000213',
};

function seedApplicantCase(db: Database.Database): void {
  db.prepare(
    `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(IDS.applicantA, 'enc:a', 'active', STAMP, STAMP, 1);
  db.prepare(
    `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(IDS.applicantB, 'enc:b', 'active', STAMP, STAMP, 1);
  db.prepare(
    `INSERT INTO program_cycles (
      id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(IDS.programCycle, 'CYCLE-A', 'FlowPass', 2026, 'active', '{}', STAMP, STAMP, 1);
  db.prepare(
    `INSERT INTO program_rule_versions (
      id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd,
      rounding_mode, required_documents_json, rules_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(IDS.ruleVersion, IDS.programCycle, 1, 'draft', 5000, 10_000, 'floor', '[]', '{}', STAMP);
  db.prepare(
    `INSERT INTO cases (
      id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state,
      created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(IDS.case, 'CASE-A', IDS.applicantA, IDS.programCycle, IDS.ruleVersion, 'draft', STAMP, STAMP, 1);
  db.prepare(
    `INSERT INTO answer_versions (
      id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(IDS.answerVersion, IDS.case, 1, 'enc:answers', 'answers-hash', IDS.applicantA, STAMP);
  db.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(
    IDS.passport,
    IDS.case,
    STAMP,
  );
  db.prepare(
    `INSERT INTO passport_versions (
      id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id,
      program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.passportVersion,
    IDS.passport,
    1,
    'ai_draft',
    'confirmed',
    'v1',
    IDS.answerVersion,
    IDS.ruleVersion,
    'enc:passport',
    'passport-hash',
    'system',
    'worker-a',
    STAMP,
  );
  db.prepare(
    `INSERT INTO documents (
      id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size,
      original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.document,
    IDS.case,
    'invoice',
    'storage-a',
    'key-a',
    'document-hash',
    'application/pdf',
    10,
    'enc:file-name',
    'ready',
    'applicant',
    IDS.applicantA,
    STAMP,
    1,
  );
  db.prepare(
    `INSERT INTO case_tasks (
      id, case_id, task_type, title, instructions_enc, accepted_document_types_json,
      status, created_by_type, created_by_id, created_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.task,
    IDS.case,
    'provide_document',
    'Upload an invoice',
    'enc:instructions',
    '[]',
    'open',
    'system',
    'worker-a',
    STAMP,
    1,
  );
  db.prepare(
    `INSERT INTO timeline_events (
      id, case_id, sequence_no, passport_version_id, event_type, public_summary,
      public_data_json, actor_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.timeline,
    IDS.case,
    1,
    IDS.passportVersion,
    'passport.confirmed',
    'Passport confirmed',
    '{}',
    'applicant',
    STAMP,
  );
  db.prepare(
    `INSERT INTO rule_evaluations (
      id, case_id, passport_version_id, document_id, program_rule_version_id, evaluation_kind,
      outcome, result_json, input_snapshot_hash, actor_type, actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.ruleEvaluation,
    IDS.case,
    IDS.passportVersion,
    IDS.document,
    IDS.ruleVersion,
    'submission',
    'pass',
    '{"internal":"raw result"}',
    'rule-input-hash',
    'system',
    'worker-a',
    STAMP,
  );
  db.prepare(
    `INSERT INTO ai_runs (
      id, case_id, passport_version_id, operation, adapter, model_id, prompt_version,
      schema_version, input_hash, output_hash, input_tokens, output_tokens, duration_ms,
      result_code, repair_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    IDS.aiRun,
    IDS.case,
    IDS.passportVersion,
    'draft',
    'lm_studio',
    'local-model',
    'v1',
    'v1',
    'ai-input-hash',
    'ai-output-hash',
    1,
    2,
    3,
    'success',
    0,
    STAMP,
  );
}

describe('applicant-owned repository reads', () => {
  let directory: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-owned-repository-'));
    db = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(db);
    seedApplicantCase(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('returns passport, document, task, and timeline data only to the case owner', () => {
    const owner = { applicantId: IDS.applicantA };
    const stranger = { applicantId: IDS.applicantB };

    expect(getPassportForApplicant(db, owner, IDS.case)).toMatchObject({ id: IDS.passport });
    expect(getPassportForApplicant(db, stranger, IDS.case)).toBeNull();
    expect(getDocumentForApplicant(db, owner, IDS.document)).toMatchObject({ id: IDS.document });
    expect(getDocumentForApplicant(db, stranger, IDS.document)).toBeNull();
    expect(getCaseTaskForApplicant(db, owner, IDS.task)).toMatchObject({ id: IDS.task });
    expect(getCaseTaskForApplicant(db, stranger, IDS.task)).toBeNull();
    expect(listTimelineForApplicant(db, owner, IDS.case)).toHaveLength(1);
    expect(listTimelineForApplicant(db, stranger, IDS.case)).toEqual([]);
  });

  it('does not expose encrypted, storage, hash, or internal workflow fields to applicants', () => {
    const owner = { applicantId: IDS.applicantA };
    const caseRecord = getCaseForApplicant(db, owner, IDS.case);
    const passportVersions = listPassportVersionsForApplicant(db, owner, IDS.case);
    const document = getDocumentForApplicant(db, owner, IDS.document);
    const task = getCaseTaskForApplicant(db, owner, IDS.task);
    const evaluations = listRuleEvaluationsForApplicant(db, owner, IDS.case);
    const aiRuns = listAiRunsForApplicant(db, owner, IDS.case);

    expect(caseRecord).not.toBeNull();
    expect(passportVersions).toHaveLength(1);
    expect(document).not.toBeNull();
    expect(task).not.toBeNull();
    expect(evaluations).toHaveLength(1);
    expect(aiRuns).toHaveLength(1);
    expect(caseRecord).not.toHaveProperty('titleEnc');
    expect(caseRecord).not.toHaveProperty('decisionReasonEnc');
    expect(passportVersions[0]).not.toHaveProperty('payloadEnc');
    expect(passportVersions[0]).not.toHaveProperty('contentSha256');
    expect(passportVersions[0]).not.toHaveProperty('createdById');
    expect(document).not.toHaveProperty('storageId');
    expect(document).not.toHaveProperty('keyId');
    expect(document).not.toHaveProperty('contentSha256');
    expect(document).not.toHaveProperty('originalNameEnc');
    expect(task).not.toHaveProperty('instructionsEnc');
    expect(evaluations[0]).not.toHaveProperty('resultJson');
    expect(evaluations[0]).not.toHaveProperty('inputSnapshotHash');
    expect(evaluations[0]).not.toHaveProperty('actorId');
    expect(aiRuns[0]).not.toHaveProperty('inputHash');
    expect(aiRuns[0]).not.toHaveProperty('outputHash');
    expect(aiRuns[0]).not.toHaveProperty('modelId');
    expect(aiRuns[0]).not.toHaveProperty('inputTokens');
  });
});
