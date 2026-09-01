CREATE TABLE applicants (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  display_label_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE line_identities (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'line'),
  line_subject_enc TEXT NOT NULL,
  line_subject_hmac TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL CHECK (linked_at IS strftime('%Y-%m-%dT%H:%M:%fZ', linked_at)),
  unlinked_at TEXT CHECK (unlinked_at IS strftime('%Y-%m-%dT%H:%M:%fZ', unlinked_at)),
  last_authenticated_at TEXT CHECK (last_authenticated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_authenticated_at)),
  push_state TEXT NOT NULL CHECK (push_state IN ('enabled', 'disabled')),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE login_exchange_nonces (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  nonce_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK (issued_at IS strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  consumed_at TEXT CHECK (consumed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at))
);

CREATE TABLE applicant_sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK (issued_at IS strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)),
  idle_expires_at TEXT NOT NULL CHECK (idle_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', idle_expires_at)),
  absolute_expires_at TEXT NOT NULL CHECK (absolute_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', absolute_expires_at)),
  last_seen_at TEXT NOT NULL CHECK (last_seen_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at)),
  revoked_at TEXT CHECK (revoked_at IS strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at)),
  created_ip_hmac TEXT
);

CREATE TABLE admin_users (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  display_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  disabled_at TEXT CHECK (disabled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE admin_sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK (issued_at IS strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)),
  idle_expires_at TEXT NOT NULL CHECK (idle_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', idle_expires_at)),
  absolute_expires_at TEXT NOT NULL CHECK (absolute_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', absolute_expires_at)),
  last_seen_at TEXT NOT NULL CHECK (last_seen_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at)),
  reauthenticated_at TEXT CHECK (reauthenticated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', reauthenticated_at)),
  revoked_at TEXT CHECK (revoked_at IS strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at))
);

CREATE TABLE program_cycles (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'closed', 'archived')),
  retention_policy_json TEXT NOT NULL CHECK (json_valid(retention_policy_json)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE program_rule_versions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  program_cycle_id TEXT NOT NULL REFERENCES program_cycles(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  application_start_at TEXT CHECK (application_start_at IS strftime('%Y-%m-%dT%H:%M:%fZ', application_start_at)),
  application_end_at TEXT CHECK (application_end_at IS strftime('%Y-%m-%dT%H:%M:%fZ', application_end_at)),
  purchase_start_at TEXT CHECK (purchase_start_at IS strftime('%Y-%m-%dT%H:%M:%fZ', purchase_start_at)),
  purchase_end_at TEXT CHECK (purchase_end_at IS strftime('%Y-%m-%dT%H:%M:%fZ', purchase_end_at)),
  subsidy_rate_bps INTEGER NOT NULL CHECK (subsidy_rate_bps BETWEEN 0 AND 10000),
  per_case_cap_twd INTEGER NOT NULL CHECK (per_case_cap_twd >= 0),
  rounding_mode TEXT NOT NULL CHECK (rounding_mode IN ('floor', 'half_up')),
  required_documents_json TEXT NOT NULL CHECK (json_valid(required_documents_json)),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  published_at TEXT CHECK (published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', published_at)),
  published_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (program_cycle_id, version_no)
);

CREATE TABLE cases (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_code TEXT NOT NULL UNIQUE,
  applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  program_cycle_id TEXT NOT NULL REFERENCES program_cycles(id) ON DELETE RESTRICT,
  program_rule_version_id TEXT NOT NULL REFERENCES program_rule_versions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'submitted', 'under_review', 'awaiting_documents',
    'returned_for_correction', 'resubmitted', 'approved', 'rejected',
    'awaiting_disbursement', 'disbursed', 'closed'
  )),
  -- These historical pointers deliberately have no FKs: the authoritative contract omits them.
  current_answer_version_id TEXT,
  current_passport_version_id TEXT,
  submitted_answer_version_id TEXT,
  submitted_passport_version_id TEXT,
  approved_passport_version_id TEXT,
  requested_amount_twd INTEGER CHECK (requested_amount_twd >= 0),
  calculated_amount_twd INTEGER CHECK (calculated_amount_twd >= 0),
  approved_amount_twd INTEGER CHECK (approved_amount_twd >= 0),
  title_enc TEXT,
  decision_reason_enc TEXT,
  submitted_at TEXT CHECK (submitted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at)),
  closed_at TEXT CHECK (closed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', closed_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE answer_versions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL,
  answers_enc TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by_applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (case_id, version_no),
  UNIQUE (case_id, content_sha256)
);

CREATE TABLE case_state_transitions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT,
  reason_enc TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('applicant', 'admin', 'system')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (case_id, sequence_no)
);

