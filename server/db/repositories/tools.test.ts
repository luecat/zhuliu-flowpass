import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVED_AI_TOOLS } from '../../../shared/approved-ai-tools';
import { openDatabase } from '../connection';
import { migrateDatabase } from '../migrate';
import { ensureApprovedToolProducts, listToolProductsForAdmin } from './tools';

const ADMIN_ID = '0198f050-0000-7000-8000-000000000012';
const NOW = '2026-09-12T00:00:00.000Z';

describe('approved tool product sync', () => {
  let database: ReturnType<typeof openDatabase>;
  let dir: string;
  let ids = 10;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowpass-tools-'));
    database = openDatabase(join(dir, 'flowpass.sqlite'));
    migrateDatabase(database);
    database.prepare('INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version) VALUES (?, ?, ?, ?, ?, ?)').run(ADMIN_ID, 'editor', 'hash', 'active', NOW, 1);
    ids = 10;
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts the curated AI tools and stays idempotent', () => {
    const idGenerator = () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`;
    expect(ensureApprovedToolProducts(database, { idGenerator, now: () => NOW })).toBe(APPROVED_AI_TOOLS.length);
    expect(ensureApprovedToolProducts(database, { idGenerator, now: () => NOW })).toBe(0);

    const tools = listToolProductsForAdmin(database, { adminId: ADMIN_ID });
    expect(tools.filter((tool) => tool.status === 'active')).toHaveLength(APPROVED_AI_TOOLS.length);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        vendor: 'OpenAI',
        canonicalName: 'ChatGPT',
        status: 'active',
      }),
    ]));
    const chatgpt = tools.find((tool) => tool.canonicalName === 'ChatGPT');
    expect(JSON.parse(chatgpt?.aliasesJson ?? '[]')).toEqual(expect.arrayContaining(['chatgpt', 'ChatGPT']));
  });

  it('reactivates and merges aliases for an existing vendor/name pair', () => {
    const id = '0198f050-0000-7000-8000-000000000099';
    database.prepare(
      `INSERT INTO tool_products (id, vendor, canonical_name, aliases_json, status, created_at, row_version)
       VALUES (?, 'OpenAI', 'ChatGPT', '["legacy"]', 'retired', ?, 1)`,
    ).run(id, NOW);

    expect(ensureApprovedToolProducts(database, {
      idGenerator: () => `0198f050-0000-7000-8000-${String(ids++).padStart(12, '0')}`,
      now: () => NOW,
    })).toBe(APPROVED_AI_TOOLS.length - 1);

    const row = database.prepare('SELECT status, aliases_json FROM tool_products WHERE id = ?').get(id) as {
      status: string;
      aliases_json: string;
    };
    expect(row.status).toBe('active');
    expect(JSON.parse(row.aliases_json)).toEqual(expect.arrayContaining(['legacy', 'chatgpt', 'ChatGPT']));
  });
});
