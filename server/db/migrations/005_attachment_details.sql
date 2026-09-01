ALTER TABLE documents ADD COLUMN requirement_key TEXT;

CREATE INDEX idx_documents_case_requirement_status
  ON documents (case_id, requirement_key, status, created_at);

CREATE TABLE case_purchase_details (
  case_id TEXT NOT NULL PRIMARY KEY REFERENCES cases(id) ON DELETE RESTRICT,
  details_enc TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
  ),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);
