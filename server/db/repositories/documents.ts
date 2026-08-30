import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { decryptDatabaseText, encryptDatabaseText } from './encrypted-fields';
import {
  requireAdminScope,
  requireApplicantScope,
  requireSystemScope,
  type AdminScope,
  type ApplicantScope,
  type SystemScope,
} from './scopes';

interface DocumentRow {
  id: string;
  case_id: string;
  kind: string;
  storage_id: string;
  key_id: string;
  content_sha256: string;
  media_type: string;
  byte_size: number;
  original_name_enc: string;
  status: string;
  uploaded_by_type: string;
  uploaded_by_id: string;
  created_at: string;
  deleted_at: string | null;
  row_version: number;
}

/** Full document storage projection; only admin-scoped reads return it. */
export interface AdminDocumentRecord {
  id: string;
  caseId: string;
  kind: string;
  storageId: string;
  keyId: string;
  contentSha256: string;
  mediaType: string;
  byteSize: number;
  originalNameEnc: string;
  status: string;
  uploadedByType: string;
  uploadedById: string;
  createdAt: string;
  deletedAt: string | null;
  rowVersion: number;
}

/** Deliberately public-safe document metadata for the document's case owner. */
export interface ApplicantDocumentRecord {
  id: string;
  caseId: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  status: string;
  createdAt: string;
  deletedAt: string | null;
  rowVersion: number;
}

/** Server-only storage reference. It is never part of the public API response. */
export interface ApplicantDocumentStorageRecord extends ApplicantDocumentRecord {
  storageId: string;
  keyId: string;
  contentSha256: string;
}

export interface ApplicantDocumentFieldRecord {
  id: string;
  documentId: string;
  fieldName: string;
  originalValue: string | null;
  normalizedValue: string | null;
  effectiveValue: string | null;
  confidence: number | null;
  sourcePage: number | null;
  sourceBox: { x: number; y: number; width: number; height: number } | null;
  parserReasonCode: string | null;
}

export function listDocumentFieldsForApplicant(database: FlowPassDatabase, scope: ApplicantScope, crypto: FieldCrypto, caseId: string): ApplicantDocumentFieldRecord[] {
  requireApplicantScope(scope);
  const rows = database.prepare(`
    SELECT f.*, d.case_id, r.id AS effective_review_id, r.value_enc AS effective_value_enc
    FROM document_fields f
    JOIN documents d ON d.id = f.document_id
    JOIN cases c ON c.id = d.case_id
    LEFT JOIN document_field_reviews r ON r.id = f.effective_review_id
    WHERE d.case_id = ? AND c.applicant_id = ?
    ORDER BY f.created_at ASC, f.id ASC
  `).all(caseId, scope.applicantId) as Array<{ id: string; document_id: string; field_name: string; original_value_enc: string | null; normalized_value_enc: string | null; effective_review_id: string | null; effective_value_enc: string | null; confidence: number | null; source_page: number | null; source_box_enc: string | null; parser_reason_code: string | null }>;
  return rows.map((row) => {
    const decrypt = (column: string, value: string | null): string | null => value == null ? null : decryptDatabaseText(crypto, 'document_fields', column, row.id, value);
    let sourceBox: ApplicantDocumentFieldRecord['sourceBox'] = null;
    const sourceBoxText = decrypt('source_box_enc', row.source_box_enc);
    if (sourceBoxText) {
      try { const parsed: unknown = JSON.parse(sourceBoxText); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sourceBox = parsed as ApplicantDocumentFieldRecord['sourceBox']; } catch { sourceBox = null; }
    }
    return { id: row.id, documentId: row.document_id, fieldName: row.field_name, originalValue: decrypt('original_value_enc', row.original_value_enc), normalizedValue: decrypt('normalized_value_enc', row.normalized_value_enc), effectiveValue: row.effective_value_enc == null || row.effective_review_id == null ? null : decryptDatabaseText(crypto, 'document_field_reviews', 'value_enc', row.effective_review_id, row.effective_value_enc), confidence: row.confidence, sourcePage: row.source_page, sourceBox, parserReasonCode: row.parser_reason_code };
  });
}

