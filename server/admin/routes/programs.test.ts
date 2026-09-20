import { afterEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createAdminApp } from '../app';
import { openDatabase } from '../../db/connection';
import { migrateDatabase } from '../../db/migrate';
import { bootstrapAdminAccount } from '../auth/admin-account';

const NOW = '2026-09-19T00:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:38101';
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function harness(rulesJson: string) {
  const database = openDatabase(':memory:'); databases.push(database); migrateDatabase(database); await bootstrapAdminAccount(database);
  // Clearing the forced change keeps the harness to two scrypt derivations; the
  // forced-change path itself is covered in server/admin/app.test.ts.
  database.prepare('UPDATE admin_users SET must_change_password = 0').run();
  const cycleId = uuidv7(); const ruleId = uuidv7();
  database.prepare('INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(cycleId, 'TEST', 'Test', 2026, 'active', '{}', NOW, NOW);
  database.prepare('INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, \'published\', 5000, 10000, \'floor\', \'[]\', ?, ?, ?)').run(ruleId, cycleId, rulesJson, NOW, NOW);

  const app = createAdminApp(database);
  const login = await app.request(`${ORIGIN}/admin/v1/sessions`, { method: 'POST', headers: { host: '127.0.0.1:38101', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'admin', password: 'admin' }) });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const session = setCookie.match(/flowpass_admin_session=([^;,]+)/)?.[1] ?? '';
  const csrf = setCookie.match(/flowpass_admin_csrf=([^;,]+)/)?.[1] ?? '';
  const headers = { host: '127.0.0.1:38101', origin: ORIGIN, 'content-type': 'application/json', cookie: `flowpass_admin_session=${session}; flowpass_admin_csrf=${csrf}`, 'x-csrf-token': decodeURIComponent(csrf) };
  return { database, app, cycleId, ruleId, headers };
}

describe('program settings routes', () => {
  it('reads the published rule version\'s blacklist and birth cohort', async () => {
    const { app, cycleId, headers } = await harness(JSON.stringify({ softwareBlacklist: ['Blocked Vendor'], ageEligibility: { birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } }));
    const response = await app.request(`${ORIGIN}/admin/v1/program-cycles/${cycleId}/settings`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { versionNo: 1, settings: { softwareBlacklist: ['Blocked Vendor'], ageEligibility: { birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } } } });
  });

  it('saves as a new published version, leaving the previous one intact', async () => {
    const { app, database, cycleId, ruleId, headers } = await harness(JSON.stringify({ referenceFxRates: { USD: 33 }, softwareBlacklist: ['Old Vendor'] }));
    const response = await app.request(`${ORIGIN}/admin/v1/program-cycles/${cycleId}/settings`, {
      method: 'PUT', headers,
      body: JSON.stringify({ softwareBlacklist: [' Blocked Vendor ', 'blocked vendor'], ageEligibility: { minAge: 12, birthDateFrom: '2008-01-01' } }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { versionNo: 2, settings: { softwareBlacklist: ['Blocked Vendor'], ageEligibility: { minAge: 12, birthDateFrom: '2008-01-01' } } } });

    const rows = database.prepare('SELECT version_no, status, rules_json FROM program_rule_versions WHERE program_cycle_id = ? ORDER BY version_no').all(cycleId) as { version_no: number; status: string; rules_json: string }[];
    expect(rows.map((row) => [row.version_no, row.status])).toEqual([[1, 'published'], [2, 'published']]);
    expect(JSON.parse(rows[0].rules_json)).toMatchObject({ softwareBlacklist: ['Old Vendor'] });
    // Keys this screen does not own survive the save.
    expect(JSON.parse(rows[1].rules_json)).toMatchObject({ referenceFxRates: { USD: 33 } });
    expect(ruleId).not.toBe((await (await app.request(`${ORIGIN}/admin/v1/program-cycles/${cycleId}/settings`, { headers })).json() as { data: { ruleVersionId: string } }).data.ruleVersionId);
  });

  it('rejects an inverted birth cohort without writing a version', async () => {
    const { app, database, cycleId, headers } = await harness('{}');
    const response = await app.request(`${ORIGIN}/admin/v1/program-cycles/${cycleId}/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ ageEligibility: { birthDateFrom: '2014-01-01', birthDateTo: '2008-01-01' } }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST', message: 'birth_date_range_inverted' } });
    expect(database.prepare('SELECT COUNT(*) AS count FROM program_rule_versions WHERE program_cycle_id = ?').get(cycleId)).toEqual({ count: 1 });
  });

  it('refuses a save without the session CSRF token', async () => {
    const { app, cycleId, headers } = await harness('{}');
    const response = await app.request(`${ORIGIN}/admin/v1/program-cycles/${cycleId}/settings`, {
      method: 'PUT', headers: { ...headers, 'x-csrf-token': 'forged' }, body: JSON.stringify({ softwareBlacklist: ['X'] }),
    });
    expect(response.status).toBe(403);
  });

  it('reports a cycle with no published rule version as not found', async () => {
    const { app, headers } = await harness('{}');
    const response = await app.request(`${ORIGIN}/admin/v1/program-cycles/${uuidv7()}/settings`, { headers });
    expect(response.status).toBe(404);
  });
});
