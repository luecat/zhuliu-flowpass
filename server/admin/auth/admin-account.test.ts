import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { bootstrapAdminAccount, changeAdminPassword, loginAdmin } from './admin-account';
describe('admin account lifecycle', () => {
  let db: Database.Database;
  beforeEach(() => { db = openDatabase(':memory:'); migrateDatabase(db); });
  afterEach(() => db.close());
  it('seeds admin/admin once, forces change, and never overwrites', async () => {
    expect((await bootstrapAdminAccount(db)).created).toBe(true);
    expect((await bootstrapAdminAccount(db)).created).toBe(false);
    expect(await loginAdmin(db, 'admin', 'admin')).toMatchObject({ ok: true, mustChangePassword: true });
  });
  it('changes the bootstrap password and rejects its recent hash', async () => {
    const account = await bootstrapAdminAccount(db);
    expect((await changeAdminPassword(db, account.adminId, 'admin', 'Newpass1!')).ok).toBe(true);
    expect((await changeAdminPassword(db, account.adminId, 'Newpass1!', 'admin')).ok).toBe(false);
  });
});
