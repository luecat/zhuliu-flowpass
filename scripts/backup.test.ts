import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDatabase, flowPassDatabasePath } from '../server/db/connection';
import { createVerifiedBackup } from './backup';
import { verifyBackup } from './restore-check';

describe('verified backup', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  it('uses the online backup API and restores an integrity-checked generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpass-backup-')); roots.push(root);
    const db = openMigratedDatabase(flowPassDatabasePath(root));
    db.close();
    const result = await createVerifiedBackup({ dataRoot: root, backupRoot: join(root, 'backups'), now: new Date('2026-08-31T00:00:00.000Z') });
    expect(result.cutoffSequence).toBe(0); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyBackup(result.path)).toEqual({ ok: true, cutoffSequence: 0 });
  });
});
