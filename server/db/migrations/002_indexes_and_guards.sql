CREATE INDEX idx_applicants_status ON applicants(status);
CREATE INDEX idx_line_identities_applicant_unlinked ON line_identities(applicant_id, unlinked_at);
CREATE INDEX idx_login_exchange_nonces_expires_at ON login_exchange_nonces(expires_at);
CREATE INDEX idx_applicant_sessions_applicant_revoked ON applicant_sessions(applicant_id, revoked_at);
CREATE INDEX idx_admin_sessions_admin_revoked ON admin_sessions(admin_user_id, revoked_at);

CREATE INDEX idx_program_cycles_status_year ON program_cycles(status, year);
CREATE INDEX idx_cases_applicant_program_created ON cases(applicant_id, program_cycle_id, created_at DESC);
CREATE INDEX idx_cases_state_updated ON cases(state, updated_at DESC);

CREATE INDEX idx_passport_node_index_kind_data_category ON passport_node_index(kind, data_category);
CREATE INDEX idx_passport_tool_index_product_version ON passport_tool_index(tool_product_id, tool_version_id);

CREATE INDEX idx_documents_case_status ON documents(case_id, status);
CREATE INDEX idx_ocr_runs_document_created ON ocr_runs(document_id, created_at DESC);
CREATE INDEX idx_document_fields_document_field ON document_fields(document_id, field_name);
CREATE INDEX idx_document_fields_normalized_value_hmac ON document_fields(normalized_value_hmac);
CREATE INDEX idx_document_field_reviews_field_created ON document_field_reviews(document_field_id, created_at DESC);
CREATE INDEX idx_invoice_fingerprints_fingerprint_hmac ON invoice_fingerprints(fingerprint_hmac);
CREATE INDEX idx_rule_evaluations_case_kind_created ON rule_evaluations(case_id, evaluation_kind, created_at DESC);

CREATE INDEX idx_jobs_state_available ON jobs(state, available_at);
CREATE INDEX idx_jobs_lease_until ON jobs(lease_until);
CREATE INDEX idx_case_tasks_case_status ON case_tasks(case_id, status);
CREATE INDEX idx_case_tasks_due_status ON case_tasks(due_at, status);
CREATE INDEX idx_notification_jobs_status_available ON notification_jobs(status, available_at);
CREATE INDEX idx_line_webhook_events_state_received ON line_webhook_events(processing_state, received_at);
CREATE INDEX idx_api_idempotency_keys_expires_at ON api_idempotency_keys(expires_at);

CREATE INDEX idx_security_incidents_product_state ON security_incidents(tool_product_id, state);
CREATE INDEX idx_incident_matches_incident_status ON incident_matches(security_incident_id, status);
CREATE INDEX idx_alerts_case_status ON alerts(case_id, status);
CREATE INDEX idx_audit_logs_entity_created ON audit_logs(entity_type, entity_id, created_at DESC);

CREATE TRIGGER passport_versions_no_update
BEFORE UPDATE ON passport_versions
BEGIN
  SELECT RAISE(ABORT, 'passport_versions are immutable');
END;

CREATE TRIGGER passport_versions_no_delete
BEFORE DELETE ON passport_versions
BEGIN
  SELECT RAISE(ABORT, 'passport_versions are immutable');
END;

CREATE TRIGGER answer_versions_no_update
BEFORE UPDATE ON answer_versions
BEGIN
  SELECT RAISE(ABORT, 'answer_versions are immutable');
END;

CREATE TRIGGER answer_versions_no_delete
BEFORE DELETE ON answer_versions
BEGIN
  SELECT RAISE(ABORT, 'answer_versions are immutable');
END;

CREATE TRIGGER case_state_transitions_no_update
BEFORE UPDATE ON case_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'case_state_transitions are immutable');
END;

CREATE TRIGGER case_state_transitions_no_delete
BEFORE DELETE ON case_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'case_state_transitions are immutable');
END;

