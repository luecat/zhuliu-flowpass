import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowPassDatabase } from './connection';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface AppliedMigration {
  name: string;
}

function listMigrationNames(): string[] {
  return readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
}

export function migrateDatabase(database: FlowPassDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL CHECK (
        applied_at IS strftime('%Y-%m-%dT%H:%M:%fZ', applied_at)
      )
    )
  `);

  let transactionOpen = false;

  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const applied = new Set(
      database
        .prepare('SELECT name FROM schema_migrations')
        .all()
        .map((row) => (row as AppliedMigration).name),
    );
    const recordMigration = database.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    );

    for (const name of listMigrationNames()) {
      if (applied.has(name)) {
        continue;
      }

      const sql = readFileSync(`${migrationDirectory}/${name}`, 'utf8');
      database.exec(sql);
      recordMigration.run(name, new Date().toISOString());
    }

    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      database.exec('ROLLBACK');
    }
    throw error;
  }
}
