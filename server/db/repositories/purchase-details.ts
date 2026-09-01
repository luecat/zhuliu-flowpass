import { createHash } from 'node:crypto';
import type { PurchaseDetails } from '../../../shared/purchase-details-contract';
import { PurchaseDetailsSchema } from '../../../shared/purchase-details-contract';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../connection';
import { decryptDatabaseText, encryptDatabaseText } from './encrypted-fields';
import {
  requireApplicantScope,
  requireSystemScope,
  type ApplicantScope,
  type SystemScope,
} from './scopes';

interface PurchaseDetailsRow {
  case_id: string;
  details_enc: string;
  content_sha256: string;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface PurchaseDetailsRecord {
  caseId: string;
  details: PurchaseDetails;
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

function mapRow(crypto: FieldCrypto, row: PurchaseDetailsRow): PurchaseDetailsRecord {
  const serialized = decryptDatabaseText(
    crypto,
    'case_purchase_details',
    'details_enc',
    row.case_id,
    row.details_enc,
  );
  return {
    caseId: row.case_id,
    details: PurchaseDetailsSchema.parse(JSON.parse(serialized)),
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

export function getPurchaseDetailsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  caseId: string,
): PurchaseDetailsRecord | null {
  requireApplicantScope(scope);
  const row = database.prepare(`
    SELECT details.*
    FROM case_purchase_details details
    JOIN cases ON cases.id = details.case_id
    WHERE details.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
  `).get(caseId, scope.applicantId) as PurchaseDetailsRow | undefined;
  return row ? mapRow(crypto, row) : null;
}

export function getPurchaseDetailsForSystem(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  caseId: string,
): PurchaseDetailsRecord | null {
  requireSystemScope(scope);
  const row = database.prepare(
    'SELECT details.* FROM case_purchase_details details JOIN cases ON cases.id = details.case_id WHERE details.case_id = ? AND cases.deleted_at IS NULL',
  ).get(caseId) as PurchaseDetailsRow | undefined;
  return row ? mapRow(crypto, row) : null;
}

export function upsertPurchaseDetailsForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  crypto: FieldCrypto,
  input: { caseId: string; details: PurchaseDetails; now: string },
): PurchaseDetailsRecord {
  requireApplicantScope(scope);
  const ownedCase = database.prepare(
    'SELECT id FROM cases WHERE id = ? AND applicant_id = ? AND deleted_at IS NULL',
  ).get(input.caseId, scope.applicantId) as { id: string } | undefined;
  if (!ownedCase) throw new Error('Case is not available');

  const details = PurchaseDetailsSchema.parse(input.details);
  const serialized = JSON.stringify(details);
  const contentSha256 = createHash('sha256').update(serialized).digest('hex');
  const encrypted = encryptDatabaseText(
    crypto,
    'case_purchase_details',
    'details_enc',
    input.caseId,
    serialized,
  );
  database.prepare(`
    INSERT INTO case_purchase_details (
      case_id, details_enc, content_sha256, created_at, updated_at, row_version
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(case_id) DO UPDATE SET
      details_enc = excluded.details_enc,
      content_sha256 = excluded.content_sha256,
      updated_at = excluded.updated_at,
      row_version = case_purchase_details.row_version + 1
  `).run(input.caseId, encrypted, contentSha256, input.now, input.now);

  const saved = getPurchaseDetailsForApplicant(database, scope, crypto, input.caseId);
  if (!saved) throw new Error('Purchase details were not saved');
  return saved;
}
