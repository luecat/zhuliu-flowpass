import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { serializeEncryptedField, parseEncryptedField, type FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { appendEncryptedAuditLog } from '../db/repositories/audit';

const STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STALE_TEMP_MILLISECONDS = 15 * 60_000;

export interface DocumentVaultOptions {
  rootPath: string;
  crypto: FieldCrypto;
  clock?: () => Date;
  storageIdFactory?: () => string;
}

export interface PreparedVaultFile {
  storageId: string;
  keyId: string;
  tempPath: string;
  finalPath: string;
}

export interface VaultDocumentRef {
  id: string;
  storageId: string;
  keyId: string;
}

export interface QuarantinedVaultFile extends VaultDocumentRef {
  quarantinePath: string;
  originalPath: string;
}

function validateStorageId(storageId: string): void {
  if (!STORAGE_ID_PATTERN.test(storageId)) throw new Error('Vault storage ID is invalid');
}

function fileContext(documentId: string) {
  return { purpose: 'document-file' as const, aad: `flowpass:v1:document-file:documents:blob:${documentId}` };
}

function storageId(): string {
  return randomBytes(32).toString('base64url');
}

function fsyncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch {
    // Some filesystems do not permit fsync on directories. The file itself has
    // already been fsynced; a later reconciliation still fails closed.
  }
}

export class DocumentVault {
  private readonly tempRoot: string;
  private readonly clock: () => Date;
  private readonly storageIdFactory: () => string;

  constructor(private readonly options: DocumentVaultOptions) {
    this.tempRoot = join(options.rootPath, '.tmp');
    this.clock = options.clock ?? (() => new Date());
    this.storageIdFactory = options.storageIdFactory ?? storageId;
    mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    mkdirSync(options.rootPath, { recursive: true, mode: 0o700 });
  }

  private tempPath(storageId: string): string {
    validateStorageId(storageId);
    return join(this.tempRoot, `${storageId}.pending`);
  }

  private finalPath(storageId: string): string {
    validateStorageId(storageId);
    return join(this.options.rootPath, storageId);
  }

  get activeKeyId(): string {
    return this.options.crypto.activeKeyId;
  }

