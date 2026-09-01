import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

export function verifyBackup(backupDir: string): { ok: boolean; cutoffSequence: number } {
  const manifest = JSON.parse(readFileSync(`${backupDir}/manifest.json`, 'utf8')) as { entries?: Array<{ path: string; sha256: string }>; cutoffSequence?: number };
  for (const entry of manifest.entries ?? []) { const hash = createHash('sha256').update(readFileSync(`${backupDir}/${entry.path}`)).digest('hex'); if (hash !== entry.sha256) throw new Error(`backup hash mismatch: ${entry.path}`); }
  const db = new Database(`${backupDir}/flowpass.sqlite3`, { readonly: true });
  try { const result = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check; if (result !== 'ok') throw new Error('restored database integrity check failed'); return { ok: true, cutoffSequence: manifest.cutoffSequence ?? 0 }; } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.FLOWPASS_BACKUP_PATH;
  if (!path) { console.error('FLOWPASS_BACKUP_PATH is required'); process.exitCode = 1; } else { try { console.log(JSON.stringify(verifyBackup(path))); } catch (error) { console.error(error instanceof Error ? error.message : 'restore check failed'); process.exitCode = 1; } }
}
