import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDatabase, flowPassDatabasePath } from '../server/db/connection';
import { createVerifiedBackup } from './backup';
import { verifyBackup } from './restore-check';

describe('restore check', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  it('rejects a tampered manifest entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpass-restore-')); roots.push(root);
    const db = openMigratedDatabase(flowPassDatabasePath(root)); db.close();
    const backup = await createVerifiedBackup({ dataRoot: root, backupRoot: join(root, 'backups'), now: new Date('2026-08-31T00:00:00.000Z') });
    writeFileSync(join(backup.path, 'flowpass.sqlite3'), 'tampered');
    expect(() => verifyBackup(backup.path)).toThrow('backup hash mismatch');
  });
});