CREATE TABLE passports (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL UNIQUE REFERENCES cases(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TABLE passport_versions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_id TEXT NOT NULL REFERENCES passports(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL,
  parent_version_id TEXT REFERENCES passport_versions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('ai_draft', 'applicant_revision', 'admin_supplement')),
  workflow_state TEXT NOT NULL CHECK (workflow_state IN (
    'ai_drafting', 'follow_up_required', 'needs_applicant_confirmation', 'confirmed', 'locked'
  )),
  schema_version TEXT NOT NULL,
  answer_version_id TEXT NOT NULL REFERENCES answer_versions(id) ON DELETE RESTRICT,
  program_rule_version_id TEXT NOT NULL REFERENCES program_rule_versions(id) ON DELETE RESTRICT,
  payload_enc TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (passport_id, version_no),
  UNIQUE (passport_id, content_sha256)
);

CREATE TABLE passport_node_index (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  node_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_category TEXT,
  sensitivity TEXT,
  needs_confirmation INTEGER NOT NULL CHECK (needs_confirmation IN (0, 1)),
  UNIQUE (passport_version_id, node_key)
);

CREATE TABLE passport_edge_index (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  edge_key TEXT NOT NULL,
  from_node_key TEXT NOT NULL,
  to_node_key TEXT NOT NULL,
  purpose_code TEXT,
  needs_confirmation INTEGER NOT NULL CHECK (needs_confirmation IN (0, 1)),
  UNIQUE (passport_version_id, edge_key)
);

CREATE TABLE passport_tool_index (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  node_key TEXT NOT NULL,
  tool_product_id TEXT NOT NULL REFERENCES tool_products(id) ON DELETE RESTRICT,
  tool_version_id TEXT REFERENCES tool_versions(id) ON DELETE RESTRICT,
  user_visible_label_enc TEXT,
  usage_start_at TEXT CHECK (usage_start_at IS strftime('%Y-%m-%dT%H:%M:%fZ', usage_start_at)),
  usage_end_at TEXT CHECK (usage_end_at IS strftime('%Y-%m-%dT%H:%M:%fZ', usage_end_at)),
  needs_confirmation INTEGER NOT NULL CHECK (needs_confirmation IN (0, 1)),
  UNIQUE (passport_version_id, node_key)
);

CREATE TABLE passport_follow_up_questions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  question_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  prompt_enc TEXT NOT NULL,
  reason_enc TEXT NOT NULL,
  answer_schema_json TEXT NOT NULL CHECK (json_valid(answer_schema_json)),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  related_node_keys_json TEXT NOT NULL CHECK (json_valid(related_node_keys_json)),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'superseded')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (passport_version_id, question_key)
);

CREATE TABLE passport_follow_up_answers (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  question_id TEXT NOT NULL UNIQUE REFERENCES passport_follow_up_questions(id) ON DELETE RESTRICT,
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  answer_enc TEXT NOT NULL,
  answer_hash TEXT NOT NULL,
  answered_by_applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  answered_at TEXT NOT NULL CHECK (answered_at IS strftime('%Y-%m-%dT%H:%M:%fZ', answered_at))
);

CREATE TABLE passport_confirmations (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  confirmation_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  confirmed_at TEXT NOT NULL CHECK (confirmed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at)),
  UNIQUE (passport_version_id, confirmation_type, target_key)
);

CREATE TABLE documents (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'eligibility_proof', 'supplement', 'other')),
  storage_id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  original_name_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_vault', 'ready', 'processing', 'rejected', 'deleted')),
  uploaded_by_type TEXT NOT NULL,
  uploaded_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  deleted_at TEXT CHECK (deleted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE rule_evaluations (
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
  document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  program_rule_version_id TEXT NOT NULL REFERENCES program_rule_versions(id) ON DELETE RESTRICT,
  evaluation_kind TEXT NOT NULL CHECK (evaluation_kind IN ('submission', 'invoice', 'subsidy', 'contextual_alert')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'needs_review', 'missing')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  input_snapshot_hash TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TABLE subsidy_calculations (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  rule_evaluation_id TEXT NOT NULL REFERENCES rule_evaluations(id) ON DELETE RESTRICT,
  eligible_purchase_twd INTEGER NOT NULL CHECK (eligible_purchase_twd >= 0),
  rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  cap_twd INTEGER NOT NULL CHECK (cap_twd >= 0),
  calculated_amount_twd INTEGER NOT NULL CHECK (calculated_amount_twd >= 0),
  rounding_mode TEXT NOT NULL CHECK (rounding_mode IN ('floor', 'half_up')),
  reason_json TEXT NOT NULL CHECK (json_valid(reason_json)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TABLE jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  job_type TEXT NOT NULL CHECK (job_type IN ('ai_draft', 'line_webhook', 'line_notification')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed_terminal')),
  unique_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  available_at TEXT NOT NULL CHECK (available_at IS strftime('%Y-%m-%dT%H:%M:%fZ', available_at)),
  lease_owner TEXT,
  lease_until TEXT CHECK (lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)),
  last_error_code TEXT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))
);

CREATE TABLE case_tasks (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  alert_id TEXT REFERENCES alerts(id) ON DELETE RESTRICT,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'provide_document', 'revise_passport', 'reconfirm_passport',
    'incident_acknowledgement', 'incident_remediation'
  )),
  title TEXT NOT NULL,
  instructions_enc TEXT NOT NULL,
  accepted_document_types_json TEXT NOT NULL CHECK (json_valid(accepted_document_types_json)),
  due_at TEXT CHECK (due_at IS strftime('%Y-%m-%dT%H:%M:%fZ', due_at)),
  status TEXT NOT NULL CHECK (status IN ('open', 'opened', 'completed', 'cancelled', 'expired')),
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  completed_at TEXT CHECK (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE notification_jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES case_tasks(id) ON DELETE RESTRICT,
  alert_id TEXT REFERENCES alerts(id) ON DELETE RESTRICT,
  business_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel = 'line_push'),
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  provider_retry_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'sent_confirmed', 'unknown_delivery', 'failed_terminal'
  )),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  available_at TEXT NOT NULL CHECK (available_at IS strftime('%Y-%m-%dT%H:%M:%fZ', available_at)),
  lease_until TEXT CHECK (lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)),
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  sent_at TEXT CHECK (sent_at IS strftime('%Y-%m-%dT%H:%M:%fZ', sent_at))
);

