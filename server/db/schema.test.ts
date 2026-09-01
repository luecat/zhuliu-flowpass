import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection';
import { migrateDatabase } from './migrate';

const STAMP = '2026-08-30T00:00:00.000Z';

function isAtLeastSqliteVersion(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let index = 0; index < minimumParts.length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;

    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }

  return true;
}

function insertCaseGraph(db: Database.Database) {
  const ids = {
    applicant: '0198f015-0000-7000-8000-000000000001',
    programCycle: '0198f015-0000-7000-8000-000000000002',
    ruleVersion: '0198f015-0000-7000-8000-000000000003',
    case: '0198f015-0000-7000-8000-000000000004',
    answerVersion: '0198f015-0000-7000-8000-000000000005',
    passport: '0198f015-0000-7000-8000-000000000006',
    passportVersion: '0198f015-0000-7000-8000-000000000007',
  };

  db.prepare(
    `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ids.applicant, 'enc:applicant', 'active', STAMP, STAMP, 1);

  db.prepare(
    `INSERT INTO program_cycles (
      id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids.programCycle,
    'FLOWPASS-2026',
    'FlowPass 2026',
    2026,
    'active',
    '{}',
    STAMP,
    STAMP,
    1,
  );

  db.prepare(
    `INSERT INTO program_rule_versions (
      id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd,
      rounding_mode, required_documents_json, rules_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids.ruleVersion,
    ids.programCycle,
    1,
    'draft',
    5000,
    10000,
    'floor',
    '[]',
    '{}',
    STAMP,
  );

  db.prepare(
    `INSERT INTO cases (
      id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state,
      created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids.case,
    'CASE-2026-0001',
    ids.applicant,
    ids.programCycle,
    ids.ruleVersion,
    'draft',
    STAMP,
    STAMP,
    1,
  );

  db.prepare(
    `INSERT INTO answer_versions (
      id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids.answerVersion,
    ids.case,
    1,
    'enc:answers',
    'answer-sha-256',
    ids.applicant,
    STAMP,
  );

  db.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(
    ids.passport,
    ids.case,
    STAMP,
  );

  db.prepare(
    `INSERT INTO passport_versions (
      id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id,
      program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids.passportVersion,
    ids.passport,
    1,
    'ai_draft',
    'ai_drafting',
    'v1',
    ids.answerVersion,
    ids.ruleVersion,
    'enc:passport',
    'passport-sha-256',
    'system',
    'worker-1',
    STAMP,
  );

  return ids;
}

describe('FlowPass SQLite schema', () => {
  let databaseDirectory: string;
  let db: Database.Database;

  beforeEach(() => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'flowpass-schema-'));
    db = openDatabase(join(databaseDirectory, 'flowpass.sqlite'));
    migrateDatabase(db);
  });

  afterEach(() => {
    db.close();
    rmSync(databaseDirectory, { force: true, recursive: true });
  });

  it('configures a durable SQLite connection and applies the current migrations', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5_000);

    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    expect(isAtLeastSqliteVersion(version.version, '3.51.3')).toBe(true);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toEqual([
      { name: '001_core.sql' },
      { name: '002_indexes_and_guards.sql' },
      { name: '003_ocr_raw_payloads.sql' },
      { name: '004_admin_security.sql' },
      { name: '005_attachment_details.sql' },
      { name: '006_disbursed_amount.sql' },
      { name: '007_soft_deleted_cases.sql' },
      { name: '008_production_program_name.sql' },
      { name: '009_admin_data_management.sql' },
    ]);
  });

  it('renames a legacy demo program without mutating its published rule', () => {
    const cycleId = '0198f015-0000-7000-8000-000000000091';
    const ruleId = '0198f015-0000-7000-8000-000000000092';
    db.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, 'DEMO-20260831', 'FlowPass 示範申請', 2026, 'active', '{}', ?, ?, 1)`).run(cycleId, STAMP, STAMP);
    db.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, 'published', 5000, 10000, 'floor', '[]', '{"demo":true}', ?, ?)`).run(ruleId, cycleId, STAMP, STAMP);

    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'migrations/008_production_program_name.sql'), 'utf8'));

    expect(db.prepare('SELECT code, name FROM program_cycles WHERE id = ?').get(cycleId)).toEqual({ code: 'SOFTWARE-SUBSIDY-2026', name: '軟體補助申請' });
    expect(db.prepare('SELECT rules_json FROM program_rule_versions WHERE id = ?').get(ruleId)).toEqual({ rules_json: '{"demo":true}' });
  });

  it('rejects nullable, non-v7, non-canonical, and upper-case entity IDs', () => {
    const insertApplicant = db.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    expect(() => insertApplicant.run(null, 'enc:null-1', 'active', STAMP, STAMP, 1)).toThrow();
    expect(() => insertApplicant.run(null, 'enc:null-2', 'active', STAMP, STAMP, 1)).toThrow();
    expect(() =>
      insertApplicant.run('0198f015-0000-6000-8000-000000000001', 'enc:v6', 'active', STAMP, STAMP, 1),
    ).toThrow();
    expect(() =>
      insertApplicant.run('0198f015-0000-7000-c000-000000000001', 'enc:variant', 'active', STAMP, STAMP, 1),
    ).toThrow();
    expect(() =>
      insertApplicant.run('0198F015-0000-7000-8000-000000000001', 'enc:upper', 'active', STAMP, STAMP, 1),
    ).toThrow();
    expect(() =>
      insertApplicant.run(
        '0198f015-0000-7000-8000-00000000000-',
        'enc:extra-hyphen',
        'active',
        STAMP,
        STAMP,
        1,
      ),
    ).toThrow();
    expect(() =>
      insertApplicant.run(
        '0198f015-0000-7000-8000-000000000001\0suffix',
        'enc:nul-suffix',
        'active',
        STAMP,
        STAMP,
        1,
      ),
    ).toThrow();
    expect(() =>
      insertApplicant.run('0198f015-0000-7000-8000-000000000001', 'enc:valid', 'active', STAMP, STAMP, 1),
    ).not.toThrow();
  });

  it('applies the canonical UUIDv7 constraint to every business entity ID', () => {
    const entityTables = [
      'applicants',
      'line_identities',
      'login_exchange_nonces',
      'applicant_sessions',
      'admin_users',
      'admin_sessions',
      'program_cycles',
      'program_rule_versions',
      'cases',
      'answer_versions',
      'case_state_transitions',
      'passports',
      'passport_versions',
      'passport_node_index',
      'passport_edge_index',
      'passport_tool_index',
      'passport_follow_up_questions',
      'passport_follow_up_answers',
      'passport_confirmations',
      'documents',
      'ocr_runs',
      'document_fields',
      'document_field_reviews',
      'invoice_fingerprints',
      'rule_evaluations',
      'subsidy_calculations',
      'jobs',
      'case_tasks',
      'notification_jobs',
      'line_webhook_events',
      'tool_products',
      'tool_versions',
      'security_incidents',
      'incident_matches',
      'alerts',
      'timeline_events',
      'audit_logs',
      'ai_runs',
    ];
    const tables = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${entityTables.map(() => '?').join(', ')})`)
      .all(...entityTables) as Array<{ name: string; sql: string }>;

    expect(tables).toHaveLength(entityTables.length);
    for (const table of tables) {
      const idColumn = (db.pragma(`table_info(${table.name})`) as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>).find((column) => column.name === 'id');

      expect(idColumn, table.name).toMatchObject({ notnull: 1, pk: 1 });
      expect(table.sql, table.name).toContain('id TEXT NOT NULL PRIMARY KEY CHECK');
      expect(table.sql, table.name).toContain('length(id) = 36');
      expect(table.sql, table.name).toContain('length(CAST(id AS BLOB)) = 36');
      expect(table.sql, table.name).toContain('id = lower(id)');
      expect(table.sql, table.name).toContain("id GLOB '????????-????-7???-[89ab]???-????????????'");
      expect(table.sql, table.name).toContain("id NOT GLOB '*[^0-9a-f-]*'");
      expect(table.sql, table.name).toContain("length(replace(id, '-', '')) = 32");
    }
  });

  it('stores only canonical UTC RFC3339 timestamps, including nullable timestamp columns', () => {
    const insertApplicant = db.prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const [id, invalidTimestamp] of [
      ['0198f015-0000-7000-8000-000000000020', '2026-08-30'],
      ['0198f015-0000-7000-8000-000000000021', '2026-08-30 00:00:00'],
      ['0198f015-0000-7000-8000-000000000022', '2026-02-30T00:00:00.000Z'],
    ]) {
      expect(() => insertApplicant.run(id, `enc:${id}`, 'active', invalidTimestamp, STAMP, 1)).toThrow();
    }

    insertApplicant.run('0198f015-0000-7000-8000-000000000023', 'enc:timestamp', 'active', STAMP, STAMP, 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO line_identities (
            id, applicant_id, provider, line_subject_enc, line_subject_hmac, linked_at,
            unlinked_at, push_state, row_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '0198f015-0000-7000-8000-000000000024',
          '0198f015-0000-7000-8000-000000000023',
          'line',
          'enc:line-subject',
          'line-hmac-null',
          STAMP,
          null,
          'enabled',
          1,
        ),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO line_identities (
            id, applicant_id, provider, line_subject_enc, line_subject_hmac, linked_at,
            unlinked_at, push_state, row_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '0198f015-0000-7000-8000-000000000025',
          '0198f015-0000-7000-8000-000000000023',
          'line',
          'enc:line-subject',
          'line-hmac-invalid',
          STAMP,
          '2026-08-30T00:00:00+08:00',
          'enabled',
          1,
        ),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (
            id, job_type, payload_json, state, unique_key, attempts, max_attempts,
            available_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '0198f015-0000-7000-8000-000000000026',
          'ocr',
          '{}',
          'queued',
          'job-non-canonical-time',
          0,
          3,
          '2026-08-30T00:00:00+08:00',
          STAMP,
        ),
    ).toThrow();
    expect(() =>
      db
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run('non-canonical-timestamp.sql', '2026-08-30T00:00:00+08:00'),
    ).toThrow();
  });

  it('creates the full business catalog without inferred historical-pointer FKs', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      'admin_auth_events',
      'admin_data_edit_audits',
      'admin_data_mutation_guards',
      'admin_password_history',
      'admin_purge_authorizations',
      'admin_recovery_challenges',
      'admin_sessions',
      'admin_users',
      'ai_runs',
      'alerts',
      'answer_versions',
      'api_idempotency_keys',
      'applicant_sessions',
      'applicants',
      'audit_logs',
      'case_purchase_details',
      'case_state_transitions',
      'case_tasks',
      'cases',
      'document_field_reviews',
      'document_fields',
      'documents',
      'flowpass_maintenance_state',
      'incident_matches',
      'invoice_fingerprints',
      'jobs',
      'line_identities',
      'line_webhook_events',
      'login_exchange_nonces',
      'notification_jobs',
      'ocr_raw_payloads',
      'ocr_runs',
      'passport_confirmations',
      'passport_edge_index',
      'passport_follow_up_answers',
      'passport_follow_up_questions',
      'passport_node_index',
      'passport_tool_index',
      'passport_versions',
      'passports',
      'program_cycles',
      'program_rule_versions',
      'rate_limit_buckets',
      'rule_evaluations',
      'schema_migrations',
      'security_incidents',
      'subsidy_calculations',
      'timeline_events',
      'tool_products',
      'tool_versions',
    ]);

    const caseForeignKeys = db.pragma('foreign_key_list(cases)') as Array<{ from: string }>;
    expect(caseForeignKeys.map((foreignKey) => foreignKey.from).sort()).toEqual([
      'applicant_id',
      'program_cycle_id',
      'program_rule_version_id',
    ]);
    const documentFieldForeignKeys = db.pragma('foreign_key_list(document_fields)') as Array<{
      from: string;
    }>;
    expect(documentFieldForeignKeys.map((foreignKey) => foreignKey.from).sort()).toEqual([
      'document_id',
      'source_ocr_run_id',
    ]);

    const cascadeForeignKeys = ['applicant_sessions', 'admin_sessions', 'cases', 'documents']
      .flatMap((table) =>
        (db.pragma(`foreign_key_list(${table})`) as Array<{ from: string; on_delete: string }>).map(
          (foreignKey) => ({ table, from: foreignKey.from, onDelete: foreignKey.on_delete }),
        ),
      )
      .filter((foreignKey) => foreignKey.onDelete === 'CASCADE');
    expect(cascadeForeignKeys).toEqual([
      { table: 'applicant_sessions', from: 'applicant_id', onDelete: 'CASCADE' },
      { table: 'admin_sessions', from: 'admin_user_id', onDelete: 'CASCADE' },
    ]);
  });

  it('allows exactly one passport for a case', () => {
    const ids = insertCaseGraph(db);

    expect(() =>
      db
        .prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)')
        .run('0198f015-0000-7000-8000-000000000008', ids.case, STAMP),
    ).toThrow(/UNIQUE constraint failed: passports\.case_id/);
  });

  it('prevents updates and deletes of passport versions and audit logs', () => {
    const ids = insertCaseGraph(db);

    db.prepare(
      `INSERT INTO audit_logs (
        id, actor_type, actor_id, action, entity_type, entity_id, before_hash, after_hash,
        detail_enc, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '0198f015-0000-7000-8000-000000000009',
      'system',
      'worker-1',
      'case.created',
      'case',
      ids.case,
      'before',
      'after',
      'enc:detail',
      'request-1',
      STAMP,
    );

    expect(() =>
      db
        .prepare('UPDATE passport_versions SET workflow_state = ? WHERE id = ?')
        .run('confirmed', ids.passportVersion),
    ).toThrow('passport_versions are immutable');
    expect(() => db.prepare('DELETE FROM passport_versions WHERE id = ?').run(ids.passportVersion)).toThrow(
      'passport_versions are immutable',
    );
    expect(() => db.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('changed', '0198f015-0000-7000-8000-000000000009')).toThrow(
      'audit_logs are immutable',
    );
    expect(() => db.prepare('DELETE FROM audit_logs WHERE id = ?').run('0198f015-0000-7000-8000-000000000009')).toThrow(
      'audit_logs are immutable',
    );
  });

  it('keeps OCR observations immutable after they are recorded', () => {
    const ids = insertCaseGraph(db);
    const documentId = '0198f015-0000-7000-8000-000000000015';
    const ocrRunId = '0198f015-0000-7000-8000-000000000016';

    db.prepare(
      `INSERT INTO documents (
        id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size,
        original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      documentId,
      ids.case,
      'invoice',
      'storage-ocr',
      'key-ocr',
      'document-hash-ocr',
      'application/pdf',
      1,
      'enc:ocr.pdf',
      'processing',
      'system',
      'worker-1',
      STAMP,
      1,
    );
    db.prepare(
      `INSERT INTO ocr_runs (
        id, document_id, engine, engine_version, status, result_enc, result_sha256,
        started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ocrRunId,
      documentId,
      'vision',
      'v1',
      'completed',
      'enc:result',
      'ocr-hash',
      STAMP,
      STAMP,
      STAMP,
    );

    expect(() =>
      db.prepare('UPDATE ocr_runs SET status = ? WHERE id = ?').run('failed', ocrRunId),
    ).toThrow('ocr_runs are immutable');
  });

  it('installs update and delete guards for every immutable historic table', () => {
    const immutableTables = [
      'passport_versions',
      'answer_versions',
      'case_state_transitions',
      'passport_follow_up_answers',
      'passport_confirmations',
      'ocr_runs',
      'document_field_reviews',
      'rule_evaluations',
      'subsidy_calculations',
      'timeline_events',
      'audit_logs',
      'ai_runs',
    ];
    const expectedTriggerNames = immutableTables.flatMap((table) => [
      `${table}_no_update`,
      `${table}_no_delete`,
    ]);
    const triggerNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(triggerNames).toEqual(expect.arrayContaining(expectedTriggerNames));
  });

  it('keeps published rules and historic rows immutable without blocking question status changes', () => {
    const ids = insertCaseGraph(db);
    db.prepare(
      `INSERT INTO passport_follow_up_questions (
        id, passport_version_id, question_key, version_no, prompt_enc, reason_enc,
        answer_schema_json, required, related_node_keys_json, priority, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '0198f015-0000-7000-8000-000000000013',
      ids.passportVersion,
      'missing-invoice-date',
      1,
      'enc:prompt',
      'enc:reason',
      '{"type":"date"}',
      1,
      '[]',
      'high',
      'open',
      STAMP,
    );
    db.prepare('UPDATE passport_follow_up_questions SET status = ? WHERE id = ?').run(
      'answered',
      '0198f015-0000-7000-8000-000000000013',
    );
    expect(() =>
      db
        .prepare('UPDATE passport_follow_up_questions SET prompt_enc = ? WHERE id = ?')
        .run('enc:changed', '0198f015-0000-7000-8000-000000000013'),
    ).toThrow('passport_follow_up_questions source fields are immutable');

    db.prepare('UPDATE program_rule_versions SET status = ? WHERE id = ?').run(
      'published',
      ids.ruleVersion,
    );
    expect(() =>
      db
        .prepare('UPDATE program_rule_versions SET per_case_cap_twd = ? WHERE id = ?')
        .run(20_000, ids.ruleVersion),
    ).toThrow('published program_rule_versions are immutable');

    db.prepare(
      `INSERT INTO case_state_transitions (
        id, case_id, sequence_no, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '0198f015-0000-7000-8000-000000000014',
      ids.case,
      1,
      'draft',
      'submitted',
      'applicant',
      ids.applicant,
      STAMP,
    );
    expect(() =>
      db
        .prepare('UPDATE case_state_transitions SET to_state = ? WHERE id = ?')
        .run('under_review', '0198f015-0000-7000-8000-000000000014'),
    ).toThrow('case_state_transitions are immutable');
  });

  it('rejects duplicate webhook provider IDs and malformed JSON', () => {
    db.prepare(
      `INSERT INTO line_webhook_events (
        id, provider_event_id, event_type, payload_hash, processing_state, received_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '0198f015-0000-7000-8000-000000000010',
      'line-event-1',
      'message',
      'event-hash',
      'queued',
      STAMP,
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO line_webhook_events (
            id, provider_event_id, event_type, payload_hash, processing_state, received_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '0198f015-0000-7000-8000-000000000011',
          'line-event-1',
          'message',
          'different-event-hash',
          'queued',
          STAMP,
        ),
    ).toThrow(/UNIQUE constraint failed: line_webhook_events\.provider_event_id/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (
            id, job_type, payload_json, state, unique_key, attempts, max_attempts,
            available_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '0198f015-0000-7000-8000-000000000012',
          'ocr',
          '{not-json',
          'queued',
          'job-invalid-json',
          0,
          3,
          STAMP,
          STAMP,
        ),
    ).toThrow(/CHECK constraint failed/);
  });
});