function mapAdminDocument(row: DocumentRow): AdminDocumentRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    storageId: row.storage_id,
    keyId: row.key_id,
    contentSha256: row.content_sha256,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    originalNameEnc: row.original_name_enc,
    status: row.status,
    uploadedByType: row.uploaded_by_type,
    uploadedById: row.uploaded_by_id,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    rowVersion: row.row_version,
  };
}

function mapApplicantDocument(row: DocumentRow): ApplicantDocumentRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    status: row.status,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    rowVersion: row.row_version,
  };
}

export function getDocumentForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  documentId: string,
): ApplicantDocumentRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT documents.*
       FROM documents
       JOIN cases ON cases.id = documents.case_id
       WHERE documents.id = ? AND cases.applicant_id = ?`,
    )
    .get(documentId, scope.applicantId) as DocumentRow | undefined;

  return row ? mapApplicantDocument(row) : null;
}

export function getDocumentStorageForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  documentId: string,
): ApplicantDocumentStorageRecord | null {
  requireApplicantScope(scope);
  const row = database
    .prepare(
      `SELECT documents.*
       FROM documents
       JOIN cases ON cases.id = documents.case_id
       WHERE documents.id = ? AND cases.applicant_id = ?`,
    )
    .get(documentId, scope.applicantId) as DocumentRow | undefined;
  return row
    ? {
        ...mapApplicantDocument(row),
        storageId: row.storage_id,
        keyId: row.key_id,
        contentSha256: row.content_sha256,
      }
    : null;
}

export function listDocumentsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): ApplicantDocumentRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT documents.*
       FROM documents
       JOIN cases ON cases.id = documents.case_id
       WHERE documents.case_id = ? AND cases.applicant_id = ?
       ORDER BY documents.created_at DESC, documents.id DESC`,
    )
    .all(caseId, scope.applicantId) as DocumentRow[];

  return rows.map(mapApplicantDocument);
}

export function getDocumentForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  documentId: string,
): AdminDocumentRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare('SELECT * FROM documents WHERE id = ?')
    .get(documentId) as DocumentRow | undefined;

  return row ? mapAdminDocument(row) : null;
}

