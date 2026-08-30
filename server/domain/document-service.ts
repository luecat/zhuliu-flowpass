import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { appendEncryptedAuditLog } from '../db/repositories/audit';
import {
  getDocumentForApplicant,
  insertEncryptedDocumentForApplicant,
  listDocumentsForApplicant,
} from '../db/repositories/documents';
import { getCaseForApplicant } from '../db/repositories/cases';
import { parseQuotedEtag } from '../../shared/api-contract';
import { deleteApplicantMutationReservation, finalizeApplicantMutation, readApplicantMutation, reserveApplicantMutation } from '../public/public-mutations';
import { RateLimitAction, RateLimiter } from './line-session-service';
import { DocumentVault, type PreparedVaultFile } from '../services/document-vault';
import { FileValidationError, readLimitedDocumentStream, validateDocumentBytesAsync, validateDocumentFilename, type DocumentByteStream, type DocumentMediaType } from './file-validation';
import { JobRepository } from '../db/repositories/jobs';

export type DocumentKind = 'invoice' | 'eligibility_proof' | 'supplement' | 'other';

export class DocumentCommandError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ETAG_MISMATCH' | 'INVALID_STATE' | 'INVALID_REQUEST' | 'IDEMPOTENCY_KEY_REUSED' | 'RATE_LIMITED' | 'FILE_INVALID' | 'DEPENDENCY_UNAVAILABLE', readonly retryAfter?: number, message: string = code, readonly validationCode?: FileValidationError['code']) {
    super(message);
    this.name = 'DocumentCommandError';
  }
}

function fileCommandError(error: FileValidationError): DocumentCommandError {
  return new DocumentCommandError('FILE_INVALID', undefined, 'file validation failed', error.code);
}

export interface DocumentUploadResult {
  document: NonNullable<ReturnType<typeof getDocumentForApplicant>>;
}

export interface DocumentServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  vault: DocumentVault;
  clock?: () => Date;
  idGenerator?: () => string;
  requestIdGenerator?: () => string;
}

export interface DocumentService {
  upload(input: { applicantId: string; caseId: string; kind: DocumentKind; originalName: string; bytes?: Uint8Array; stream?: DocumentByteStream; ifMatch: string; idempotencyKey: string; requestId?: string }): Promise<DocumentUploadResult>;
  list(input: { applicantId: string; caseId: string }): NonNullable<ReturnType<typeof listDocumentsForApplicant>>;
  delete(input: { applicantId: string; caseId: string; documentId: string; ifMatch: string; idempotencyKey: string; requestId?: string }): DocumentUploadResult;
}

function replayData<T extends object>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Idempotency replay is invalid');
  return parsed as T;
}

function requireKey(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new DocumentCommandError('INVALID_REQUEST');
}

function requireKind(value: string): asserts value is DocumentKind {
  if (!['invoice', 'eligibility_proof', 'supplement', 'other'].includes(value)) throw new DocumentCommandError('INVALID_REQUEST');
}

function assertCaseMutable(database: FlowPassDatabase, applicantId: string, caseId: string, ifMatch: string): { rowVersion: number; state: string } {
  const expected = parseQuotedEtag(ifMatch);
  if (expected === null) throw new DocumentCommandError('ETAG_MISMATCH');
  const row = database.prepare('SELECT row_version, state FROM cases WHERE id = ? AND applicant_id = ?').get(caseId, applicantId) as { row_version: number; state: string } | undefined;
  if (!row) throw new DocumentCommandError('NOT_FOUND');
  if (row.row_version !== expected) throw new DocumentCommandError('ETAG_MISMATCH');
  if (!['draft', 'awaiting_documents'].includes(row.state)) throw new DocumentCommandError('INVALID_STATE');
  return { rowVersion: row.row_version, state: row.state };
}

