import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from './connection';
import { decryptDatabaseText } from './repositories/encrypted-fields';
import { idempotencyRecordId } from './repositories/idempotency';

export interface PassportRelationGraph {
  caseId: string;
  caseCode: string;
  applicantId: string;
  passportId: string;
  preservedSiblingCases: number;
  tableIds: Record<string, string[]>;
  attachments: Array<{
    documentId: string;
    storageId: string;
    keyId: string;
    sha256: string;
    byteSize: number;
  }>;
}

interface RootRow {
  id: string;
  case_code: string;
  applicant_id: string;
  passport_id: string;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function ids(database: FlowPassDatabase, sql: string, ...params: unknown[]): string[] {
  return unique((database.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id));
}

function textValues(graph: PassportRelationGraph): string[] {
  return unique([
    graph.caseId,
    graph.caseCode,
    graph.passportId,
    ...Object.values(graph.tableIds).flat(),
  ]);
}

function jsonReferencedJobIds(database: FlowPassDatabase, values: string[]): string[] {
  if (values.length === 0) return [];
  const placeholders = values.map(() => '?').join(', ');
  return ids(
    database,
    `SELECT DISTINCT jobs.id AS id
     FROM jobs, json_tree(jobs.payload_json) AS node
     WHERE node.type = 'text' AND CAST(node.value AS TEXT) IN (${placeholders})`,
    ...values,
  );
}

function attributableIdempotencyIds(
  database: FlowPassDatabase,
  crypto: FieldCrypto | undefined,
  graph: PassportRelationGraph,
): string[] {
  const values = textValues(graph);
  const rows = database.prepare(`
    SELECT scope, key, response_enc
    FROM api_idempotency_keys
    WHERE scope LIKE ? OR scope LIKE ?
  `).all(`%${graph.caseId}%`, `%${graph.caseCode}%`) as Array<{ scope: string; key: string; response_enc: string }>;
  if (crypto) {
    const allRows = database.prepare('SELECT scope, key, response_enc FROM api_idempotency_keys').all() as typeof rows;
    for (const row of allRows) {
      if (rows.some((candidate) => candidate.scope === row.scope && candidate.key === row.key)) continue;
      try {
        const response = decryptDatabaseText(
          crypto,
          'api_idempotency_keys',
          'response_enc',
          idempotencyRecordId(row.scope, row.key),
          row.response_enc,
        );
        if (values.some((value) => response.includes(value))) rows.push(row);
      } catch {
        // An unreadable unrelated idempotency row is not broadened into the purge.
      }
    }
  }
  return unique(rows.map((row) => `${row.scope}\u0000${row.key}`));
}

export function collectPassportRelationGraph(
  database: FlowPassDatabase,
  caseId: string,
  crypto?: FieldCrypto,
  includeCasesWithoutPassport = false,
): PassportRelationGraph | null {
  const root = database.prepare(`
    SELECT cases.id, cases.case_code, cases.applicant_id, passports.id AS passport_id
    FROM cases
    ${includeCasesWithoutPassport ? 'LEFT JOIN' : 'JOIN'} passports ON passports.case_id = cases.id
    WHERE cases.id = ? AND cases.deleted_at IS NULL
  `).get(caseId) as RootRow | undefined;
  if (!root) return null;

  const tableIds: Record<string, string[]> = {
    cases: [root.id],
    passports: root.passport_id ? [root.passport_id] : [],
    answer_versions: ids(database, 'SELECT id FROM answer_versions WHERE case_id = ?', caseId),
    case_state_transitions: ids(database, 'SELECT id FROM case_state_transitions WHERE case_id = ?', caseId),
    passport_versions: root.passport_id ? ids(database, 'SELECT id FROM passport_versions WHERE passport_id = ?', root.passport_id) : [],
    documents: ids(database, 'SELECT id FROM documents WHERE case_id = ?', caseId),
    rule_evaluations: ids(database, 'SELECT id FROM rule_evaluations WHERE case_id = ?', caseId),
    subsidy_calculations: ids(database, 'SELECT id FROM subsidy_calculations WHERE case_id = ?', caseId),
    case_tasks: ids(database, 'SELECT id FROM case_tasks WHERE case_id = ?', caseId),
    notification_jobs: ids(database, 'SELECT id FROM notification_jobs WHERE case_id = ?', caseId),
    incident_matches: ids(database, 'SELECT id FROM incident_matches WHERE case_id = ?', caseId),
    alerts: ids(database, 'SELECT id FROM alerts WHERE case_id = ?', caseId),
    timeline_events: ids(database, 'SELECT id FROM timeline_events WHERE case_id = ?', caseId),
    ai_runs: ids(database, 'SELECT id FROM ai_runs WHERE case_id = ?', caseId),
    jobs: ids(database, `SELECT id FROM jobs
      WHERE job_type = 'ai_draft'
        AND json_type(payload_json, '$.caseId') = 'text'
        AND json_extract(payload_json, '$.caseId') = ?`, caseId),
    admin_data_edit_audits: ids(database, 'SELECT id FROM admin_data_edit_audits WHERE case_id = ?', caseId),
    admin_purge_authorizations: ids(database, 'SELECT id FROM admin_purge_authorizations WHERE case_id = ?', caseId),
  };

  const passportVersionIds = tableIds.passport_versions;
  const inPassportVersions = passportVersionIds.length > 0 ? passportVersionIds.map(() => '?').join(', ') : "''";

  tableIds.passport_node_index = ids(database, `SELECT id FROM passport_node_index WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);
  tableIds.passport_edge_index = ids(database, `SELECT id FROM passport_edge_index WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);
  tableIds.passport_tool_index = ids(database, `SELECT id FROM passport_tool_index WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);
  tableIds.passport_follow_up_questions = ids(database, `SELECT id FROM passport_follow_up_questions WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);
  tableIds.passport_follow_up_answers = ids(database, `SELECT id FROM passport_follow_up_answers WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);
  tableIds.passport_confirmations = ids(database, `SELECT id FROM passport_confirmations WHERE passport_version_id IN (${inPassportVersions})`, ...passportVersionIds);

  const graph: PassportRelationGraph = {
    caseId: root.id,
    caseCode: root.case_code,
    applicantId: root.applicant_id,
    passportId: root.passport_id ?? '',
    preservedSiblingCases: Number((database.prepare(`
      SELECT COUNT(*) AS count FROM cases
      WHERE applicant_id = ? AND id <> ? AND deleted_at IS NULL
    `).get(root.applicant_id, caseId) as { count: number }).count),
    tableIds,
    attachments: (database.prepare(`
      SELECT id, storage_id, key_id, content_sha256, byte_size
      FROM documents WHERE case_id = ?
    `).all(caseId) as Array<{ id: string; storage_id: string; key_id: string; content_sha256: string; byte_size: number }>).map((row) => ({
      documentId: row.id,
      storageId: row.storage_id,
      keyId: row.key_id,
      sha256: row.content_sha256,
      byteSize: row.byte_size,
    })),
  };

  tableIds.jobs = jsonReferencedJobIds(database, textValues(graph));
  const entityIds = textValues(graph);
  const inEntities = entityIds.length > 0 ? entityIds.map(() => '?').join(', ') : "''";
  tableIds.audit_logs = ids(database, `SELECT id FROM audit_logs WHERE entity_id IN (${inEntities})`, ...entityIds);
  tableIds.api_idempotency_keys = attributableIdempotencyIds(database, crypto, graph);
  tableIds.case_purchase_details = database.prepare('SELECT case_id AS id FROM case_purchase_details WHERE case_id = ?').all(caseId).map((row) => (row as { id: string }).id);

  return graph;
}
