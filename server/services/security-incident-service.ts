import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { encryptDatabaseText } from '../db/repositories/encrypted-fields';
import { insertPublicNotificationJobForSystem } from '../db/repositories/notifications';
import type { IncidentMatchStatus } from '../../shared/security-contract';
import { matchIncident } from '../domain/incident-match';
import { parseUtcRfc3339Timestamp } from '../db/timestamps';

export type SecurityIncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ConfirmedIncidentStatus = 'possible' | 'confirmed_affected' | 'not_affected';

export class SecurityIncidentError extends Error {
  public constructor(readonly code: 'NOT_FOUND' | 'INVALID_REQUEST' | 'INVALID_STATE' | 'MATCH_NOT_FOUND', message: string = code) {
    super(message);
    this.name = 'SecurityIncidentError';
  }
}

export interface SecurityIncidentServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  clock?: () => Date;
  idGenerator?: () => string;
  notificationWriter?: (input: Parameters<typeof insertPublicNotificationJobForSystem>[2]) => void;
}

export interface CreateSecurityIncidentInput {
  adminId: string;
  toolProductId: string;
  title: string;
  severity: SecurityIncidentSeverity;
  incidentStartAt?: string | null;
  incidentEndAt?: string | null;
  affectedCriteria: unknown;
  sourceUrl: string;
  sourceTitle: string;
  sourcePublishedAt: string;
  internalRationale: string;
  recommendedActions: unknown;
}

export interface IncidentCandidate {
  matchId: string;
  caseId: string;
  passportVersionId: string;
  status: 'possible';
  basis: string[];
}

export interface ConfirmAlertInput {
  matchId: string;
  status: ConfirmedIncidentStatus;
  publicGuidance: string;
}

const SYSTEM_SCOPE = { systemId: 'security-incident-service' } as const;
const PUBLIC_NOTIFICATION = {
  notificationType: 'security',
  messageCode: 'security_alert',
  locale: 'zh-TW',
  publicPath: '/app/passports',
} as const;

function transactionally<T>(database: FlowPassDatabase, callback: () => T): T {
  return database.transaction(callback)();
}

function requireText(value: unknown, field: string, max = 1000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new SecurityIncidentError('INVALID_REQUEST', `${field} is required`);
  return value;
}

function parseOptionalTimestamp(value: string | null | undefined, field: string): string | null {
  return value == null ? null : parseUtcRfc3339Timestamp(value, field);
}

function jsonObject(value: unknown, field: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityIncidentError('INVALID_REQUEST', `${field} must be an object`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) throw new SecurityIncidentError('INVALID_REQUEST', `${field} is too large`);
  return serialized;
}

