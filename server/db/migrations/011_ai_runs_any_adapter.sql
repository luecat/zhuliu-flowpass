-- Passport drafts can be served by more than one model provider (local LM Studio
-- or the Gemini API), so ai_runs.adapter records whichever provider actually ran.
-- SQLite cannot relax a table CHECK in place, so rebuild the table and recreate
-- its immutability triggers. Every existing audit row is copied verbatim; nothing
-- is rewritten or deleted.
DROP TRIGGER IF EXISTS ai_runs_no_update;
DROP TRIGGER IF EXISTS ai_runs_no_delete;

CREATE TABLE ai_runs_next (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  passport_version_id TEXT REFERENCES passport_versions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('draft', 'revise')),
  adapter TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  result_code TEXT NOT NULL,
  repair_count INTEGER NOT NULL CHECK (repair_count >= 0),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  )
);

INSERT INTO ai_runs_next (
  id, case_id, passport_version_id, operation, adapter, model_id,
  prompt_version, schema_version, input_hash, output_hash, input_tokens,
  output_tokens, duration_ms, result_code, repair_count, created_at
)
SELECT
  id, case_id, passport_version_id, operation, adapter, model_id,
  prompt_version, schema_version, input_hash, output_hash, input_tokens,
  output_tokens, duration_ms, result_code, repair_count, created_at
FROM ai_runs;

DROP TABLE ai_runs;
ALTER TABLE ai_runs_next RENAME TO ai_runs;

CREATE TRIGGER ai_runs_no_update
BEFORE UPDATE ON ai_runs
BEGIN
  SELECT RAISE(ABORT, 'ai_runs are immutable');
END;

CREATE TRIGGER ai_runs_no_delete BEFORE DELETE ON ai_runs
WHEN NOT EXISTS (SELECT 1 FROM admin_data_mutation_guards WHERE table_name = 'ai_runs' AND record_id = OLD.id AND action = 'delete' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'ai_runs are immutable'); END;
