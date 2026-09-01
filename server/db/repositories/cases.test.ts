import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../connection';
import { migrateDatabase } from '../migrate';
import { getCaseForAdmin, getCaseForApplicant, listCasesForApplicant } from './cases';

const STAMP = '2026-08-30T00:00:00.000Z';
const IDS = {
  applicantA: '0198f015-0000-7000-8000-000000000101',
  applicantB: '0198f015-0000-7000-8000-000000000102',
  programCycle: '0198f015-0000-7000-8000-000000000103',
  ruleVersion: '0198f015-0000-7000-8000-000000000104',
  case: '0198f015-0000-7000-8000-000000000105',
};

function insertCase(db: Database.Database): void {
  db.prepare(
    `INSERT INTO program_cycles (
      id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(IDS.programCycle, 'CYCLE-CASE-A', 'FlowPass', 2026, 'active', '{}', STAMP, STAMP, 1);
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
}

describe('case repository authorization scopes', () => {
  let directory: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-case-repository-'));
    db = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(db);

    db.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(IDS.applicantA, 'enc:a', 'active', STAMP, STAMP, 1);
    db.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(IDS.applicantB, 'enc:b', 'active', STAMP, STAMP, 1);
    insertCase(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('returns a case only when the applicant scope owns it', () => {
    expect(getCaseForApplicant(db, { applicantId: IDS.applicantA }, IDS.case)).toMatchObject({
      id: IDS.case,
      caseCode: 'CASE-A',
    });
    expect(getCaseForApplicant(db, { applicantId: IDS.applicantB }, IDS.case)).toBeNull();
  });

  it('lists only cases owned by the applicant scope', () => {
    db.prepare("UPDATE cases SET state = 'submitted' WHERE id = ?").run(IDS.case);
    expect(listCasesForApplicant(db, { applicantId: IDS.applicantA })).toHaveLength(1);
    expect(listCasesForApplicant(db, { applicantId: IDS.applicantB })).toEqual([]);
  });

  it('does not list an unsubmitted case as an application record', () => {
    expect(listCasesForApplicant(db, { applicantId: IDS.applicantA })).toEqual([]);
  });

  it('does not expose a soft-deleted case to applicants or admins', () => {
    db.prepare('UPDATE cases SET deleted_at = ? WHERE id = ?').run('2026-09-01T04:16:00.000Z', IDS.case);

    expect(getCaseForApplicant(db, { applicantId: IDS.applicantA }, IDS.case)).toBeNull();
    expect(listCasesForApplicant(db, { applicantId: IDS.applicantA })).toEqual([]);
    expect(getCaseForAdmin(db, { adminId: 'admin-1' }, IDS.case)).toBeNull();
  });

  it('requires an admin scope before returning a case to an admin workflow', () => {
    expect(getCaseForAdmin(db, { adminId: 'admin-1' }, IDS.case)).toMatchObject({ id: IDS.case });
    expect(() => getCaseForAdmin(db, { adminId: '' }, IDS.case)).toThrow('admin scope is required');
  });
});
