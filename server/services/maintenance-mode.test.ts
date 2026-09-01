import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowPassDatabase } from '../db/connection';
import { openMigratedDatabase } from '../db/connection';
import { clearPublicRuntime, configurePublicRuntime, getPublicRuntime } from '../public/runtime';
import {
  acquireMaintenanceMode,
  getMaintenanceState,
  isMaintenanceMode,
  releaseMaintenanceMode,
  updateMaintenancePhase,
} from './maintenance-mode';

describe('FlowPass maintenance mode', () => {
  let root: string;
  let database: FlowPassDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-maintenance-'));
    database = openMigratedDatabase(join(root, 'flowpass.sqlite3'));
  });

  afterEach(() => {
    clearPublicRuntime();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('acquires, updates and releases only for the owning operation', () => {
    expect(isMaintenanceMode(database)).toBe(false);
    expect(acquireMaintenanceMode(database, 'purge-one', new Date('2026-09-01T01:00:00.000Z'))).toMatchObject({
      active: true,
      operationId: 'purge-one',
      phase: 'preparing',
    });
    expect(() => acquireMaintenanceMode(database, 'purge-two')).toThrow('MAINTENANCE_CONFLICT');
    expect(() => updateMaintenancePhase(database, 'purge-two', 'deleting')).toThrow('MAINTENANCE_OWNER_MISMATCH');
    expect(updateMaintenancePhase(database, 'purge-one', 'deleting')).toMatchObject({ phase: 'deleting' });
    expect(() => releaseMaintenanceMode(database, 'purge-two')).toThrow('MAINTENANCE_OWNER_MISMATCH');
    expect(releaseMaintenanceMode(database, 'purge-one')).toMatchObject({ active: false, phase: 'idle' });
    expect(getMaintenanceState(database).operationId).toBeNull();
  });

  it('makes the public runtime fail closed while maintenance is active', () => {
    const runtime = {
      database,
      crypto: {} as never,
      lineSessions: {} as never,
      publicOrigin: 'http://127.0.0.1:38100',
    };
    configurePublicRuntime(runtime);
    expect(getPublicRuntime()).toBe(runtime);

    acquireMaintenanceMode(database, 'purge-one');
    expect(getPublicRuntime()).toBeNull();

    releaseMaintenanceMode(database, 'purge-one');
    expect(getPublicRuntime()).toBe(runtime);
  });
});
