import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  type AdminScope,
} from './scopes';

interface SecurityIncidentRow {
  id: string;
  tool_product_id: string;
  title: string;
  severity: string;
  incident_start_at: string | null;
  incident_end_at: string | null;
  source_url: string | null;
  source_title: string | null;
  source_published_at: string | null;
  state: string;
  published_at: string | null;
  row_version: number;
}

/** Internal incident projection; available only from admin-scoped functions. */
export interface AdminSecurityIncidentRecord {
  id: string;
  toolProductId: string;
  title: string;
  severity: string;
  incidentStartAt: string | null;
  incidentEndAt: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublishedAt: string | null;
  state: string;
  publishedAt: string | null;
  rowVersion: number;
}

interface IncidentMatchRow {
  id: string;
  security_incident_id: string;
  case_id: string;
  passport_version_id: string;
  match_basis_json: string;
  status: string;
  reviewed_by_admin_id: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/** Internal match projection; never return a preview match to an applicant. */
export interface AdminIncidentMatchRecord {
  id: string;
  securityIncidentId: string;
  caseId: string;
  passportVersionId: string;
  matchBasisJson: string;
  status: string;
  reviewedByAdminId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

function mapSecurityIncident(row: SecurityIncidentRow): AdminSecurityIncidentRecord {
  return {
    id: row.id,
    toolProductId: row.tool_product_id,
    title: row.title,
    severity: row.severity,
    incidentStartAt: row.incident_start_at,
    incidentEndAt: row.incident_end_at,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourcePublishedAt: row.source_published_at,
    state: row.state,
    publishedAt: row.published_at,
    rowVersion: row.row_version,
  };
}

function mapIncidentMatch(row: IncidentMatchRow): AdminIncidentMatchRecord {
  return {
    id: row.id,
    securityIncidentId: row.security_incident_id,
    caseId: row.case_id,
    passportVersionId: row.passport_version_id,
    matchBasisJson: row.match_basis_json,
    status: row.status,
    reviewedByAdminId: row.reviewed_by_admin_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export function listSecurityIncidentsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
): AdminSecurityIncidentRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT * FROM security_incidents ORDER BY published_at DESC, id DESC')
    .all() as SecurityIncidentRow[];

  return rows.map(mapSecurityIncident);
}

export function listIncidentMatchesForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  securityIncidentId: string,
): AdminIncidentMatchRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT * FROM incident_matches
       WHERE security_incident_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(securityIncidentId) as IncidentMatchRow[];

  return rows.map(mapIncidentMatch);
}
