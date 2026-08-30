import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase } from './migrate';

export type FlowPassDatabase = Database.Database;

const MINIMUM_SQLITE_VERSION = [3, 51, 3];

function isAtLeastSqliteVersion(actual: string): boolean {
  const actualParts = actual.split('.').map(Number);

  for (let index = 0; index < MINIMUM_SQLITE_VERSION.length; index += 1) {
    const minimumPart = MINIMUM_SQLITE_VERSION[index];
    const actualPart = actualParts[index] ?? 0;

    if (actualPart > minimumPart) {
      return true;
    }
    if (actualPart < minimumPart) {
      return false;
    }
  }

  return true;
}

function assertSupportedSqliteVersion(database: FlowPassDatabase): void {
  const row = database.prepare('SELECT sqlite_version() AS version').get() as { version: string };

  if (!isAtLeastSqliteVersion(row.version)) {
    throw new Error(`FlowPass requires SQLite 3.51.3 or newer; found ${row.version}`);
  }
}

export function flowPassDatabasePath(dataRoot: string): string {
  return join(dataRoot, 'data', 'flowpass.sqlite3');
}

export function openDatabase(filename: string): FlowPassDatabase {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('busy_timeout = 5000');
  assertSupportedSqliteVersion(database);

  return database;
}

export function openMigratedDatabase(filename: string): FlowPassDatabase {
  const database = openDatabase(filename);

  try {
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
