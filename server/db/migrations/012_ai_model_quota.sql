CREATE TABLE ai_model_quota_usage (
  model_id TEXT NOT NULL,
  minute_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  PRIMARY KEY (model_id, minute_key, day_key)
);
