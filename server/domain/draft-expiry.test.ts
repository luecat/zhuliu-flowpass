import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { DRAFT_IDLE_TTL_MS, expireDraftCaseIfStale, expireStaleDrafts } from './draft-expiry';

const IDS = {
  applicant: '0198f050-0000-7000-8000-000000000001',
  cycle: '0198f050-0000-7000-8000-000000000002',
  rule: '0198f050-0000-7000-8000-000000000003',
  draft: '0198f050-0000-7000-8000-000000000010',
  fresh: '0198f050-0000-7000-8000-000000000011',
  submitted: '0198f050-0000-7000-8000-000000000012',
};
const NOW = '2026-08-30T01:00:00.000Z';

describe('draft expiry', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-draft-expiry-'));
    db = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(db);
    db.prepare('INSERT INTO applicants (id,display_label_enc,status,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?)')
      .run(IDS.applicant, 'enc', 'active', NOW, NOW, 1);
    db.prepare('INSERT INTO program_cycles (id,code,name,year,status,retention_policy_json,created_at,updated_at,row_version) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(IDS.cycle, 'DEMO', '示範', 2026, 'active', '{}', NOW, NOW, 1);
    db.prepare('INSERT INTO program_rule_versions (id,program_cycle_id,version_no,status,application_start_at,application_end_at,purchase_start_at,purchase_end_at,subsidy_rate_bps,per_case_cap_twd,rounding_mode,required_documents_json,rules_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(IDS.rule, IDS.cycle, 1, 'published', NOW, '2026-12-31T00:00:00.000Z', NOW, '2026-12-31T00:00:00.000Z', 5000, 10000, 'floor', '[]', '{}', NOW, NOW);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertCase(id: string, state: string, updatedAt: string) {
    db.prepare(`INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(id, `FP-${id.slice(-8)}`, IDS.applicant, IDS.cycle, IDS.rule, state, updatedAt, updatedAt);
  }

  it('soft-deletes drafts idle longer than 30 minutes and leaves fresh or submitted cases', () => {
    const staleAt = new Date(new Date(NOW).getTime() - DRAFT_IDLE_TTL_MS - 1_000).toISOString();
    insertCase(IDS.draft, 'draft', staleAt);
    insertCase(IDS.fresh, 'draft', NOW);
    insertCase(IDS.submitted, 'submitted', staleAt);

    const result = expireStaleDrafts(db, new Date(NOW));
    expect(result.expiredCount).toBe(1);
    expect((db.prepare('SELECT deleted_at FROM cases WHERE id = ?').get(IDS.draft) as { deleted_at: string | null }).deleted_at).toBe(NOW);
    expect((db.prepare('SELECT deleted_at FROM cases WHERE id = ?').get(IDS.fresh) as { deleted_at: string | null }).deleted_at).toBeNull();
    expect((db.prepare('SELECT deleted_at FROM cases WHERE id = ?').get(IDS.submitted) as { deleted_at: string | null }).deleted_at).toBeNull();
  });

  it('expires a single stale draft case on demand', () => {
    const staleAt = new Date(new Date(NOW).getTime() - DRAFT_IDLE_TTL_MS - 1_000).toISOString();
    insertCase(IDS.draft, 'draft', staleAt);
    expect(expireDraftCaseIfStale(db, IDS.draft, new Date(NOW))).toBe(true);
    expect(expireDraftCaseIfStale(db, IDS.draft, new Date(NOW))).toBe(false);
  });
});
