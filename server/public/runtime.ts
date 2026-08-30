import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import type { LineSessionService } from '../domain/line-session-service';
import type { DocumentVault } from '../services/document-vault';

/**
 * Trusted startup-composition seam. The public routes receive only already-built
 * server dependencies; they never load Keychain roots, construct crypto, or trust
 * browser-provided identities on demand.
 */
export interface PublicRuntime {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  lineSessions: LineSessionService;
  publicOrigin: string;
  requestIdGenerator?: () => string;
  clock?: () => Date;
  /** Vault is injected by trusted startup composition; requests never construct keys. */
  documentVault?: DocumentVault;
}

let configuredRuntime: PublicRuntime | null = null;

export function configurePublicRuntime(runtime: PublicRuntime): void {
  configuredRuntime = runtime;
  // Trusted startup composition owns recovery. Requests never trigger a
  // filesystem scan, but a process restart must reconcile pending vault rows
  // before serving upload/download routes.
  runtime.documentVault?.reconcile({ database: runtime.database, now: runtime.clock?.() });
}

export function getPublicRuntime(): PublicRuntime | null {
  return configuredRuntime;
}

/** Test-only cleanup; production process composition calls configure once at startup. */
export function clearPublicRuntime(): void {
  configuredRuntime = null;
}
