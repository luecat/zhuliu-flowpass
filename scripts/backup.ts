import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { flowPassDatabasePath, openMigratedDatabase } from '../server/db/connection';

export async function createVerifiedBackup(input: { dataRoot: string; backupRoot: string; now?: Date }): Promise<{ path: string; sha256: string; cutoffSequence: number }> {
  const source = openMigratedDatabase(flowPassDatabasePath(input.dataRoot));
  const stamp = (input.now ?? new Date()).toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const targetDir = join(input.backupRoot, stamp);
  mkdirSync(input.backupRoot, { recursive: true });
  mkdirSync(targetDir, { recursive: false });
  const targetDb = join(targetDir, 'flowpass.sqlite3');
  try {
    const cutoffSequence = Number((source.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max FROM timeline_events').get() as { max: number }).max);
    const backup = (source as unknown as { backup: (path: string) => Promise<void> }).backup;
    if (typeof backup !== 'function') throw new Error('SQLite online backup API unavailable');
    await backup.call(source, targetDb);
    const sha256 = createHash('sha256').update(readFileSync(targetDb)).digest('hex');
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify({ format: 'flowpass-backup-v1', createdAt: new Date().toISOString(), cutoffSequence, entries: [{ path: 'flowpass.sqlite3', sha256 }] }, null, 2), { mode: 0o600 });
    return { path: targetDir, sha256, cutoffSequence };
  } finally { source.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataRoot = process.env.FLOWPASS_DATA_ROOT ?? join(process.cwd(), '.flowpass-local');
  const backupRoot = process.env.FLOWPASS_BACKUP_ROOT ?? join(dataRoot, 'backups');
  void createVerifiedBackup({ dataRoot, backupRoot }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error instanceof Error ? error.message : 'backup failed'); process.exitCode = 1; });
}
