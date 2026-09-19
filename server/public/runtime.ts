import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import type { LineSessionService } from '../domain/line-session-service';
import type { DocumentVault } from '../services/document-vault';
import type { OcrEngine } from '../adapters/ocr/ocr-engine';
import { isMaintenanceMode } from '../services/maintenance-mode';

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
  /** Loaded in-memory only for the LINE webhook route; never serialized. */
  lineChannelSecret?: string;
  requestIdGenerator?: () => string;
  clock?: () => Date;
  /** Vault is injected by trusted startup composition; requests never construct keys. */
  documentVault?: DocumentVault;
  /** Absent until the local OCR helper binary is built and configured; uploads degrade gracefully without it. */
  ocrEngine?: OcrEngine;
}

const RUNTIME_GLOBAL_KEY = Symbol.for('flowpass.public.runtime');
type RuntimeGlobal = typeof globalThis & { [RUNTIME_GLOBAL_KEY]?: PublicRuntime | null };

function runtimeGlobal(): RuntimeGlobal {
  return globalThis as RuntimeGlobal;
}

export function configurePublicRuntime(runtime: PublicRuntime): void {
  runtimeGlobal()[RUNTIME_GLOBAL_KEY] = runtime;
  // Trusted startup composition owns recovery. Requests never trigger a
  // filesystem scan, but a process restart must reconcile pending vault rows
  // before serving upload/download routes.
  runtime.documentVault?.reconcile({ database: runtime.database, now: runtime.clock?.() });
}

export function getPublicRuntime(): PublicRuntime | null {
  const runtime = runtimeGlobal()[RUNTIME_GLOBAL_KEY] ?? null;
  if (!runtime) return null;
  return isMaintenanceMode(runtime.database) ? null : runtime;
}

/** Test-only cleanup; production process composition calls configure once at startup. */
export function clearPublicRuntime(): void {
  runtimeGlobal()[RUNTIME_GLOBAL_KEY] = null;
}
