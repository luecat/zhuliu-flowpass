import type { FlowPassDatabase } from '../db/connection';
import type { FlowPassPassport } from '../../shared/passport-contract';

function resolveToolProductId(database: FlowPassDatabase, label: string): string | undefined {
  const trimmed = label.trim();
  if (!trimmed || trimmed === 'unknown') return undefined;
  const tool = database.prepare(`
    SELECT tool_products.id
    FROM tool_products
    LEFT JOIN json_each(tool_products.aliases_json) AS alias
    WHERE tool_products.status = 'active'
      AND (
        lower(tool_products.canonical_name) = lower(?)
        OR lower(CAST(alias.value AS TEXT)) = lower(?)
      )
    ORDER BY tool_products.id
    LIMIT 1
  `).get(trimmed, trimmed) as { id: string } | undefined;
  return tool?.id;
}

/** Rebuild node/edge/tool indexes for a passport version. Matches requested_tool and ai_tool node labels. */
export function rebuildPassportIndexes(
  database: FlowPassDatabase,
  passportVersionId: string,
  passport: FlowPassPassport,
  idGenerator: () => string,
): void {
  database.prepare('DELETE FROM passport_edge_index WHERE passport_version_id = ?').run(passportVersionId);
  database.prepare('DELETE FROM passport_node_index WHERE passport_version_id = ?').run(passportVersionId);
  database.prepare('DELETE FROM passport_tool_index WHERE passport_version_id = ?').run(passportVersionId);

  for (const node of passport.nodes) {
    database.prepare(
      `INSERT INTO passport_node_index (id, passport_version_id, node_key, kind, data_category, sensitivity, needs_confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(idGenerator(), passportVersionId, node.id, node.kind, node.data_category, node.sensitivity, node.needs_confirmation ? 1 : 0);
  }

  for (const edge of passport.edges) {
    database.prepare(
      `INSERT INTO passport_edge_index (id, passport_version_id, edge_key, from_node_key, to_node_key, purpose_code, needs_confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(idGenerator(), passportVersionId, edge.id, edge.from_node_id, edge.to_node_id, edge.purpose, edge.needs_confirmation ? 1 : 0);
  }

  type Candidate = { label: string; nodeKey: string; needsConfirmation: boolean };
  const candidates: Candidate[] = [];
  const toolNodes = passport.nodes.filter((node) => node.kind === 'ai_tool');
  const primaryNode = toolNodes[0];
  const requested = passport.administrative_hints.requested_tool.trim();
  if (requested && requested !== 'unknown' && primaryNode) {
    candidates.push({ label: requested, nodeKey: primaryNode.id, needsConfirmation: primaryNode.needs_confirmation });
  }
  for (const node of toolNodes) {
    const label = node.label.trim();
    if (!label || label === 'unknown') continue;
    candidates.push({ label, nodeKey: node.id, needsConfirmation: node.needs_confirmation });
  }

  const insertedProducts = new Set<string>();
  for (const candidate of candidates) {
    const productId = resolveToolProductId(database, candidate.label);
    if (!productId || insertedProducts.has(productId)) continue;
    insertedProducts.add(productId);
    database.prepare(
      `INSERT INTO passport_tool_index (id, passport_version_id, node_key, tool_product_id, tool_version_id, user_visible_label_enc, usage_start_at, usage_end_at, needs_confirmation) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(idGenerator(), passportVersionId, candidate.nodeKey, productId, candidate.needsConfirmation ? 1 : 0);
  }
}
