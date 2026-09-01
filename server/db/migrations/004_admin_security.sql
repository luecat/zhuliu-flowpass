ALTER TABLE admin_users ADD COLUMN recovery_email_normalized TEXT;
ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1));
ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT;
ALTER TABLE admin_users ADD COLUMN password_expires_at TEXT;
ALTER TABLE admin_users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0);
ALTER TABLE admin_users ADD COLUMN locked_until TEXT;
ALTER TABLE admin_users ADD COLUMN last_login_at TEXT;

CREATE TABLE admin_password_history (
  id TEXT NOT NULL PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_password_history_recent_idx ON admin_password_history(admin_user_id, created_at DESC);

CREATE TABLE admin_recovery_challenges (
  id TEXT NOT NULL PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  access_email_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX admin_recovery_active_idx ON admin_recovery_challenges(admin_user_id, expires_at);

CREATE TABLE admin_auth_events (
  id TEXT NOT NULL PRIMARY KEY,
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
