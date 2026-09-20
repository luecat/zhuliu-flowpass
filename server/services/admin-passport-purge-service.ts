import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import { hashToken } from '../crypto/token-hash';
import { collectPassportRelationGraph, type PassportRelationGraph } from '../db/admin-passport-relation-registry';
import type { FlowPassDatabase } from '../db/connection';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { verifyAdminPassword } from '../admin/auth/password';
import { acquireMaintenanceMode, releaseMaintenanceMode, updateMaintenancePhase } from './maintenance-mode';
import type { DocumentVault, QuarantinedVaultFile } from './document-vault';
import { createVerifiedBackupFromDatabase } from '../../scripts/backup';
import type { PurgeAuthorization, PurgePreview, PurgeResult } from '../../shared/admin-data-management-contract';

export type AdminPassportPurgeErrorCode = 'NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PASSWORD_REJECTED' | 'AUTHORIZATION_REJECTED' | 'MAINTENANCE_CONFLICT' | 'ACTIVE_JOBS' | 'PURGE_FAILED';
export class AdminPassportPurgeError extends Error {
  constructor(readonly code: AdminPassportPurgeErrorCode) { super(code); this.name = 'AdminPassportPurgeError'; }
}

export interface PurgeDependencies {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  documentVault: DocumentVault;
  dataRoot: string;
  backupRoot: string;
  clock?: () => Date;
  idGenerator?: () => string;
}

function assertBackupRoot(dataRoot: string, backupRoot: string): void {
  if (resolve(backupRoot) !== resolve(dataRoot, 'backups')) throw new AdminPassportPurgeError('PURGE_FAILED');
}

