import type { FlowPassDatabase } from '../connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { encryptDatabaseText } from './encrypted-fields';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface DocumentRow {
  id: string;
  case_id: string;
  kind: string;
  requirement_key: string | null;
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
  requirementKey: string | null;
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
  requirementKey: string | null;
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

function mapAdminDocument(row: DocumentRow): AdminDocumentRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    requirementKey: row.requirement_key,
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
    requirementKey: row.requirement_key,
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
       WHERE documents.id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL`,
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
       WHERE documents.id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL`,
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
       WHERE documents.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
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
    .prepare('SELECT documents.* FROM documents JOIN cases ON cases.id = documents.case_id WHERE documents.id = ? AND cases.deleted_at IS NULL')
    .get(documentId) as DocumentRow | undefined;

  return row ? mapAdminDocument(row) : null;
}

export function listDocumentsForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): AdminDocumentRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare(
      `SELECT documents.*
       FROM documents
       JOIN cases ON cases.id = documents.case_id
       WHERE documents.case_id = ? AND documents.status <> 'deleted' AND documents.deleted_at IS NULL AND cases.deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .all(caseId) as DocumentRow[];

  return rows.map(mapAdminDocument);
}

export function insertEncryptedDocumentForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  input: {
    id: string;
    caseId: string;
    kind: 'invoice' | 'eligibility_proof' | 'supplement' | 'other';
    requirementKey: string;
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
    .prepare('SELECT id FROM cases WHERE id = ? AND applicant_id = ? AND deleted_at IS NULL')
    .get(input.caseId, scope.applicantId) as { id: string } | undefined;
  if (!ownedCase) {
    throw new Error('Case is not available');
  }

  database
    .prepare(
      `INSERT INTO documents (
        id, case_id, kind, requirement_key, storage_id, key_id, content_sha256, media_type, byte_size,
        original_name_enc, status, uploaded_by_type, uploaded_by_id, created_at, deleted_at, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      input.id,
      input.caseId,
      input.kind,
      input.requirementKey,
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

