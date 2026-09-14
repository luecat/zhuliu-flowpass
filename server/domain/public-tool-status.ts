import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { inspectPassportDocument } from './passport-validation';
import { passportToolLabels, toolLabelsMatch } from './submission-checks';
import type { FlowPassPassport } from '../../shared/passport-contract';

export type PublicToolIncident = {
  toolName: string;
  vendor: string | null;
  title: string;
  severity: string;
  incidentStartAt: string | null;
  incidentEndAt: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  recommendedActions: string[];
  relevantToPassport: boolean;
};

export type PersonalizedToolImpact = {
  caseId: string;
  caseCode: string;
  passportTitle: string;
  status: string;
  severity: string;
  summary: string;
  incidentTitle: string | null;
  guidance: string | null;
  affectedDataKinds: string[];
  sharingAudience: string | null;
};

export type PassportToolCheck = {
  tools: string[];
  cases: Array<{ caseCode: string; tools: string[] }>;
  incidents: PublicToolIncident[];
  impacts: PersonalizedToolImpact[];
};

function parseActions(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string').slice(0, 8);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)) {
      return ((parsed as { actions: unknown[] }).actions)
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 8);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function listPublishedIncidents(database: FlowPassDatabase): Array<PublicToolIncident & { aliases: string[] }> {
  const rows = database.prepare(`
    SELECT tp.canonical_name AS tool_name, tp.vendor AS vendor, si.title AS title, si.severity AS severity,
           si.incident_start_at AS incident_start_at, si.incident_end_at AS incident_end_at,
           si.source_title AS source_title, si.source_url AS source_url, si.published_at AS published_at,
           si.recommended_actions_json AS recommended_actions_json, tp.aliases_json AS aliases_json
    FROM security_incidents si
    JOIN tool_products tp ON tp.id = si.tool_product_id
    WHERE si.state IN ('published', 'resolved')
    ORDER BY COALESCE(si.published_at, si.source_published_at) DESC, si.id DESC
    LIMIT 80
  `).all() as Array<{
    tool_name: string;
    vendor: string | null;
    title: string;
    severity: string;
    incident_start_at: string | null;
    incident_end_at: string | null;
    source_title: string | null;
    source_url: string | null;
    published_at: string | null;
    recommended_actions_json: string;
    aliases_json: string;
  }>;

  return rows.map((row) => ({
    toolName: row.tool_name,
    vendor: row.vendor,
    title: row.title,
    severity: row.severity,
    incidentStartAt: row.incident_start_at,
    incidentEndAt: row.incident_end_at,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    publishedAt: row.published_at,
    recommendedActions: parseActions(row.recommended_actions_json),
    aliases: parseAliases(row.aliases_json),
    relevantToPassport: false,
  }));
}

function incidentMatchesTools(incident: PublicToolIncident & { aliases: string[] }, tools: string[]): boolean {
  const candidates = [incident.toolName, incident.vendor ?? '', ...incident.aliases];
  return tools.some((tool) => candidates.some((candidate) => candidate && toolLabelsMatch(tool, candidate)));
}

export function queryPublicToolIncidents(
  database: FlowPassDatabase,
  toolQuery?: string | null,
): PublicToolIncident[] {
  const needle = toolQuery?.trim() ?? '';
  if (needle.length > 120) return [];
  return listPublishedIncidents(database)
    .filter((row) => !needle || incidentMatchesTools(row, [needle]))
    .slice(0, needle ? 10 : 20)
    .map(({ aliases: _aliases, ...incident }) => ({ ...incident, relevantToPassport: false }));
}

function readPassportFromVersion(
  crypto: FieldCrypto,
  passportVersionId: string,
  payloadEnc: string,
): FlowPassPassport | null {
  try {
    const raw = JSON.parse(
      decryptDatabaseText(crypto, 'passport_versions', 'payload_enc', passportVersionId, payloadEnc),
    ) as unknown;
    const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && 'passport_draft' in raw
      ? raw
      : { passport_draft: raw };
    return inspectPassportDocument(wrapped).canonical;
  } catch {
    return null;
  }
}

