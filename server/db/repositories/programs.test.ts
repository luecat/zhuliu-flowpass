import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { openDatabase } from '../connection';
import { migrateDatabase } from '../migrate';
import {
  createDraftProgramRuleVersionForAdmin,
  publishProgramRuleVersionForAdmin,
} from './programs';

const NOW = '2026-08-30T00:00:00.000Z';
const CYCLE_ID = '0198f050-0000-7000-8000-000000000010';
const RULE_ID = '0198f050-0000-7000-8000-000000000011';
const ADMIN_ID = '0198f050-0000-7000-8000-000000000012';

describe('program rule editor repository', () => {
  let database: ReturnType<typeof openDatabase>;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-program-editor-'));
    database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    database.prepare('INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(ADMIN_ID, 'editor', 'hash', 'active', NOW, 1);
    database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(CYCLE_ID, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, published_by_admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(RULE_ID, CYCLE_ID, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '["invoice"]', '{"kind":"original"}', NOW, ADMIN_ID, NOW);
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new draft when editing a published version and publishes only the draft', () => {
    const draft = createDraftProgramRuleVersionForAdmin(database, { adminId: ADMIN_ID }, {
      sourceRuleVersionId: RULE_ID,
      id: uuidv7(),
      createdAt: NOW,
      perCaseCapTwd: 12000,
      rulesJson: '{"kind":"edited"}',
    });
    expect(draft).toMatchObject({ versionNo: 2, status: 'draft', perCaseCapTwd: 12000, rulesJson: '{"kind":"edited"}' });
    expect(database.prepare('SELECT status, per_case_cap_twd, rules_json FROM program_rule_versions WHERE id = ?').get(RULE_ID)).toMatchObject({ status: 'published', per_case_cap_twd: 10000, rules_json: '{"kind":"original"}' });
    const published = publishProgramRuleVersionForAdmin(database, { adminId: ADMIN_ID }, {
      ruleVersionId: draft.id,
      adminId: ADMIN_ID,
      publishedAt: NOW,
    });
    expect(published).toMatchObject({ id: draft.id, status: 'published', publishedByAdminId: ADMIN_ID });
    expect(database.prepare('SELECT COUNT(*) AS count FROM program_rule_versions WHERE program_cycle_id = ? AND status = \'published\'').get(CYCLE_ID)).toMatchObject({ count: 2 });
  });

  it('does not permit any update to a published rule version', () => {
    expect(() => database.prepare('UPDATE program_rule_versions SET rules_json = ? WHERE id = ?').run('{}', RULE_ID)).toThrow('published program_rule_versions are immutable');
  });
});