function assertIdempotencyReservation(input: ReturnType<typeof reserveApplicantMutation>): asserts input is Extract<ReturnType<typeof reserveApplicantMutation>, { kind: 'reserved' }> {
  if (input.kind === 'conflict') throw new DocumentCommandError('IDEMPOTENCY_KEY_REUSED');
  if (input.kind === 'replay') throw new Error('unexpected replay');
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const requestIdGenerator = options.requestIdGenerator ?? uuidv7;
  const limiter = new RateLimiter(options.database, options.crypto, clock);

  return {
    async upload(input) {
      requireKey(input.idempotencyKey);
      requireKind(input.kind);
      try { validateDocumentFilename(input.originalName); } catch (error) { if (error instanceof FileValidationError) throw fileCommandError(error); throw error; }
      const bytes = input.bytes ? Buffer.from(input.bytes) : input.stream ? await readLimitedDocumentStream(input.stream) : (() => { throw new DocumentCommandError('INVALID_REQUEST'); })();
      let validated;
      try { validated = await validateDocumentBytesAsync(bytes, input.originalName); } catch (error) { if (error instanceof FileValidationError) throw fileCommandError(error); throw error; }
      const now = clock();
      const route = `/api/v1/cases/${input.caseId}/documents`;
      const projection = { caseId: input.caseId, kind: input.kind, originalName: input.originalName, contentSha256: validated.contentSha256, byteSize: validated.byteSize, ifMatch: input.ifMatch };
      const existing = readApplicantMutation({ database: options.database, crypto: options.crypto, applicantId: input.applicantId, method: 'POST', normalizedRoute: route, idempotencyKey: input.idempotencyKey, requestProjection: projection, now });
      if (existing?.kind === 'conflict') throw new DocumentCommandError('IDEMPOTENCY_KEY_REUSED');
      if (existing?.kind === 'replay') return { document: replayData<DocumentUploadResult>(existing.body).document };
      const rawReservation = reserveApplicantMutation({ database: options.database, crypto: options.crypto, applicantId: input.applicantId, method: 'POST', normalizedRoute: route, idempotencyKey: input.idempotencyKey, requestProjection: projection, now });
      if (rawReservation.kind === 'replay') return { document: replayData<DocumentUploadResult>(rawReservation.body).document };
      assertIdempotencyReservation(rawReservation);
      let prepared: PreparedVaultFile | null = null;
      let committed = false;
      let createdDocumentId: string | null = null;
      try {
        assertCaseMutable(options.database, input.applicantId, input.caseId, input.ifMatch);
        const rate = limiter.consume({ action: RateLimitAction.UPLOAD_BYTES, scope: input.applicantId, amount: validated.byteSize });
        if (!rate.allowed) throw new DocumentCommandError('RATE_LIMITED', rate.retryAfter);
        const documentId = idGenerator();
        createdDocumentId = documentId;
        const storageId = options.vault.allocateStorageId();
        const createdAt = now.toISOString();
        options.database.transaction(() => {
          const row = assertCaseMutable(options.database, input.applicantId, input.caseId, input.ifMatch);
          insertEncryptedDocumentForApplicant(options.database, { applicantId: input.applicantId }, options.crypto, { id: documentId, caseId: input.caseId, kind: input.kind, storageId, vaultKeyId: options.vault.activeKeyId, contentSha256: validated.contentSha256, mediaType: validated.mediaType as DocumentMediaType, byteSize: validated.byteSize, originalName: input.originalName, status: 'pending_vault', uploadedByType: 'applicant', uploadedById: input.applicantId, createdAt, rowVersion: 1 });
          const changed = options.database.prepare('UPDATE cases SET updated_at = ?, row_version = row_version + 1 WHERE id = ? AND applicant_id = ? AND row_version = ?').run(createdAt, input.caseId, input.applicantId, row.rowVersion);
          if (changed.changes !== 1) throw new DocumentCommandError('ETAG_MISMATCH');
          options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM timeline_events WHERE case_id = ?), NULL, 'document_upload_started', '文件上傳處理中', ?, 'applicant', ?)`).run(idGenerator(), input.caseId, input.caseId, JSON.stringify({ kind: input.kind, mediaType: validated.mediaType, byteSize: validated.byteSize }), createdAt);
        })();
        prepared = options.vault.prepare({ documentId, bytes, storageId });
        options.database.prepare('UPDATE documents SET key_id = ? WHERE id = ? AND status = \'pending_vault\'').run(prepared.keyId, documentId);
        options.vault.commit(prepared);
        committed = true;
        const readyAt = clock().toISOString();
        let output!: DocumentUploadResult;
        options.database.transaction(() => {
          const changed = options.database.prepare(`UPDATE documents SET status = 'ready', row_version = row_version + 1 WHERE id = ? AND status = 'pending_vault'`).run(documentId);
          if (changed.changes !== 1) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
          options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM timeline_events WHERE case_id = ?), NULL, 'document_uploaded', '文件已安全保存', ?, 'applicant', ?)`).run(idGenerator(), input.caseId, input.caseId, JSON.stringify({ kind: input.kind, mediaType: validated.mediaType, byteSize: validated.byteSize }), readyAt);
          appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'create', entityType: 'document', entityId: documentId, beforeHash: null, afterHash: validated.contentSha256, detail: { kind: 'operation', operation: 'create', outcome: 'ok' }, requestId: input.requestId ?? requestIdGenerator(), createdAt: readyAt });
          // Enqueue only the opaque IDs; the worker re-reads and decrypts the
          // exact vault blob under its system scope. Keeping this insert in the
          // same transaction as the ready transition prevents a ready upload
          // from becoming an OCR orphan.
          new JobRepository(options.database).enqueue({ systemId: 'document-upload-admission' }, { jobType: 'ocr', payload: { caseId: input.caseId, documentId }, uniqueKey: `ocr:${documentId}` });
          const document = getDocumentForApplicant(options.database, { applicantId: input.applicantId }, documentId);
          if (!document) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
          output = { document };
          if (!finalizeApplicantMutation({ database: options.database, crypto: options.crypto, reservation: rawReservation, idempotencyKey: input.idempotencyKey, status: 202, publicBody: JSON.stringify(output), now })) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
        })();
        return output;
      } catch (error) {
        let cleanupFailed = false;
        if (prepared) {
          try {
            if (committed) options.vault.remove({ id: createdDocumentId ?? '', storageId: prepared.storageId, keyId: prepared.keyId });
            else options.vault.removePrepared(prepared);
          } catch { cleanupFailed = true; /* reconciliation handles an exact stale artifact */ }
        }
        if (createdDocumentId) {
          try {
            // A committed blob that could not be unlinked is marked deleted so
            // vault reconciliation keeps an exact storage reference and retries
            // physical cleanup; it must never become an untracked rejected row.
            options.database.prepare(`UPDATE documents SET status = ?, deleted_at = ?, row_version = row_version + 1 WHERE id = ? AND status = 'pending_vault'`).run(cleanupFailed ? 'deleted' : 'rejected', cleanupFailed ? clock().toISOString() : null, createdDocumentId);
          } catch { /* preserve original command error */ }
        }
        deleteApplicantMutationReservation({ database: options.database, crypto: options.crypto, reservation: rawReservation, idempotencyKey: input.idempotencyKey });
        throw error;
      }
    },

    list(input) {
      if (!getCaseForApplicant(options.database, { applicantId: input.applicantId }, input.caseId)) throw new DocumentCommandError('NOT_FOUND');
      return listDocumentsForApplicant(options.database, { applicantId: input.applicantId }, input.caseId);
    },

    delete(input) {
      requireKey(input.idempotencyKey);
      const now = clock();
      const route = `/api/v1/cases/${input.caseId}/documents/${input.documentId}`;
      const projection = { caseId: input.caseId, documentId: input.documentId, ifMatch: input.ifMatch };
      const existing = readApplicantMutation({ database: options.database, crypto: options.crypto, applicantId: input.applicantId, method: 'DELETE', normalizedRoute: route, idempotencyKey: input.idempotencyKey, requestProjection: projection, now });
      if (existing?.kind === 'conflict') throw new DocumentCommandError('IDEMPOTENCY_KEY_REUSED');
      if (existing?.kind === 'replay') return { document: replayData<DocumentUploadResult>(existing.body).document };
      const rawReservation = reserveApplicantMutation({ database: options.database, crypto: options.crypto, applicantId: input.applicantId, method: 'DELETE', normalizedRoute: route, idempotencyKey: input.idempotencyKey, requestProjection: projection, now });
      if (rawReservation.kind === 'replay') return { document: replayData<DocumentUploadResult>(rawReservation.body).document };
      assertIdempotencyReservation(rawReservation);
      try {
        const expected = parseQuotedEtag(input.ifMatch);
        if (expected === null) throw new DocumentCommandError('ETAG_MISMATCH');
        let storageRef: { storage_id: string; key_id: string } | null = null;
        options.database.transaction(() => {
          const caseRow = assertCaseMutable(options.database, input.applicantId, input.caseId, input.ifMatch);
          if (caseRow.state !== 'draft') throw new DocumentCommandError('INVALID_STATE');
          const row = options.database.prepare(`SELECT documents.storage_id, documents.key_id, documents.status FROM documents JOIN cases ON cases.id = documents.case_id WHERE documents.id = ? AND documents.case_id = ? AND cases.applicant_id = ?`).get(input.documentId, input.caseId, input.applicantId) as { storage_id: string; key_id: string; status: string } | undefined;
          if (!row) throw new DocumentCommandError('NOT_FOUND');
          storageRef = { storage_id: row.storage_id, key_id: row.key_id };
          if (row.status === 'deleted') throw new DocumentCommandError('INVALID_STATE');
          const changed = options.database.prepare(`UPDATE documents SET status = 'deleted', deleted_at = ?, row_version = row_version + 1 WHERE id = ? AND status <> 'deleted'`).run(now.toISOString(), input.documentId);
          if (changed.changes !== 1) throw new DocumentCommandError('ETAG_MISMATCH');
          const caseChanged = options.database.prepare('UPDATE cases SET updated_at = ?, row_version = row_version + 1 WHERE id = ? AND applicant_id = ? AND row_version = ?').run(now.toISOString(), input.caseId, input.applicantId, caseRow.rowVersion);
          if (caseChanged.changes !== 1) throw new DocumentCommandError('ETAG_MISMATCH');
          options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM timeline_events WHERE case_id = ?), NULL, 'document_deleted', '文件已移除', ?, 'applicant', ?)`).run(idGenerator(), input.caseId, input.caseId, JSON.stringify({ documentId: input.documentId }), now.toISOString());
          appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'delete', entityType: 'document', entityId: input.documentId, beforeHash: null, afterHash: null, detail: { kind: 'operation', operation: 'delete', outcome: 'ok' }, requestId: input.requestId ?? requestIdGenerator(), createdAt: now.toISOString() });
        })();
        if (!storageRef) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
        const ref = storageRef as { storage_id: string; key_id: string };
        try { options.vault.remove({ id: input.documentId, storageId: ref.storage_id, keyId: ref.key_id }); } catch { /* status is already deleted; reconciliation can remove the exact blob later */ }
        const document = getDocumentForApplicant(options.database, { applicantId: input.applicantId }, input.documentId);
        if (!document) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
        const output = { document };
        if (!finalizeApplicantMutation({ database: options.database, crypto: options.crypto, reservation: rawReservation, idempotencyKey: input.idempotencyKey, status: 200, publicBody: JSON.stringify(output), now })) throw new DocumentCommandError('DEPENDENCY_UNAVAILABLE');
        return output;
      } catch (error) {
        deleteApplicantMutationReservation({ database: options.database, crypto: options.crypto, reservation: rawReservation, idempotencyKey: input.idempotencyKey });
        throw error;
      }
    },
  };
}