export function insertEncryptedDocumentForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    caseId: string;
    kind: 'invoice' | 'eligibility_proof' | 'supplement' | 'other';
    storageId: string;
    /** Task 9 vault-file key version, intentionally distinct from the envelope keyId. */
    vaultKeyId: string;
    contentSha256: string;
    mediaType: string;
    byteSize: number;
    originalName: string;
    status: 'pending_vault' | 'ready' | 'processing' | 'rejected' | 'deleted';
    uploadedByType: string;
    uploadedById: string;
    createdAt: string;
    rowVersion: number;
  },
): void {
  requireApplicantScope(scope);
  const ownedCase = database
    .prepare('SELECT id FROM cases WHERE id = ? AND applicant_id = ?')
    .get(input.caseId, scope.applicantId) as { id: string } | undefined;
  if (!ownedCase) {
    throw new Error('Case is not available');
  }

  database
    .prepare(
      `INSERT INTO documents (
        id, case_id, kind, storage_id, key_id, content_sha256, media_type, byte_size,
        original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, deleted_at, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      input.id,
      input.caseId,
      input.kind,
      input.storageId,
      input.vaultKeyId,
      input.contentSha256,
      input.mediaType,
      input.byteSize,
      encryptDatabaseText(crypto, 'documents', 'original_name_enc', input.id, input.originalName),
      input.status,
      input.uploadedByType,
      input.uploadedById,
      input.createdAt,
      input.rowVersion,
    );
}

export function insertEncryptedOcrRunForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    documentId: string;
    engine: 'vision' | 'paddleocr' | 'manual';
    engineVersion: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'manual_review';
    result: string | null;
    resultSha256: string | null;
    failureCode: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO ocr_runs (
        id, document_id, engine, engine_version, status, result_enc, result_sha256,
        failure_code, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.documentId,
      input.engine,
      input.engineVersion,
      input.status,
      input.result == null
        ? null
        : encryptDatabaseText(crypto, 'ocr_runs', 'result_enc', input.id, input.result),
      input.resultSha256,
      input.failureCode,
      input.startedAt,
      input.finishedAt,
      input.createdAt,
    );
}

export function insertEncryptedOcrRawPayloadForSystem(database: FlowPassDatabase, scope: SystemScope, crypto: FieldCrypto, input: { id: string; ocrRunId: string; payload: string; createdAt: string }): void {
  requireSystemScope(scope);
  database.prepare('INSERT INTO ocr_raw_payloads (id, ocr_run_id, payload_enc, created_at, purged_at) VALUES (?, ?, ?, ?, NULL)').run(input.id, input.ocrRunId, encryptDatabaseText(crypto, 'ocr_raw_payloads', 'payload_enc', input.id, input.payload), input.createdAt);
}

export function insertEncryptedDocumentFieldForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    documentId: string;
    fieldName: string;
    originalValue: string | null;
    normalizedValue: string | null;
    confidence: number | null;
    sourceOcrRunId: string | null;
    sourcePage: number | null;
    sourceBox: string | null;
    parserReasonCode: string | null;
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO document_fields (
        id, document_id, field_name, original_value_enc, normalized_value_enc, normalized_value_hmac,
        confidence, source_ocr_run_id, source_page, source_box_enc, parser_reason_code,
        effective_review_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      input.id,
      input.documentId,
      input.fieldName,
      input.originalValue == null
        ? null
        : encryptDatabaseText(
            crypto,
            'document_fields',
            'original_value_enc',
            input.id,
            input.originalValue,
          ),
      input.normalizedValue == null
        ? null
        : encryptDatabaseText(
            crypto,
            'document_fields',
            'normalized_value_enc',
            input.id,
            input.normalizedValue,
          ),
      input.normalizedValue == null
        ? null
        : crypto.hmacLookup(input.normalizedValue, 'document-normalized-value'),
      input.confidence,
      input.sourceOcrRunId,
      input.sourcePage,
      input.sourceBox == null
        ? null
        : encryptDatabaseText(crypto, 'document_fields', 'source_box_enc', input.id, input.sourceBox),
      input.parserReasonCode,
      input.createdAt,
    );
}

export function insertEncryptedDocumentFieldReviewForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    documentFieldId: string;
    reviewKind: 'applicant_correction' | 'admin_verification' | 'admin_rejection';
    value: string | null;
    decision: 'corrected' | 'verified' | 'rejected';
    reason: string | null;
    actorType: string;
    actorId: string;
    createdAt: string;
  },
): void {
  requireAdminScope(scope);
  database
    .prepare(
      `INSERT INTO document_field_reviews (
        id, document_field_id, review_kind, value_enc, value_hmac, decision,
        reason_enc, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.documentFieldId,
      input.reviewKind,
      input.value == null
        ? null
        : encryptDatabaseText(crypto, 'document_field_reviews', 'value_enc', input.id, input.value),
      input.value == null ? null : crypto.hmacLookup(input.value, 'document-field-review-value'),
      input.decision,
      input.reason == null
        ? null
        : encryptDatabaseText(crypto, 'document_field_reviews', 'reason_enc', input.id, input.reason),
      input.actorType,
      input.actorId,
      input.createdAt,
    );
}

/**
 * The caller supplies the already-defined normalized invoice value. This repository
 * deliberately does not lowercase, trim, or otherwise invent invoice normalization.
 */
export function insertInvoiceFingerprintForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    documentId: string;
    caseId: string;
    normalizedInvoiceValue: string;
    createdAt: string;
  },
): void {
  requireSystemScope(scope);
  database
    .prepare(
      `INSERT INTO invoice_fingerprints (
        id, document_id, case_id, fingerprint_hmac, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.documentId,
      input.caseId,
      crypto.hmacLookup(input.normalizedInvoiceValue, 'invoice-fingerprint'),
      input.createdAt,
    );
}
