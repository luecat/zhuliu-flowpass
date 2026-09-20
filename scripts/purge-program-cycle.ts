/**
 * Removes every case seeded under a program cycle, together with its applicants,
 * documents and vault files.
 *
 * Deletion reuses the admin purge machinery rather than raw SQL: the immutable
 * tables (passport_versions, rule_evaluations, audit_logs, …) carry BEFORE DELETE
 * triggers that abort unless a matching admin_data_mutation_guards row is in
 * force, so grantDeletes/deleteGraph is the only sanctioned path.
 *
 * The program_cycles and program_rule_versions rows are deliberately left alone:
 * program_rule_versions_published_no_delete (migration 002) has no guard escape
 * hatch, so a published rule version cannot be removed without dropping a schema
 * trigger. The emptied cycle stays as metadata.
 *
 *   npx tsx scripts/purge-program-cycle.ts --code ZZ-DEMO-100-PASSPORTS --dry-run
 *   npx tsx scripts/purge-program-cycle.ts --code ZZ-DEMO-100-PASSPORTS --confirm
 */
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { pathToFileURL } from 'node:url';
import { openDatabase, flowPassDatabasePath } from '../server/db/connection';
import { collectPassportRelationGraph } from '../server/db/admin-passport-relation-registry';
import { deleteGraph, grantDeletes } from '../server/services/admin-passport-purge-service';
import { DocumentVault } from '../server/services/document-vault';
import { FieldCrypto } from '../server/crypto/field-crypto';
import { initializeFieldCryptoAtStartup } from '../server/crypto/keyring';
import { KeychainSecretProvider } from '../server/config/keychain';

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function loadCrypto(): Promise<FieldCrypto> {
  const keyId = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
  return initializeFieldCryptoAtStartup(new KeychainSecretProvider(), {
    activeKeyId: keyId,
    masterKeyRefs: { [keyId]: { service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key' } },
  });
}

async function main(): Promise<void> {
  const code = option('--code');
  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.argv.includes('--confirm');
  if (!code) { console.error('--code <program cycle code> is required'); process.exitCode = 2; return; }
  if (!dryRun && !confirmed) { console.error('refusing to delete without --confirm (or use --dry-run)'); process.exitCode = 2; return; }

  const dataRoot = process.env.FLOWPASS_DATA_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass';
  const database = openDatabase(flowPassDatabasePath(dataRoot));
  const crypto = await loadCrypto();
  const vault = new DocumentVault({ rootPath: join(dataRoot, 'vault'), crypto });

  const cycle = database.prepare('SELECT id, code, name, status FROM program_cycles WHERE code = ?').get(code) as { id: string; code: string; name: string; status: string } | undefined;
  if (!cycle) { console.error(`program cycle not found: ${code}`); process.exitCode = 1; database.close(); return; }

  const cases = database.prepare('SELECT id FROM cases WHERE program_cycle_id = ? AND deleted_at IS NULL').all(cycle.id) as Array<{ id: string }>;
  const applicantIds = new Set((database.prepare('SELECT DISTINCT applicant_id AS id FROM cases WHERE program_cycle_id = ?').all(cycle.id) as Array<{ id: string }>).map((row) => row.id));

  let rowsRemoved = 0; let filesRemoved = 0; let casesRemoved = 0;
  const tableTotals: Record<string, number> = {};

  for (const item of cases) {
    const graph = collectPassportRelationGraph(database, item.id, crypto, true);
    if (!graph) continue;
    for (const [table, ids] of Object.entries(graph.tableIds)) {
      if (ids.length) tableTotals[table] = (tableTotals[table] ?? 0) + ids.length;
    }
    if (dryRun) { casesRemoved += 1; filesRemoved += graph.attachments.length; continue; }

    const operationId = uuidv7();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    database.transaction(() => {
      grantDeletes(database, graph, operationId, expiresAt, uuidv7);
      rowsRemoved += deleteGraph(database, graph, operationId);
    })();
    // Vault files are unlinked only once their rows are gone, so a failed
    // transaction can never leave a document row pointing at a deleted blob.
    for (const attachment of graph.attachments) {
      vault.remove({ id: attachment.documentId, storageId: attachment.storageId, keyId: attachment.keyId });
      filesRemoved += 1;
    }
    casesRemoved += 1;
  }

  let applicantsRemoved = 0;
  for (const applicantId of applicantIds) {
    const remaining = (database.prepare('SELECT COUNT(*) AS count FROM cases WHERE applicant_id = ?').get(applicantId) as { count: number }).count;
    if (remaining > 0) continue;
    if (dryRun) { applicantsRemoved += 1; continue; }
    database.prepare('DELETE FROM line_link_tokens WHERE applicant_id = ?').run(applicantId);
    database.prepare('DELETE FROM applicant_sessions WHERE applicant_id = ?').run(applicantId);
    database.prepare('DELETE FROM line_identities WHERE applicant_id = ?').run(applicantId);
    applicantsRemoved += database.prepare('DELETE FROM applicants WHERE id = ?').run(applicantId).changes;
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'executed',
    cycle: { id: cycle.id, code: cycle.code, name: cycle.name, status: cycle.status },
    casesRemoved, applicantsRemoved, rowsRemoved, filesRemoved,
    tableTotals,
    retained: ['program_cycles', 'program_rule_versions'],
  }, null, 2));
  database.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'purge failed'); process.exitCode = 1; });
}
