import type { FlowPassDatabase } from '../db/connection';
import { accessSync, constants } from 'node:fs';

export function localReadiness(database: FlowPassDatabase, vaultPath?: string): { ready: boolean; database: string; vault: string; migrations: string } {
  let databaseState = 'failed';
  try { databaseState = (database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check === 'ok' ? 'ready' : 'failed'; } catch { databaseState = 'failed'; }
  let vaultState = 'skipped';
  if (vaultPath) { try { accessSync(vaultPath, constants.R_OK | constants.W_OK); vaultState = 'ready'; } catch { vaultState = 'failed'; } }
  let migrations = 'failed';
  try { migrations = Number((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count) > 0 ? 'ready' : 'failed'; } catch { migrations = 'failed'; }
  return { ready: databaseState === 'ready' && migrations === 'ready' && vaultState !== 'failed', database: databaseState, vault: vaultState, migrations };
}
