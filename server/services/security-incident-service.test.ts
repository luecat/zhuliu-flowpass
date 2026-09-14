import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createSecurityIncidentService } from './security-incident-service';

const NOW = '2026-08-30T00:00:00.000Z';
const IDS = {
  admin: '0198f060-0000-7000-8000-000000000001', applicant: '0198f060-0000-7000-8000-000000000002', cycle: '0198f060-0000-7000-8000-000000000003', rule: '0198f060-0000-7000-8000-000000000004', product: '0198f060-0000-7000-8000-000000000005', version: '0198f060-0000-7000-8000-000000000006', passport: '0198f060-0000-7000-8000-000000000007', passportVersion: '0198f060-0000-7000-8000-000000000008', answer: '0198f060-0000-7000-8000-000000000009', case: '0198f060-0000-7000-8000-000000000010', draftCase: '0198f060-0000-7000-8000-000000000011', draftPassport: '0198f060-0000-7000-8000-000000000012', draftVersion: '0198f060-0000-7000-8000-000000000013', draftAnswer: '0198f060-0000-7000-8000-000000000014', incident: '0198f060-0000-7000-8000-000000000015' };

function cryptoForTests(): FieldCrypto {
  const keyring: Keyring = { activeKeyId: 'test-v1', getMasterKey: (id) => id === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined };
  return new FieldCrypto(keyring);
}