export function queryPersonalizedToolImpact(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: { applicantId: string; toolQuery?: string | null },
): PersonalizedToolImpact[] {
  const needle = input.toolQuery?.trim().toLowerCase() ?? '';
  const rows = database.prepare(`
    SELECT c.id AS case_id, c.case_code AS case_code, a.status AS status, a.severity AS severity,
           a.public_summary AS summary, a.public_guidance AS guidance, si.title AS incident_title,
           a.passport_version_id AS passport_version_id, pv.payload_enc AS payload_enc,
           tp.canonical_name AS tool_name, tp.aliases_json AS aliases_json
    FROM alerts a
    JOIN incident_matches im ON im.id = a.incident_match_id
    JOIN security_incidents si ON si.id = im.security_incident_id
    JOIN tool_products tp ON tp.id = si.tool_product_id
    JOIN cases c ON c.id = a.case_id AND c.applicant_id = ? AND c.deleted_at IS NULL
    JOIN passport_versions pv ON pv.id = a.passport_version_id
    WHERE a.status IN ('open', 'acknowledged', 'resolved')
    ORDER BY a.created_at DESC
    LIMIT 20
  `).all(input.applicantId) as Array<{
    case_id: string;
    case_code: string;
    status: string;
    severity: string;
    summary: string;
    guidance: string | null;
    incident_title: string | null;
    passport_version_id: string;
    payload_enc: string;
    tool_name: string;
    aliases_json: string;
  }>;

  return rows
    .filter((row) => {
      if (!needle) return true;
      const aliases = parseAliases(row.aliases_json);
      return [row.tool_name, ...aliases].join(' ').toLowerCase().includes(needle);
    })
    .map((row) => {
      const passport = readPassportFromVersion(crypto, row.passport_version_id, row.payload_enc);
      const passportTitle = passport?.use_case.title?.trim() || '你的護照';
      const affectedDataKinds = passport
        ? [...new Set(passport.nodes.filter((node) => node.kind === 'data').map((node) => node.label).filter(Boolean))].slice(0, 6)
        : [];
      return {
        caseId: row.case_id,
        caseCode: row.case_code,
        passportTitle,
        status: row.status,
        severity: row.severity,
        summary: row.summary,
        incidentTitle: row.incident_title,
        guidance: row.guidance,
        affectedDataKinds,
        sharingAudience: null,
      };
    });
}

/** Published incidents are public to everyone; passport tools only mark personal relevance. */
export function queryPassportToolStatus(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  applicantId: string,
): PassportToolCheck {
  const rows = database.prepare(`
    SELECT c.case_code AS case_code, pv.id AS passport_version_id, pv.payload_enc AS payload_enc
    FROM cases c
    JOIN passport_versions pv ON pv.id = COALESCE(c.submitted_passport_version_id, c.current_passport_version_id)
    WHERE c.applicant_id = ?
      AND c.deleted_at IS NULL
      AND pv.workflow_state IN ('confirmed', 'locked')
    ORDER BY c.updated_at DESC
    LIMIT 12
  `).all(applicantId) as Array<{
    case_code: string;
    passport_version_id: string;
    payload_enc: string;
  }>;

  const cases: Array<{ caseCode: string; tools: string[] }> = [];
  const toolSet = new Set<string>();

  for (const row of rows) {
    const passport = readPassportFromVersion(crypto, row.passport_version_id, row.payload_enc);
    if (!passport) continue;
    const tools = passportToolLabels(passport);
    if (tools.length === 0) continue;
    cases.push({ caseCode: row.case_code, tools });
    for (const tool of tools) toolSet.add(tool);
  }

  const tools = [...toolSet];
  const incidents = listPublishedIncidents(database)
    .slice(0, 20)
    .map(({ aliases, ...incident }) => ({
      ...incident,
      relevantToPassport: tools.length > 0 && incidentMatchesTools({ ...incident, aliases }, tools),
    }));
  const impacts = queryPersonalizedToolImpact(database, crypto, { applicantId });

  return { tools, cases, incidents, impacts };
}

/** Public feed only — no applicant identity required. */
export function queryPublicToolStatus(database: FlowPassDatabase): PassportToolCheck {
  return {
    tools: [],
    cases: [],
    incidents: queryPublicToolIncidents(database),
    impacts: [],
  };
}
