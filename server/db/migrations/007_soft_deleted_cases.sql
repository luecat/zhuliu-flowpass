ALTER TABLE cases ADD COLUMN deleted_at TEXT CHECK (deleted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at));

CREATE INDEX idx_cases_active_updated ON cases (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
