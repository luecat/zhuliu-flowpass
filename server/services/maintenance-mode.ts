import type { FlowPassDatabase } from '../db/connection';

export interface MaintenanceState {
  active: boolean;
  operationId: string | null;
  phase: string;
  startedAt: string | null;
  updatedAt: string;
}

interface MaintenanceRow {
  active: number;
  operation_id: string | null;
  phase: string;
  started_at: string | null;
  updated_at: string;
}

function mapState(row: MaintenanceRow): MaintenanceState {
  return {
    active: row.active === 1,
    operationId: row.operation_id,
    phase: row.phase,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export function getMaintenanceState(database: FlowPassDatabase): MaintenanceState {
  const row = database.prepare(`
    SELECT active, operation_id, phase, started_at, updated_at
    FROM flowpass_maintenance_state
    WHERE singleton_id = 1
  `).get() as MaintenanceRow | undefined;
  if (!row) throw new Error('Maintenance state is unavailable');
  return mapState(row);
}

export function isMaintenanceMode(database: FlowPassDatabase): boolean {
  try {
    return getMaintenanceState(database).active;
  } catch {
    return false;
  }
}

export function acquireMaintenanceMode(
  database: FlowPassDatabase,
  operationId: string,
  now: Date = new Date(),
): MaintenanceState {
  const stamp = now.toISOString();
  const result = database.prepare(`
    UPDATE flowpass_maintenance_state
    SET active = 1, operation_id = ?, phase = 'preparing', started_at = ?, updated_at = ?
    WHERE singleton_id = 1 AND active = 0
  `).run(operationId, stamp, stamp);
  if (result.changes !== 1) throw new Error('MAINTENANCE_CONFLICT');
  return getMaintenanceState(database);
}
export function updateMaintenancePhase(
  database: FlowPassDatabase,
  operationId: string,
  phase: string,
  now: Date = new Date(),
): MaintenanceState {
  const result = database.prepare(`
    UPDATE flowpass_maintenance_state
    SET phase = ?, updated_at = ?
    WHERE singleton_id = 1 AND active = 1 AND operation_id = ?
  `).run(phase, now.toISOString(), operationId);
  if (result.changes !== 1) throw new Error('MAINTENANCE_OWNER_MISMATCH');
  return getMaintenanceState(database);
}

export function releaseMaintenanceMode(
  database: FlowPassDatabase,
  operationId: string,
  now: Date = new Date(),
): MaintenanceState {
  const result = database.prepare(`
    UPDATE flowpass_maintenance_state
    SET active = 0, operation_id = NULL, phase = 'idle', started_at = NULL, updated_at = ?
    WHERE singleton_id = 1 AND active = 1 AND operation_id = ?
  `).run(now.toISOString(), operationId);
  if (result.changes !== 1) throw new Error('MAINTENANCE_OWNER_MISMATCH');
  return getMaintenanceState(database);
}