CREATE TABLE line_webhook_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  line_identity_id TEXT REFERENCES line_identities(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  processing_state TEXT NOT NULL CHECK (processing_state IN ('queued', 'processed', 'ignored', 'failed')),
  received_at TEXT NOT NULL CHECK (received_at IS strftime('%Y-%m-%dT%H:%M:%fZ', received_at)),
  processed_at TEXT CHECK (processed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', processed_at))
);

CREATE TABLE api_idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (scope, key)
);

CREATE TABLE rate_limit_buckets (
  scope_key_hmac TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start_at TEXT NOT NULL CHECK (window_start_at IS strftime('%Y-%m-%dT%H:%M:%fZ', window_start_at)),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (scope_key_hmac, action, window_start_at)
);

CREATE TABLE tool_products (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  vendor TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  UNIQUE (vendor, canonical_name)
);

CREATE TABLE tool_versions (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  tool_product_id TEXT NOT NULL REFERENCES tool_products(id) ON DELETE RESTRICT,
  version_label TEXT NOT NULL,
  released_at TEXT CHECK (released_at IS strftime('%Y-%m-%dT%H:%M:%fZ', released_at)),
  retired_at TEXT CHECK (retired_at IS strftime('%Y-%m-%dT%H:%M:%fZ', retired_at)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  source_url TEXT,
  confirmed_at TEXT CHECK (confirmed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at)),
  status TEXT NOT NULL,
  UNIQUE (tool_product_id, version_label)
);

CREATE TABLE security_incidents (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  tool_product_id TEXT NOT NULL REFERENCES tool_products(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  incident_start_at TEXT CHECK (incident_start_at IS strftime('%Y-%m-%dT%H:%M:%fZ', incident_start_at)),
  incident_end_at TEXT CHECK (incident_end_at IS strftime('%Y-%m-%dT%H:%M:%fZ', incident_end_at)),
  affected_criteria_json TEXT NOT NULL CHECK (json_valid(affected_criteria_json)),
  source_url TEXT,
  source_title TEXT,
  source_published_at TEXT CHECK (source_published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', source_published_at)),
  internal_rationale_enc TEXT,
  recommended_actions_json TEXT NOT NULL CHECK (json_valid(recommended_actions_json)),
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'resolved', 'withdrawn')),
  created_by_admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  published_at TEXT CHECK (published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', published_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE incident_matches (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  security_incident_id TEXT NOT NULL REFERENCES security_incidents(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  match_basis_json TEXT NOT NULL CHECK (json_valid(match_basis_json)),
  status TEXT NOT NULL CHECK (status IN ('possible', 'confirmed_affected', 'not_affected', 'notified')),
  reviewed_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  reviewed_at TEXT CHECK (reviewed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (security_incident_id, case_id, passport_version_id)
);

CREATE TABLE alerts (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  passport_version_id TEXT NOT NULL REFERENCES passport_versions(id) ON DELETE RESTRICT,
  incident_match_id TEXT REFERENCES incident_matches(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('contextual', 'incident')),
  severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  public_summary TEXT NOT NULL,
  public_guidance TEXT NOT NULL,
  details_enc TEXT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  resolved_at TEXT CHECK (resolved_at IS strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at)),
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
);

CREATE TABLE timeline_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL,
  passport_version_id TEXT REFERENCES passport_versions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  public_summary TEXT NOT NULL,
  public_data_json TEXT NOT NULL CHECK (json_valid(public_data_json)),
  actor_type TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (case_id, sequence_no)
);

CREATE TABLE audit_logs (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36
    AND length(CAST(id AS BLOB)) = 36
    AND id = lower(id)
    AND id GLOB '????????-????-7???-[89ab]???-????????????'
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(id, '-', '')) = 32
  ),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  detail_enc TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TABLE ai_runs (
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
  adapter TEXT NOT NULL CHECK (adapter = 'lm_studio'),
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
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);
