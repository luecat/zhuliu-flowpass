-- Raw OCR text/boxes live in a separately purgeable encrypted envelope. The
-- immutable ocr_runs row keeps only terminal metadata and a result hash.
CREATE TABLE ocr_raw_payloads (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  ocr_run_id TEXT NOT NULL UNIQUE REFERENCES ocr_runs(id) ON DELETE RESTRICT,
  payload_enc TEXT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  purged_at TEXT CHECK (purged_at IS strftime('%Y-%m-%dT%H:%M:%fZ', purged_at))
);

CREATE INDEX ocr_raw_payloads_purge_idx ON ocr_raw_payloads (purged_at, created_at);
