import { v7 as uuidv7 } from 'uuid';
import { APPROVED_AI_TOOLS } from '../../../shared/approved-ai-tools';
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

/** Idempotently sync the curated subsidy AI-tool list into tool_products. */
export function ensureApprovedToolProducts(
  database: FlowPassDatabase,
  options: { idGenerator?: () => string; now?: () => string } = {},
): number {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now?.() ?? new Date().toISOString();
  const findByVendorName = database.prepare(
    `SELECT id, aliases_json, status FROM tool_products WHERE lower(vendor) = lower(?) AND lower(canonical_name) = lower(?)`,
  );
  const insert = database.prepare(
    `INSERT INTO tool_products (id, vendor, canonical_name, aliases_json, status, created_at, row_version)
     VALUES (?, ?, ?, ?, 'active', ?, 1)`,
  );
  const updateAliases = database.prepare(
    `UPDATE tool_products SET aliases_json = ?, status = 'active', row_version = row_version + 1 WHERE id = ?`,
  );

  let inserted = 0;
  const sync = database.transaction(() => {
    for (const tool of APPROVED_AI_TOOLS) {
      const aliases = [tool.id, tool.label].filter((value, index, all) => all.indexOf(value) === index);
      const existing = findByVendorName.get(tool.company, tool.label) as
        | { id: string; aliases_json: string; status: string }
        | undefined;
      if (!existing) {
        insert.run(idGenerator(), tool.company, tool.label, JSON.stringify(aliases), now);
        inserted += 1;
        continue;
      }
      let currentAliases: string[] = [];
      try {
        const parsed = JSON.parse(existing.aliases_json) as unknown;
        if (Array.isArray(parsed)) currentAliases = parsed.filter((item): item is string => typeof item === 'string');
      } catch {
        currentAliases = [];
      }
      const nextAliases = [...new Set([...currentAliases, ...aliases])];
      const aliasesChanged = nextAliases.length !== currentAliases.length
        || nextAliases.some((alias) => !currentAliases.includes(alias));
      if (aliasesChanged || existing.status !== 'active') {
        updateAliases.run(JSON.stringify(nextAliases), existing.id);
      }
    }
  });
  sync();
  return inserted;
}

export function listActiveToolProductsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
): ToolProductRecord[] {
  requireApplicantScope(scope);
  ensureApprovedToolProducts(database);
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
  ensureApprovedToolProducts(database);
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