describe('security incident service', () => {
  let database: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    database = openDatabase(':memory:'); migrateDatabase(database);
    database.prepare("INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, 'reviewer', 'hash', 'active', ?, 1)").run(IDS.admin, NOW);
    database.prepare("INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, 'enc', 'active', ?, ?, 1)").run(IDS.applicant, NOW, NOW);
    database.prepare("INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, 'DEMO', 'Demo', 2026, 'active', '{}', ?, ?, 1)").run(IDS.cycle, NOW, NOW);
    database.prepare("INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, 'published', ?, '2026-12-31T00:00:00.000Z', ?, '2026-12-31T00:00:00.000Z', 0, 0, 'floor', '[]', '{}', ?, ?)").run(IDS.rule, IDS.cycle, NOW, NOW, NOW, NOW);
    database.prepare("INSERT INTO tool_products (id, vendor, canonical_name, aliases_json, status, created_at, row_version) VALUES (?, 'Vendor', 'Local AI', '[\"Alias AI\"]', 'active', ?, 1)").run(IDS.product, NOW);
    database.prepare("INSERT INTO tool_versions (id, tool_product_id, version_label, policy_json, status) VALUES (?, ?, '1.2.3', '{}', 'confirmed')").run(IDS.version, IDS.product);
    const insertCase = (caseId: string, passportId: string, passportVersionId: string, answerId: string, state: string, submitted: string | null) => {
      database.prepare("INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, current_answer_version_id, current_passport_version_id, submitted_answer_version_id, submitted_passport_version_id, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(caseId, `CASE-${caseId}`, IDS.applicant, IDS.cycle, IDS.rule, state, answerId, passportVersionId, submitted ? answerId : null, submitted ? passportVersionId : null, NOW, NOW);
      database.prepare("INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, 'enc', 'hash', ?, ?)").run(answerId, caseId, IDS.applicant, NOW);
      database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, caseId, NOW);
      database.prepare("INSERT INTO passport_versions (id, passport_id, version_no, origin, workflow_state, schema_version, answer_version_id, program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at) VALUES (?, ?, 1, 'ai_draft', 'confirmed', '1', ?, ?, 'enc', ?, 'system', 'test', ?)").run(passportVersionId, passportId, answerId, IDS.rule, `hash-${passportVersionId}`, NOW);
    };
    insertCase(IDS.case, IDS.passport, IDS.passportVersion, IDS.answer, 'submitted', NOW);
    insertCase(IDS.draftCase, IDS.draftPassport, IDS.draftVersion, IDS.draftAnswer, 'draft', null);
    database.prepare("INSERT INTO passport_tool_index (id, passport_version_id, node_key, tool_product_id, tool_version_id, usage_start_at, needs_confirmation) VALUES (?, ?, 'tool', ?, ?, ?, 0)").run(uuidv7(), IDS.passportVersion, IDS.product, IDS.version, NOW);
    database.prepare("INSERT INTO passport_tool_index (id, passport_version_id, node_key, tool_product_id, tool_version_id, usage_start_at, needs_confirmation) VALUES (?, ?, 'tool', ?, ?, ?, 0)").run(uuidv7(), IDS.draftVersion, IDS.product, IDS.version, NOW);
  });
  afterEach(() => database.close());

  it('previews only the current submitted effective version and confirm atomically creates public-safe side effects', () => {
    const service = createSecurityIncidentService({ database, crypto: cryptoForTests(), clock: () => new Date(NOW) });
    const incident = service.createIncident({ adminId: IDS.admin, toolProductId: IDS.product, title: 'Private incident title', severity: 'high', incidentStartAt: '2026-08-01T00:00:00.000Z', incidentEndAt: '2026-09-01T00:00:00.000Z', affectedCriteria: { affectedVersions: ['1.2.3'] }, sourceUrl: 'https://example.test/advisory', sourceTitle: 'Advisory', sourcePublishedAt: NOW, internalRationale: 'Private rationale sentinel', recommendedActions: { action: 'rotate' } });
    const preview = service.previewMatches(incident.id);
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0].caseId).toBe(IDS.case);
    expect((database.prepare('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count).toBe(0);
    const result = service.confirmAlerts({ incidentId: incident.id, adminId: IDS.admin, matches: [{ matchId: preview.candidates[0].matchId, status: 'possible', publicGuidance: '請暫停使用並確認版本。' }] });
    expect(result.alerts).toHaveLength(1);
    expect((database.prepare('SELECT COUNT(*) AS count FROM timeline_events WHERE event_type = \'security_alert_created\'').get() as { count: number }).count).toBe(1);
    expect((database.prepare('SELECT COUNT(*) AS count FROM notification_jobs WHERE template = \'security_alert\'').get() as { count: number }).count).toBe(1);
    const payload = database.prepare('SELECT payload_json FROM notification_jobs').get() as { payload_json: string };
    expect(payload.payload_json).not.toContain('Private');
    expect(payload.payload_json).toContain('security_alert');
    expect(database.prepare('SELECT public_summary, public_guidance FROM alerts').get()).toMatchObject({ public_summary: 'Private incident title', public_guidance: '請暫停使用並確認版本。' });
    service.confirmAlerts({ incidentId: incident.id, adminId: IDS.admin, matches: [{ matchId: preview.candidates[0].matchId, status: 'possible', publicGuidance: '請暫停使用並確認版本。' }] });
    expect((database.prepare('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count).toBe(1);
    expect((database.prepare('SELECT COUNT(*) AS count FROM notification_jobs').get() as { count: number }).count).toBe(1);
  });

  it('rolls back the match review and alert when the notification outbox cannot be written', () => {
    const crypto = cryptoForTests();
    const service = createSecurityIncidentService({ database, crypto, clock: () => new Date(NOW), notificationWriter: () => { throw new Error('outbox unavailable'); } });
    const incident = service.createIncident({ adminId: IDS.admin, toolProductId: IDS.product, title: 'Incident', severity: 'medium', affectedCriteria: { affectedVersions: ['1.2.3'] }, sourceUrl: 'https://example.test/advisory', sourceTitle: 'Advisory', sourcePublishedAt: NOW, internalRationale: 'Rationale', recommendedActions: { action: 'review' } });
    const preview = service.previewMatches(incident.id);
    expect(() => service.confirmAlerts({ incidentId: incident.id, adminId: IDS.admin, matches: [{ matchId: preview.candidates[0].matchId, status: 'confirmed_affected', publicGuidance: '請確認。' }] })).toThrow('outbox unavailable');
    expect((database.prepare('SELECT status FROM incident_matches WHERE id = ?').get(preview.candidates[0].matchId) as { status: string }).status).toBe('possible');
    expect((database.prepare('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count).toBe(0);
    expect((database.prepare('SELECT COUNT(*) AS count FROM notification_jobs').get() as { count: number }).count).toBe(0);
  });
});
