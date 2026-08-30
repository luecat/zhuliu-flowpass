import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface ToolProductRow {
  id: string;
  vendor: string;
  canonical_name: string;
  aliases_json: string;
  status: 'active' | 'retired';
  created_at: string;
  row_version: number;
}

export interface ToolProductRecord {
  id: string;
  vendor: string;
  canonicalName: string;
  aliasesJson: string;
  status: 'active' | 'retired';
  createdAt: string;
  rowVersion: number;
}

interface ToolVersionRow {
  id: string;
  tool_product_id: string;
  version_label: string;
  released_at: string | null;
  retired_at: string | null;
  policy_json: string;
  source_url: string | null;
  confirmed_at: string | null;
  status: string;
}

export interface ToolVersionRecord {
  id: string;
  toolProductId: string;
  versionLabel: string;
  releasedAt: string | null;
  retiredAt: string | null;
  policyJson: string;
  sourceUrl: string | null;
  confirmedAt: string | null;
  status: string;
}

function mapToolProduct(row: ToolProductRow): ToolProductRecord {
  return {
    id: row.id,
    vendor: row.vendor,
    canonicalName: row.canonical_name,
    aliasesJson: row.aliases_json,
    status: row.status,
    createdAt: row.created_at,
    rowVersion: row.row_version,
  };
}

function mapToolVersion(row: ToolVersionRow): ToolVersionRecord {
  return {
    id: row.id,
    toolProductId: row.tool_product_id,
    versionLabel: row.version_label,
    releasedAt: row.released_at,
    retiredAt: row.retired_at,
    policyJson: row.policy_json,
    sourceUrl: row.source_url,
    confirmedAt: row.confirmed_at,
    status: row.status,
  };
}

export function listActiveToolProductsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
): ToolProductRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(`SELECT * FROM tool_products WHERE status = 'active' ORDER BY vendor ASC, canonical_name ASC`)
    .all() as ToolProductRow[];

  return rows.map(mapToolProduct);
}

export function listToolProductsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
): ToolProductRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT * FROM tool_products ORDER BY vendor ASC, canonical_name ASC')
    .all() as ToolProductRow[];

  return rows.map(mapToolProduct);
}

export function listToolVersionsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  toolProductId: string,
): ToolVersionRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT * FROM tool_versions WHERE tool_product_id = ? ORDER BY released_at DESC, id DESC')
    .all(toolProductId) as ToolVersionRow[];

  return rows.map(mapToolVersion);
}
