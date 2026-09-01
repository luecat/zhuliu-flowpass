import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../../db/connection';
import { hashAdminPassword, hashBootstrapAdminPassword, validateAdminPassword, verifyAdminPassword } from './password';

export const ADMIN_RECOVERY_EMAIL = 'daniel0104.sung@gmail.com';

type AdminRow = {
  id: string; display_name: string; password_hash: string; recovery_email_normalized: string | null;
  must_change_password: number; failed_login_count: number; locked_until: string | null;
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function adminByName(database: FlowPassDatabase, displayName: string): AdminRow | undefined {
  return database.prepare(`SELECT id, display_name, password_hash, recovery_email_normalized, must_change_password, failed_login_count, locked_until FROM admin_users WHERE display_name = ? AND status = 'active'`).get(displayName) as AdminRow | undefined;
}

export async function bootstrapAdminAccount(database: FlowPassDatabase): Promise<{ created: boolean; adminId: string }> {
  const existing = adminByName(database, 'admin');
  if (existing) return { created: false, adminId: existing.id };
  const id = uuidv7();
  const now = new Date().toISOString();
  const passwordHash = await hashBootstrapAdminPassword('admin');
  database.prepare(`INSERT INTO admin_users (id, display_name, password_hash, status, created_at, disabled_at, row_version, recovery_email_normalized, must_change_password, password_changed_at, password_expires_at, failed_login_count) VALUES (?, 'admin', ?, 'active', ?, NULL, 1, ?, 1, ?, ?, 0)`).run(id, passwordHash, now, ADMIN_RECOVERY_EMAIL, now, now);
  return { created: true, adminId: id };
}

export async function loginAdmin(database: FlowPassDatabase, displayName: string, password: string, now = new Date()): Promise<{ ok: true; adminId: string; mustChangePassword: boolean } | { ok: false }> {
  const row = adminByName(database, displayName);
  if (!row || (row.locked_until && Date.parse(row.locked_until) > now.getTime())) return { ok: false };
  if (!await verifyAdminPassword(password, row.password_hash)) {
    const failures = row.failed_login_count + 1;
    const lockedUntil = failures >= 5 ? new Date(now.getTime() + 15 * 60_000).toISOString() : null;
    database.prepare('UPDATE admin_users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(failures, lockedUntil, row.id);
    return { ok: false };
  }
  database.prepare('UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { ok: true, adminId: row.id, mustChangePassword: row.must_change_password === 1 };
}

async function passwordWasUsed(database: FlowPassDatabase, row: AdminRow, password: string): Promise<boolean> {
  if (await verifyAdminPassword(password, row.password_hash)) return true;
  const history = database.prepare('SELECT password_hash FROM admin_password_history WHERE admin_user_id = ? ORDER BY created_at DESC LIMIT 3').all(row.id) as Array<{ password_hash: string }>;
  for (const item of history) if (await verifyAdminPassword(password, item.password_hash)) return true;
  return false;
}

async function setPassword(database: FlowPassDatabase, row: AdminRow, newPassword: string, now: Date): Promise<{ ok: true } | { ok: false; errors?: string[] }> {
  const validation = validateAdminPassword(newPassword, { username: row.display_name, recoveryEmail: row.recovery_email_normalized ?? ADMIN_RECOVERY_EMAIL });
  if (!validation.valid) return { ok: false, errors: validation.errors };
  if (await passwordWasUsed(database, row, newPassword)) return { ok: false, errors: ['history'] };
  const nextHash = await hashAdminPassword(newPassword, { username: row.display_name, recoveryEmail: row.recovery_email_normalized ?? ADMIN_RECOVERY_EMAIL });
  const changedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60_000).toISOString();
  database.transaction(() => {
    database.prepare('INSERT INTO admin_password_history (id, admin_user_id, password_hash, created_at) VALUES (?, ?, ?, ?)').run(uuidv7(), row.id, row.password_hash, changedAt);
    database.prepare(`DELETE FROM admin_password_history WHERE admin_user_id = ? AND id NOT IN (SELECT id FROM admin_password_history WHERE admin_user_id = ? ORDER BY created_at DESC LIMIT 3)`).run(row.id, row.id);
    database.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, password_expires_at = ?, failed_login_count = 0, locked_until = NULL, row_version = row_version + 1 WHERE id = ?').run(nextHash, changedAt, expiresAt, row.id);
    database.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL').run(changedAt, row.id);
  })();
  return { ok: true };
}

export async function changeAdminPassword(database: FlowPassDatabase, adminId: string, currentPassword: string, newPassword: string, now = new Date()): Promise<{ ok: true } | { ok: false; errors?: string[] }> {
  const row = database.prepare(`SELECT id, display_name, password_hash, recovery_email_normalized, must_change_password, failed_login_count, locked_until FROM admin_users WHERE id = ? AND status = 'active'`).get(adminId) as AdminRow | undefined;
  if (!row || !await verifyAdminPassword(currentPassword, row.password_hash)) return { ok: false };
  return setPassword(database, row, newPassword, now);
}

export function createAdminRecoveryChallenge(database: FlowPassDatabase, accessEmail: string, now = new Date()): { token: string; expiresAt: string } | null {
  if (accessEmail.trim().toLowerCase() !== ADMIN_RECOVERY_EMAIL) return null;
  const row = adminByName(database, 'admin');
  if (!row) return null;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  database.transaction(() => {
    database.prepare('UPDATE admin_recovery_challenges SET consumed_at = ? WHERE admin_user_id = ? AND consumed_at IS NULL').run(now.toISOString(), row.id);
    database.prepare(`INSERT INTO admin_recovery_challenges (id, admin_user_id, token_hash, access_email_normalized, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(uuidv7(), row.id, tokenHash(token), ADMIN_RECOVERY_EMAIL, now.toISOString(), expiresAt);
  })();
  return { token, expiresAt };
}

export async function resetAdminPasswordWithChallenge(database: FlowPassDatabase, token: string, newPassword: string, now = new Date()): Promise<{ ok: true } | { ok: false; errors?: string[] }> {
  const challenge = database.prepare(`SELECT id, admin_user_id, expires_at, consumed_at FROM admin_recovery_challenges WHERE token_hash = ?`).get(tokenHash(token)) as { id: string; admin_user_id: string; expires_at: string; consumed_at: string | null } | undefined;
  if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now.getTime()) return { ok: false };
  const row = database.prepare(`SELECT id, display_name, password_hash, recovery_email_normalized, must_change_password, failed_login_count, locked_until FROM admin_users WHERE id = ? AND status = 'active'`).get(challenge.admin_user_id) as AdminRow | undefined;
  if (!row) return { ok: false };
  const result = await setPassword(database, row, newPassword, now);
  if (!result.ok) return result;
  database.prepare('UPDATE admin_recovery_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now.toISOString(), challenge.id);
  return { ok: true };
}