CREATE TRIGGER passport_follow_up_answers_no_update
BEFORE UPDATE ON passport_follow_up_answers
BEGIN
  SELECT RAISE(ABORT, 'passport_follow_up_answers are immutable');
END;

CREATE TRIGGER passport_follow_up_answers_no_delete
BEFORE DELETE ON passport_follow_up_answers
BEGIN
  SELECT RAISE(ABORT, 'passport_follow_up_answers are immutable');
END;

CREATE TRIGGER passport_confirmations_no_update
BEFORE UPDATE ON passport_confirmations
BEGIN
  SELECT RAISE(ABORT, 'passport_confirmations are immutable');
END;

CREATE TRIGGER passport_confirmations_no_delete
BEFORE DELETE ON passport_confirmations
BEGIN
  SELECT RAISE(ABORT, 'passport_confirmations are immutable');
END;

CREATE TRIGGER ocr_runs_no_update
BEFORE UPDATE ON ocr_runs
BEGIN
  SELECT RAISE(ABORT, 'ocr_runs are immutable');
END;

CREATE TRIGGER ocr_runs_no_delete
BEFORE DELETE ON ocr_runs
BEGIN
  SELECT RAISE(ABORT, 'ocr_runs are immutable');
END;

CREATE TRIGGER document_field_reviews_no_update
BEFORE UPDATE ON document_field_reviews
BEGIN
  SELECT RAISE(ABORT, 'document_field_reviews are immutable');
END;

CREATE TRIGGER document_field_reviews_no_delete
BEFORE DELETE ON document_field_reviews
BEGIN
  SELECT RAISE(ABORT, 'document_field_reviews are immutable');
END;

CREATE TRIGGER rule_evaluations_no_update
BEFORE UPDATE ON rule_evaluations
BEGIN
  SELECT RAISE(ABORT, 'rule_evaluations are immutable');
END;

CREATE TRIGGER rule_evaluations_no_delete
BEFORE DELETE ON rule_evaluations
BEGIN
  SELECT RAISE(ABORT, 'rule_evaluations are immutable');
END;

CREATE TRIGGER subsidy_calculations_no_update
BEFORE UPDATE ON subsidy_calculations
BEGIN
  SELECT RAISE(ABORT, 'subsidy_calculations are immutable');
END;

CREATE TRIGGER subsidy_calculations_no_delete
BEFORE DELETE ON subsidy_calculations
BEGIN
  SELECT RAISE(ABORT, 'subsidy_calculations are immutable');
END;

CREATE TRIGGER timeline_events_no_update
BEFORE UPDATE ON timeline_events
BEGIN
  SELECT RAISE(ABORT, 'timeline_events are immutable');
END;

CREATE TRIGGER timeline_events_no_delete
BEFORE DELETE ON timeline_events
BEGIN
  SELECT RAISE(ABORT, 'timeline_events are immutable');
END;

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are immutable');
END;

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are immutable');
END;

CREATE TRIGGER ai_runs_no_update
BEFORE UPDATE ON ai_runs
BEGIN
  SELECT RAISE(ABORT, 'ai_runs are immutable');
END;

CREATE TRIGGER ai_runs_no_delete
BEFORE DELETE ON ai_runs
BEGIN
  SELECT RAISE(ABORT, 'ai_runs are immutable');
END;

CREATE TRIGGER program_rule_versions_published_no_update
BEFORE UPDATE ON program_rule_versions
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published program_rule_versions are immutable');
END;

CREATE TRIGGER program_rule_versions_published_no_delete
BEFORE DELETE ON program_rule_versions
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published program_rule_versions are immutable');
END;

CREATE TRIGGER passport_follow_up_questions_source_fields_no_update
BEFORE UPDATE OF
  id,
  passport_version_id,
  question_key,
  version_no,
  prompt_enc,
  reason_enc,
  answer_schema_json,
  required,
  related_node_keys_json,
  priority,
  created_at
ON passport_follow_up_questions
BEGIN
  SELECT RAISE(ABORT, 'passport_follow_up_questions source fields are immutable');
END;
