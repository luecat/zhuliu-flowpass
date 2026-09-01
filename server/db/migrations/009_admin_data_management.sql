CREATE TABLE flowpass_maintenance_state (
  singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  operation_id TEXT,
  phase TEXT NOT NULL,
  started_at TEXT CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (
    (active = 0 AND operation_id IS NULL AND started_at IS NULL)
    OR (active = 1 AND operation_id IS NOT NULL AND started_at IS NOT NULL)
  )
);

INSERT INTO flowpass_maintenance_state (
  singleton_id, active, operation_id, phase, started_at, updated_at
) VALUES (1, 0, NULL, 'idle', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE admin_data_edit_audits (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'integer', 'money', 'date', 'datetime', 'boolean', 'json', 'status')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'conflict', 'failed')),
  requires_ai_refresh INTEGER NOT NULL CHECK (requires_ai_refresh IN (0, 1)),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE INDEX idx_admin_data_edit_audits_case_created
  ON admin_data_edit_audits (case_id, created_at DESC);

CREATE TABLE admin_purge_authorizations (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  token_hash TEXT NOT NULL UNIQUE,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL,
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  consumed_at TEXT CHECK (consumed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE INDEX idx_admin_purge_authorizations_case_expires
  ON admin_purge_authorizations (case_id, expires_at);

CREATE TABLE admin_data_mutation_guards (
  id TEXT NOT NULL PRIMARY KEY,
  operation_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('update', 'delete')),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  UNIQUE (operation_id, table_name, record_id, action)
);

CREATE INDEX idx_admin_data_mutation_guards_lookup
  ON admin_data_mutation_guards (table_name, record_id, action, expires_at);

-- Source records stay immutable unless the admin data service grants this
-- exact row a short-lived correction inside the same transaction. Separate
-- shape triggers keep identity, ownership, version and provenance immutable.
DROP TRIGGER answer_versions_no_update;
CREATE TRIGGER answer_versions_no_update
BEFORE UPDATE ON answer_versions
WHEN NOT EXISTS (
  SELECT 1 FROM admin_data_mutation_guards
  WHERE table_name = 'answer_versions' AND record_id = OLD.id AND action = 'update'
    AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'answer_versions are immutable'); END;

CREATE TRIGGER answer_versions_admin_update_shape
BEFORE UPDATE ON answer_versions
WHEN EXISTS (
  SELECT 1 FROM admin_data_mutation_guards
  WHERE table_name = 'answer_versions' AND record_id = OLD.id AND action = 'update'
    AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) AND (
  NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.version_no <> OLD.version_no
  OR NEW.created_by_applicant_id <> OLD.created_by_applicant_id OR NEW.created_at <> OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'answer_versions structural fields are immutable'); END;

DROP TRIGGER passport_versions_no_update;
CREATE TRIGGER passport_versions_no_update
BEFORE UPDATE ON passport_versions
WHEN NOT EXISTS (
  SELECT 1 FROM admin_data_mutation_guards
  WHERE table_name = 'passport_versions' AND record_id = OLD.id AND action = 'update'
    AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'passport_versions are immutable'); END;

CREATE TRIGGER passport_versions_admin_update_shape
BEFORE UPDATE ON passport_versions
WHEN EXISTS (
  SELECT 1 FROM admin_data_mutation_guards
  WHERE table_name = 'passport_versions' AND record_id = OLD.id AND action = 'update'
    AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) AND (
  NEW.id <> OLD.id OR NEW.passport_id <> OLD.passport_id OR NEW.version_no <> OLD.version_no
  OR COALESCE(NEW.parent_version_id, '') <> COALESCE(OLD.parent_version_id, '')
  OR NEW.origin <> OLD.origin OR NEW.workflow_state <> OLD.workflow_state
  OR NEW.schema_version <> OLD.schema_version OR NEW.answer_version_id <> OLD.answer_version_id
  OR NEW.program_rule_version_id <> OLD.program_rule_version_id
  OR NEW.created_by_type <> OLD.created_by_type OR NEW.created_by_id <> OLD.created_by_id
  OR NEW.created_at <> OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'passport_versions structural fields are immutable'); END;

-- Hard purge also remains fail-closed. Every immutable row requires an exact,
-- expiring delete grant generated from the signed relation preview.
DROP TRIGGER answer_versions_no_delete;
CREATE TRIGGER answer_versions_no_delete BEFORE DELETE ON answer_versions
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'answer_versions' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'answer_versions are immutable'); END;
DROP TRIGGER passport_versions_no_delete;
CREATE TRIGGER passport_versions_no_delete BEFORE DELETE ON passport_versions
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'passport_versions' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'passport_versions are immutable'); END;
DROP TRIGGER case_state_transitions_no_delete;
CREATE TRIGGER case_state_transitions_no_delete BEFORE DELETE ON case_state_transitions
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'case_state_transitions' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'case_state_transitions are immutable'); END;
DROP TRIGGER passport_follow_up_answers_no_delete;
CREATE TRIGGER passport_follow_up_answers_no_delete BEFORE DELETE ON passport_follow_up_answers
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'passport_follow_up_answers' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'passport_follow_up_answers are immutable'); END;
DROP TRIGGER passport_confirmations_no_delete;
CREATE TRIGGER passport_confirmations_no_delete BEFORE DELETE ON passport_confirmations
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'passport_confirmations' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'passport_confirmations are immutable'); END;
DROP TRIGGER ocr_runs_no_delete;
CREATE TRIGGER ocr_runs_no_delete BEFORE DELETE ON ocr_runs
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'ocr_runs' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'ocr_runs are immutable'); END;
DROP TRIGGER document_field_reviews_no_delete;
CREATE TRIGGER document_field_reviews_no_delete BEFORE DELETE ON document_field_reviews
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'document_field_reviews' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'document_field_reviews are immutable'); END;
DROP TRIGGER rule_evaluations_no_delete;
CREATE TRIGGER rule_evaluations_no_delete BEFORE DELETE ON rule_evaluations
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'rule_evaluations' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'rule_evaluations are immutable'); END;
DROP TRIGGER subsidy_calculations_no_delete;
CREATE TRIGGER subsidy_calculations_no_delete BEFORE DELETE ON subsidy_calculations
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'subsidy_calculations' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'subsidy_calculations are immutable'); END;
DROP TRIGGER timeline_events_no_delete;
CREATE TRIGGER timeline_events_no_delete BEFORE DELETE ON timeline_events
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'timeline_events' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'timeline_events are immutable'); END;
DROP TRIGGER audit_logs_no_delete;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'audit_logs' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'audit_logs are immutable'); END;
DROP TRIGGER ai_runs_no_delete;
CREATE TRIGGER ai_runs_no_delete BEFORE DELETE ON ai_runs
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'ai_runs' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'ai_runs are immutable'); END;