function affectedVersions(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return [];
  const value = (criteria as { affectedVersions?: unknown }).affectedVersions;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type CandidateRow = {
  case_id: string;
  passport_version_id: string;
  tool_name: string;
  tool_version: string | null;
  aliases_json: string;
  usage_at: string | null;
};

export function createSecurityIncidentService(options: SecurityIncidentServiceOptions) {
  const now = () => (options.clock ?? (() => new Date()))().toISOString();
  const id = options.idGenerator ?? uuidv7;
  const writeNotification = options.notificationWriter ?? ((input: Parameters<typeof insertPublicNotificationJobForSystem>[2]) => insertPublicNotificationJobForSystem(options.database, SYSTEM_SCOPE, input));

  function createIncident(input: CreateSecurityIncidentInput) {
    const title = requireText(input.title, 'title', 300);
    const sourceUrl = requireText(input.sourceUrl, 'sourceUrl', 2_048);
    if (!/^https:\/\//i.test(sourceUrl)) throw new SecurityIncidentError('INVALID_REQUEST', 'sourceUrl must use HTTPS');
    const sourceTitle = requireText(input.sourceTitle, 'sourceTitle', 300);
    const internalRationale = requireText(input.internalRationale, 'internalRationale', 4_000);
    const publishedAt = parseUtcRfc3339Timestamp(input.sourcePublishedAt, 'sourcePublishedAt');
    const start = parseOptionalTimestamp(input.incidentStartAt, 'incidentStartAt');
    const end = parseOptionalTimestamp(input.incidentEndAt, 'incidentEndAt');
    if (start && end && start > end) throw new SecurityIncidentError('INVALID_REQUEST', 'incident window is invalid');
    if (!['low', 'medium', 'high', 'critical'].includes(input.severity)) throw new SecurityIncidentError('INVALID_REQUEST', 'severity is invalid');
    const incidentId = id();
    const createdAt = now();
    options.database.prepare(`INSERT INTO security_incidents (id, tool_product_id, title, severity, incident_start_at, incident_end_at, affected_criteria_json, source_url, source_title, source_published_at, internal_rationale_enc, recommended_actions_json, state, created_by_admin_id, published_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, 1)`).run(
      incidentId, input.toolProductId, title, input.severity, start, end,
      jsonObject(input.affectedCriteria, 'affectedCriteria'), sourceUrl, sourceTitle,
      publishedAt, encryptDatabaseText(options.crypto, 'security_incidents', 'internal_rationale_enc', incidentId, internalRationale),
      jsonObject(input.recommendedActions, 'recommendedActions'), input.adminId,
    );
    return { id: incidentId, state: 'draft' as const, rowVersion: 1, createdAt };
  }

  type IncidentRow = { id: string; tool_product_id: string; title: string; severity: SecurityIncidentSeverity; incident_start_at: string | null; incident_end_at: string | null; affected_criteria_json: string; state: string };

  function incidentRow(incidentId: string): IncidentRow {
    const row = options.database.prepare('SELECT id, tool_product_id, title, severity, incident_start_at, incident_end_at, affected_criteria_json, state FROM security_incidents WHERE id = ?').get(incidentId) as IncidentRow | undefined;
    if (!row) throw new SecurityIncidentError('NOT_FOUND');
    if (row.state === 'withdrawn') throw new SecurityIncidentError('INVALID_STATE');
    return row;
  }

  function previewMatches(incidentId: string): { incidentId: string; candidates: IncidentCandidate[] } {
    const incident = incidentRow(incidentId);
    const versions = affectedVersions(JSON.parse(incident.affected_criteria_json) as unknown);
    const rows = options.database.prepare(`SELECT DISTINCT c.id AS case_id, pv.id AS passport_version_id, tp.canonical_name AS tool_name, tv.version_label AS tool_version, tp.aliases_json, COALESCE(pti.usage_start_at, pti.usage_end_at) AS usage_at FROM passport_tool_index pti JOIN passport_versions pv ON pv.id = pti.passport_version_id JOIN passports p ON p.id = pv.passport_id JOIN cases c ON c.id = p.case_id AND c.submitted_passport_version_id = pv.id JOIN tool_products tp ON tp.id = pti.tool_product_id LEFT JOIN tool_versions tv ON tv.id = pti.tool_version_id WHERE pti.tool_product_id = ? AND c.state <> 'draft' ORDER BY c.id, pv.id`).all(incident.tool_product_id) as CandidateRow[];
    return transactionally(options.database, () => {
      const candidates: IncidentCandidate[] = [];
      for (const row of rows) {
        const result = matchIncident({ toolName: row.tool_name, toolVersion: row.tool_version, aliases: parseAliases(row.aliases_json), affectedVersions: versions, usageAt: row.usage_at, incidentStartAt: incident.incident_start_at, incidentEndAt: incident.incident_end_at, effective: true });
        if (!result.matched) continue;
        const existing = options.database.prepare('SELECT id, status, match_basis_json FROM incident_matches WHERE security_incident_id = ? AND case_id = ? AND passport_version_id = ?').get(incidentId, row.case_id, row.passport_version_id) as { id: string; status: IncidentMatchStatus; match_basis_json: string } | undefined;
        const matchId = existing?.id ?? id();
        if (!existing) options.database.prepare('INSERT INTO incident_matches (id, security_incident_id, case_id, passport_version_id, match_basis_json, status, reviewed_by_admin_id, reviewed_at, created_at) VALUES (?, ?, ?, ?, ?, \'possible\', NULL, NULL, ?)').run(matchId, incidentId, row.case_id, row.passport_version_id, JSON.stringify({ basis: result.basis }), now());
        candidates.push({ matchId, caseId: row.case_id, passportVersionId: row.passport_version_id, status: 'possible', basis: result.basis });
      }
      return { incidentId, candidates };
    });
  }

  function confirmAlerts(input: { incidentId: string; adminId: string; matches: readonly ConfirmAlertInput[] }) {
    const incident = incidentRow(input.incidentId);
    if (!input.matches.length) throw new SecurityIncidentError('INVALID_REQUEST', 'matches are required');
    const at = now();
    return transactionally(options.database, () => {
      const alerts: Array<{ id: string; caseId: string; status: ConfirmedIncidentStatus }> = [];
      const notificationJobIds: string[] = [];
      for (const selected of input.matches) {
        const guidance = requireText(selected.publicGuidance, 'publicGuidance', 1_000);
        if (!['possible', 'confirmed_affected', 'not_affected'].includes(selected.status)) throw new SecurityIncidentError('INVALID_REQUEST', 'match status is invalid');
        const match = options.database.prepare('SELECT id, case_id, passport_version_id, status FROM incident_matches WHERE id = ? AND security_incident_id = ?').get(selected.matchId, input.incidentId) as { id: string; case_id: string; passport_version_id: string; status: string } | undefined;
        if (!match) throw new SecurityIncidentError('MATCH_NOT_FOUND');
        options.database.prepare('UPDATE incident_matches SET status = ?, reviewed_by_admin_id = ?, reviewed_at = ? WHERE id = ?').run(selected.status, input.adminId, at, match.id);
        if (selected.status === 'not_affected') continue;
        const summary = selected.status === 'confirmed_affected' ? '已確認受影響的資安提醒' : '可能受影響的資安提醒';
        const existing = options.database.prepare('SELECT id FROM alerts WHERE incident_match_id = ?').get(match.id) as { id: string } | undefined;
        const alertId = existing?.id ?? id();
        if (!existing) {
          options.database.prepare(`INSERT INTO alerts (id, case_id, passport_version_id, incident_match_id, kind, severity, status, public_summary, public_guidance, details_enc, created_at, resolved_at, row_version) VALUES (?, ?, ?, ?, 'incident', ?, 'open', ?, ?, ?, ?, NULL, 1)`).run(alertId, match.case_id, match.passport_version_id, match.id, incident.severity, summary, guidance, encryptDatabaseText(options.crypto, 'alerts', 'details_enc', alertId, JSON.stringify({ incidentId: input.incidentId, title: incident.title })), at);
          const sequence = (options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max FROM timeline_events WHERE case_id = ?').get(match.case_id) as { max: number }).max + 1;
          options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, ?, ?, 'security_alert_created', ?, ?, 'system', ?)`).run(id(), match.case_id, sequence, match.passport_version_id, summary, JSON.stringify({ status: selected.status }), at);
          const job = id();
          writeNotification({ id: job, caseId: match.case_id, taskId: null, alertId, businessKey: `security-alert:${alertId}`, template: 'security_alert', payload: PUBLIC_NOTIFICATION, providerRetryKey: `security-alert-${alertId}`, status: 'pending', attempts: 0, availableAt: at, createdAt: at });
          notificationJobIds.push(job);
        }
        alerts.push({ id: alertId, caseId: match.case_id, status: selected.status });
      }
      options.database.prepare("UPDATE security_incidents SET state = 'published', published_at = COALESCE(published_at, ?), row_version = row_version + 1 WHERE id = ?").run(at, input.incidentId);
      return { incidentId: input.incidentId, alerts, notificationJobIds };
    });
  }

  const preview = (input: string | { incidentId: string }) => previewMatches(typeof input === 'string' ? input : input.incidentId);
  const confirm = (input: { incidentId: string; adminId: string; matches: readonly ConfirmAlertInput[] }) => confirmAlerts(input);
  return { createIncident, create: createIncident, previewMatches, preview, confirmAlerts, confirm };
}