function listBackups(backupRoot: string): Array<{ name: string; createdAt?: string }> {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, createdAt: statSync(join(backupRoot, entry.name)).mtime.toISOString() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalPreview(graph: PassportRelationGraph, backups: Array<{ name: string; createdAt?: string }>) {
  return {
    caseId: graph.caseId,
    caseCode: graph.caseCode,
    passportId: graph.passportId,
    preservedSiblingCases: graph.preservedSiblingCases,
    tables: Object.entries(graph.tableIds)
      .filter(([table]) => table !== 'admin_purge_authorizations')
      .map(([table, ids]) => ({ table, ids: [...ids].sort() }))
      .filter((item) => item.ids.length > 0)
      .sort((left, right) => left.table.localeCompare(right.table)),
    attachments: graph.attachments.map((item) => ({ documentId: item.documentId, storageId: item.storageId, sha256: item.sha256, byteSize: item.byteSize })).sort((left, right) => left.documentId.localeCompare(right.documentId)),
    backups: backups.map((item) => item.name).sort(),
  };
}

function previewHash(graph: PassportRelationGraph, backups: Array<{ name: string; createdAt?: string }>): string {
  return createHash('sha256').update(JSON.stringify(canonicalPreview(graph, backups))).digest('hex');
}

function graphFor(dependencies: PurgeDependencies, caseId: string): PassportRelationGraph {
  const graph = collectPassportRelationGraph(dependencies.database, caseId, dependencies.crypto);
  if (!graph) throw new AdminPassportPurgeError('NOT_FOUND');
  return graph;
}

export function previewPassportPurge(dependencies: PurgeDependencies, caseId: string): PurgePreview {
  assertBackupRoot(dependencies.dataRoot, dependencies.backupRoot);
  const graph = graphFor(dependencies, caseId);
  const backups = listBackups(dependencies.backupRoot);
  const applicantRow = dependencies.database.prepare('SELECT display_label_enc FROM applicants WHERE id = ?').get(graph.applicantId) as { display_label_enc: string };
  let applicantLabel = '申請人';
  try {
    applicantLabel = decryptDatabaseText(dependencies.crypto, 'applicants', 'display_label_enc', graph.applicantId, applicantRow.display_label_enc);
  } catch { /* safe fallback */ }
  return {
    caseId: graph.caseId,
    caseCode: graph.caseCode,
    passportId: graph.passportId,
    applicantLabel,
    preservedSiblingCases: graph.preservedSiblingCases,
    tables: Object.entries(graph.tableIds).filter(([table, ids]) => table !== 'admin_purge_authorizations' && ids.length > 0).map(([table, ids]) => ({ table, count: ids.length, ids })),
    attachments: graph.attachments.map(({ documentId, storageId, sha256, byteSize }) => ({ documentId, storageId, sha256, byteSize })),
    attachmentBytes: graph.attachments.reduce((sum, item) => sum + item.byteSize, 0),
    backups,
    previewHash: previewHash(graph, backups),
    generatedAt: (dependencies.clock?.() ?? new Date()).toISOString(),
  };
}

export async function authorizePassportPurge(
  dependencies: PurgeDependencies,
  input: { caseId: string; adminId: string; previewHash: string; caseCode: string; password: string },
): Promise<PurgeAuthorization> {
  const preview = previewPassportPurge(dependencies, input.caseId);
  if (preview.previewHash !== input.previewHash || preview.caseCode !== input.caseCode) throw new AdminPassportPurgeError('PREVIEW_EXPIRED');
  const admin = dependencies.database.prepare('SELECT password_hash FROM admin_users WHERE id = ? AND status = ?').get(input.adminId, 'active') as { password_hash: string } | undefined;
  if (!admin || !await verifyAdminPassword(input.password, admin.password_hash)) throw new AdminPassportPurgeError('PASSWORD_REJECTED');
  const now = dependencies.clock?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const token = randomBytes(32).toString('base64url');
  dependencies.database.prepare(`
    INSERT INTO admin_purge_authorizations (id, token_hash, admin_user_id, case_id, preview_hash, expires_at, consumed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run((dependencies.idGenerator ?? uuidv7)(), hashToken(token), input.adminId, input.caseId, input.previewHash, expiresAt, now.toISOString());
  return { token, expiresAt };
}

const IMMUTABLE_DELETE_TABLES = new Set(['answer_versions', 'passport_versions', 'case_state_transitions', 'passport_follow_up_answers', 'passport_confirmations', 'rule_evaluations', 'subsidy_calculations', 'timeline_events', 'audit_logs', 'ai_runs']);
const DELETE_ORDER = [
  'notification_jobs', 'case_tasks', 'passport_follow_up_answers', 'passport_confirmations',
  'passport_follow_up_questions', 'passport_edge_index', 'passport_tool_index', 'passport_node_index',
  'subsidy_calculations', 'rule_evaluations', 'ai_runs', 'timeline_events', 'case_state_transitions',
  'alerts', 'incident_matches', 'jobs', 'audit_logs', 'admin_data_edit_audits',
  'passport_versions', 'answer_versions', 'case_purchase_details', 'documents', 'passports',
  'admin_purge_authorizations', 'cases',
] as const;

export function grantDeletes(database: FlowPassDatabase, graph: PassportRelationGraph, operationId: string, expiresAt: string, idGenerator: () => string): void {
  const insert = database.prepare(`INSERT INTO admin_data_mutation_guards (id, operation_id, table_name, record_id, action, expires_at) VALUES (?, ?, ?, ?, 'delete', ?)`);
  for (const [table, ids] of Object.entries(graph.tableIds)) {
    if (!IMMUTABLE_DELETE_TABLES.has(table)) continue;
    for (const id of ids) insert.run(idGenerator(), operationId, table, id, expiresAt);
  }
}

export function deleteGraph(database: FlowPassDatabase, graph: PassportRelationGraph, operationId: string): number {
  let removed = 0;
  for (const table of DELETE_ORDER) {
    let ids = graph.tableIds[table] ?? [];
    if (table === 'passport_versions' && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      ids = (database.prepare(`SELECT id FROM passport_versions WHERE id IN (${placeholders}) ORDER BY version_no DESC`).all(...ids) as Array<{ id: string }>).map((row) => row.id);
    }
    for (const id of ids) {
      if (table === 'case_purchase_details') removed += database.prepare('DELETE FROM case_purchase_details WHERE case_id = ?').run(id).changes;
      else removed += database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes;
    }
  }
  for (const composite of graph.tableIds.api_idempotency_keys ?? []) {
    const [scope, key] = composite.split('\u0000');
    removed += database.prepare('DELETE FROM api_idempotency_keys WHERE scope = ? AND key = ?').run(scope, key).changes;
  }
  database.prepare('DELETE FROM admin_data_mutation_guards WHERE operation_id = ?').run(operationId);
  return removed;
}

export async function executePassportPurge(
  dependencies: PurgeDependencies,
  input: { caseId: string; adminId: string; token: string },
): Promise<PurgeResult> {
  assertBackupRoot(dependencies.dataRoot, dependencies.backupRoot);
  const now = dependencies.clock?.() ?? new Date();
  const authorization = dependencies.database.prepare(`
    SELECT id, preview_hash, expires_at, consumed_at FROM admin_purge_authorizations
    WHERE token_hash = ? AND admin_user_id = ? AND case_id = ?
  `).get(hashToken(input.token), input.adminId, input.caseId) as { id: string; preview_hash: string; expires_at: string; consumed_at: string | null } | undefined;
  if (!authorization || authorization.consumed_at || Date.parse(authorization.expires_at) <= now.getTime()) throw new AdminPassportPurgeError('AUTHORIZATION_REJECTED');
  const currentPreview = previewPassportPurge(dependencies, input.caseId);
  if (currentPreview.previewHash !== authorization.preview_hash) throw new AdminPassportPurgeError('PREVIEW_EXPIRED');
  const operationId = (dependencies.idGenerator ?? uuidv7)();
  try { acquireMaintenanceMode(dependencies.database, operationId, now); }
  catch { throw new AdminPassportPurgeError('MAINTENANCE_CONFLICT'); }

  let quarantined: QuarantinedVaultFile[] = [];
  let recoveryPath: string | null = null;
  let committed = false;
  try {
    const leased = dependencies.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state = 'leased'").get() as { count: number };
    if (leased.count > 0) throw new AdminPassportPurgeError('ACTIVE_JOBS');
    dependencies.database.prepare('UPDATE admin_purge_authorizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now.toISOString(), authorization.id);
    updateMaintenancePhase(dependencies.database, operationId, 'backup', now);
    const recovery = await createVerifiedBackupFromDatabase({ database: dependencies.database, backupRoot: dependencies.backupRoot, name: `.purge-recovery-${operationId}` });
    recoveryPath = recovery.path;
    const graph = graphFor(dependencies, input.caseId);
    quarantined = dependencies.documentVault.quarantine(graph.attachments.map((item) => ({ id: item.documentId, storageId: item.storageId, keyId: item.keyId })), operationId);
    updateMaintenancePhase(dependencies.database, operationId, 'deleting');
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    let removedRows = 0;
    dependencies.database.transaction(() => {
      grantDeletes(dependencies.database, graph, operationId, expiresAt, dependencies.idGenerator ?? uuidv7);
      removedRows = deleteGraph(dependencies.database, graph, operationId);
      if (dependencies.database.prepare('SELECT 1 FROM cases WHERE id = ?').get(input.caseId)) throw new Error('target case remains');
      const siblings = Number((dependencies.database.prepare('SELECT COUNT(*) AS count FROM cases WHERE applicant_id = ? AND id <> ? AND deleted_at IS NULL').get(graph.applicantId, input.caseId) as { count: number }).count);
      if (siblings !== graph.preservedSiblingCases) throw new Error('sibling invariant changed');
    })();
    committed = true;
    updateMaintenancePhase(dependencies.database, operationId, 'clean-backup');
    const clean = await createVerifiedBackupFromDatabase({ database: dependencies.database, backupRoot: dependencies.backupRoot, name: `clean-${operationId}` });
    updateMaintenancePhase(dependencies.database, operationId, 'physical-cleanup');
    const oldBackups = listBackups(dependencies.backupRoot).filter((item) => join(dependencies.backupRoot, item.name) !== clean.path);
    for (const backup of oldBackups) rmSync(join(dependencies.backupRoot, backup.name), { recursive: true, force: true });
    dependencies.documentVault.purgeQuarantine(quarantined);
    releaseMaintenanceMode(dependencies.database, operationId);
    return { caseCode: graph.caseCode, removedRows, removedAttachments: quarantined.length, removedBackups: oldBackups.length, completedAt: (dependencies.clock?.() ?? new Date()).toISOString() };
  } catch (error) {
    if (!committed) {
      try { dependencies.documentVault.restoreQuarantine(quarantined); } catch { /* maintenance remains if restore fails */ }
      if (recoveryPath) rmSync(recoveryPath, { recursive: true, force: true });
      try { releaseMaintenanceMode(dependencies.database, operationId); } catch { /* fail closed */ }
    } else {
      try { updateMaintenancePhase(dependencies.database, operationId, 'recovery-required'); } catch { /* fail closed */ }
    }
    if (error instanceof AdminPassportPurgeError) throw error;
    throw new AdminPassportPurgeError('PURGE_FAILED');
  }
}
