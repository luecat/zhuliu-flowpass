import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { localReadiness } from './health-service';
describe('local readiness', () => { it('checks database integrity and migrations without exposing versions', () => { const db = openDatabase(':memory:'); migrateDatabase(db); expect(localReadiness(db).ready).toBe(true); db.close(); }); });