  allocateStorageId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = this.storageIdFactory();
      validateStorageId(candidate);
      if (!existsSync(this.tempPath(candidate)) && !existsSync(this.finalPath(candidate))) return candidate;
    }
    throw new Error('Vault storage ID collision');
  }

  prepare(input: { documentId: string; bytes: Uint8Array; storageId?: string }): PreparedVaultFile {
    const storageId = input.storageId ?? this.allocateStorageId();
    validateStorageId(storageId);
    if (existsSync(this.tempPath(storageId)) || existsSync(this.finalPath(storageId))) throw new Error('Vault storage ID collision');
    const envelope = this.options.crypto.encryptBytes(input.bytes, fileContext(input.documentId));
    const encoded = Buffer.from(serializeEncryptedField(envelope), 'utf8');
    const tempPath = this.tempPath(storageId);
    const descriptor = openSync(tempPath, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < encoded.length) offset += writeSync(descriptor, encoded, offset, encoded.length - offset, offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.tempRoot);
    return { storageId, keyId: envelope.keyId, tempPath, finalPath: this.finalPath(storageId) };
  }

  commit(prepared: PreparedVaultFile): void {
    validateStorageId(prepared.storageId);
    if (prepared.tempPath !== this.tempPath(prepared.storageId) || prepared.finalPath !== this.finalPath(prepared.storageId)) throw new Error('Vault path is invalid');
    renameSync(prepared.tempPath, prepared.finalPath);
    fsyncDirectory(this.options.rootPath);
  }

  removePrepared(prepared: PreparedVaultFile): void {
    validateStorageId(prepared.storageId);
    if (prepared.tempPath !== this.tempPath(prepared.storageId)) throw new Error('Vault path is invalid');
    try { unlinkSync(prepared.tempPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    fsyncDirectory(this.tempRoot);
  }

  read(input: VaultDocumentRef): Buffer {
    validateStorageId(input.storageId);
    return this.readPath(input, this.finalPath(input.storageId));
  }

  private readPath(input: VaultDocumentRef, path: string): Buffer {
    const payload = readFileSync(path);
    const envelope = parseEncryptedField(payload.toString('utf8'));
    if (envelope.keyId !== input.keyId) throw new Error('Vault key version does not match');
    return Buffer.from(this.options.crypto.decryptBytes(envelope, fileContext(input.id)));
  }

  remove(input: VaultDocumentRef): void {
    validateStorageId(input.storageId);
    try { unlinkSync(this.finalPath(input.storageId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    fsyncDirectory(this.options.rootPath);
  }

  quarantine(refs: VaultDocumentRef[], operationId: string): QuarantinedVaultFile[] {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(operationId)) throw new Error('Vault operation ID is invalid');
    if (refs.length === 0) return [];
    const quarantineRoot = join(this.options.rootPath, '.quarantine', operationId);
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    const moved: QuarantinedVaultFile[] = [];
    try {
      for (const ref of refs) {
        validateStorageId(ref.storageId);
        const originalPath = this.finalPath(ref.storageId);
        const quarantinePath = join(quarantineRoot, ref.storageId);
        if (!existsSync(originalPath)) continue;
        renameSync(originalPath, quarantinePath);
        moved.push({ ...ref, quarantinePath, originalPath });
      }
      fsyncDirectory(this.options.rootPath);
      fsyncDirectory(quarantineRoot);
      return moved;
    } catch (error) {
      for (const file of moved.reverse()) {
        if (existsSync(file.quarantinePath)) renameSync(file.quarantinePath, file.originalPath);
      }
      rmSync(quarantineRoot, { recursive: true, force: true });
      throw error;
    }
  }

  restoreQuarantine(files: QuarantinedVaultFile[]): void {
    const roots = new Set<string>();
    for (const file of files) {
      validateStorageId(file.storageId);
      if (existsSync(file.quarantinePath)) renameSync(file.quarantinePath, file.originalPath);
      roots.add(dirname(file.quarantinePath));
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    fsyncDirectory(this.options.rootPath);
  }

  purgeQuarantine(files: QuarantinedVaultFile[]): void {
    const roots = new Set<string>();
    for (const file of files) {
      validateStorageId(file.storageId);
      if (existsSync(file.quarantinePath)) unlinkSync(file.quarantinePath);
      roots.add(dirname(file.quarantinePath));
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    fsyncDirectory(this.options.rootPath);
  }

  /**
   * Complete or quarantine stale pending rows. Files are only ever addressed
   * through validated random storage IDs; no user filename participates in a path.
   */
  reconcile(input: { database: FlowPassDatabase; now?: Date; requestId?: string }): { completed: number; removed: number } {
    const now = input.now ?? this.clock();
    const pending = input.database.prepare(`SELECT id, storage_id, key_id, content_sha256, byte_size, created_at FROM documents WHERE status = 'pending_vault'`).all() as Array<{ id: string; storage_id: string; key_id: string; content_sha256: string; byte_size: number; created_at: string }>;
    let completed = 0;
    let removed = 0;
    const rejectPending = (row: { id: string; content_sha256: string }, reason: 'rejected' | 'orphan_cleanup') => {
      input.database.transaction(() => {
        input.database.prepare(`UPDATE documents SET status = 'rejected', row_version = row_version + 1 WHERE id = ? AND status = 'pending_vault'`).run(row.id);
        appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'update', entityType: 'document', entityId: row.id, beforeHash: null, afterHash: row.content_sha256, detail: { kind: 'operation', operation: 'update', outcome: 'rejected' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
      })();
      if (reason === 'orphan_cleanup') removed += 1;
    };
    const validBytes = (row: { id: string; storage_id: string; key_id: string; content_sha256: string; byte_size: number }, path: string): boolean => {
      try {
        const bytes = this.readPath({ id: row.id, storageId: row.storage_id, keyId: row.key_id }, path);
        return bytes.byteLength === row.byte_size && createHash('sha256').update(bytes).digest('hex') === row.content_sha256;
      } catch { return false; }
    };
    for (const row of pending) {
      let storageId: string;
      try { validateStorageId(row.storage_id); storageId = row.storage_id; } catch { continue; }
      const pendingPath = this.tempPath(storageId);
      const finalPath = this.finalPath(storageId);
      if (existsSync(finalPath)) {
        if (validBytes(row, finalPath)) {
          input.database.transaction(() => {
            input.database.prepare(`UPDATE documents SET status = 'ready', row_version = row_version + 1 WHERE id = ? AND status = 'pending_vault'`).run(row.id);
            appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'update', entityType: 'document', entityId: row.id, beforeHash: null, afterHash: row.content_sha256, detail: { kind: 'operation', operation: 'update', outcome: 'ok' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
          })();
          completed += 1;
          continue;
        }
        // A corrupt final blob is never retained. A valid pending temp can
        // still replace it in the same reconciliation pass.
        try {
          unlinkSync(finalPath);
          fsyncDirectory(this.options.rootPath);
        } catch {
          // Keep the row pending when a corrupt blob cannot be removed. This
          // preserves an exact DB reference for the next reconciliation pass
          // instead of marking rejected while leaving an untracked artifact.
          input.database.transaction(() => {
            appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'update', entityType: 'document', entityId: row.id, beforeHash: row.content_sha256, afterHash: null, detail: { kind: 'operation', operation: 'update', outcome: 'failed' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
          })();
          continue;
        }
      }
      if (existsSync(pendingPath)) {
        if (validBytes(row, pendingPath)) {
          try {
            renameSync(pendingPath, finalPath);
            fsyncDirectory(this.options.rootPath);
            input.database.transaction(() => {
              input.database.prepare(`UPDATE documents SET status = 'ready', row_version = row_version + 1 WHERE id = ? AND status = 'pending_vault'`).run(row.id);
              appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'update', entityType: 'document', entityId: row.id, beforeHash: null, afterHash: row.content_sha256, detail: { kind: 'operation', operation: 'update', outcome: 'ok' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
            })();
            completed += 1;
            continue;
          } catch { /* retry or reject only after the stale bound */ }
        }
        try {
          const age = now.getTime() - statSync(pendingPath).mtimeMs;
          if (age < STALE_TEMP_MILLISECONDS) continue;
        } catch { continue; }
      } else {
        const age = now.getTime() - Date.parse(row.created_at);
        if (!Number.isFinite(age) || age < STALE_TEMP_MILLISECONDS) continue;
      }
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
      rejectPending(row, 'rejected');
      removed += 1;
    }

    // Deletion is committed in SQLite before the physical unlink. Reconcile
    // deleted rows as exact storage references so a transient filesystem error
    // cannot leave an orphaned encrypted evidence blob indefinitely.
    const deleted = input.database.prepare(`SELECT id, storage_id FROM documents WHERE status = 'deleted'`).all() as Array<{ id: string; storage_id: string }>;
    for (const row of deleted) {
      try { validateStorageId(row.storage_id); } catch { continue; }
      const path = this.finalPath(row.storage_id);
      if (!existsSync(path)) continue;
      try {
        unlinkSync(path);
        fsyncDirectory(this.options.rootPath);
        appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'delete', entityType: 'document', entityId: row.id, beforeHash: null, afterHash: null, detail: { kind: 'operation', operation: 'delete', outcome: 'ok' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
        removed += 1;
      } catch { /* keep the exact blob for the next startup pass */ }
    }

    for (const name of readdirSync(this.tempRoot)) {
      if (!name.endsWith('.pending')) continue;
      const id = name.slice(0, -'.pending'.length);
      try { validateStorageId(id); } catch { continue; }
      const path = join(this.tempRoot, name);
      try {
        if (now.getTime() - statSync(path).mtimeMs >= STALE_TEMP_MILLISECONDS) {
          unlinkSync(path);
          appendEncryptedAuditLog(input.database, this.options.crypto, { id: uuidv7(), actorType: 'system', actorId: 'vault-reconciler', action: 'delete', entityType: 'vault', entityId: id, beforeHash: null, afterHash: null, detail: { kind: 'operation', operation: 'delete', outcome: 'ok' }, requestId: input.requestId ?? 'vault-reconciliation', createdAt: now.toISOString() });
          removed += 1;
        }
      } catch { /* a concurrently reconciled file can disappear */ }
    }
    fsyncDirectory(this.tempRoot);
    return { completed, removed };
  }
}

export function createDocumentVault(options: DocumentVaultOptions): DocumentVault {
  return new DocumentVault(options);
}
