import type { FlowPassDatabase } from '../connection';
import { type FieldCrypto } from '../../crypto/field-crypto';
import { decryptDatabaseText, encryptDatabaseText } from './encrypted-fields';
import {
  requireAdminScope,
  requireApplicantScope,
  requireSystemScope,
  type AdminScope,
  type ApplicantScope,
  type SystemScope,
} from './scopes';

interface LineIdentityRow {
  id: string;
  applicant_id: string;
  provider: 'line';
  linked_at: string;
  unlinked_at: string | null;
  last_authenticated_at: string | null;
  push_state: 'enabled' | 'disabled';
  row_version: number;
}

interface LineIdentityStorageRow extends LineIdentityRow {
  line_subject_enc: string;
  line_subject_hmac: string;
}

export interface LineIdentityRecord {
  id: string;
  applicantId: string;
  provider: 'line';
  linkedAt: string;
  unlinkedAt: string | null;
  lastAuthenticatedAt: string | null;
  pushState: 'enabled' | 'disabled';
  rowVersion: number;
}

/** Server-only encrypted storage projection for an authorized worker lookup. */
export interface SystemLineIdentityRecord extends LineIdentityRecord {
  lineSubjectEnc: string;
}

function mapLineIdentity(row: LineIdentityRow): LineIdentityRecord {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    provider: row.provider,
    linkedAt: row.linked_at,
    unlinkedAt: row.unlinked_at,
    lastAuthenticatedAt: row.last_authenticated_at,
    pushState: row.push_state,
    rowVersion: row.row_version,
  };
}

function mapSystemLineIdentity(row: LineIdentityStorageRow): SystemLineIdentityRecord {
  return { ...mapLineIdentity(row), lineSubjectEnc: row.line_subject_enc };
}

const IDENTITY_COLUMNS = `
  id,
  applicant_id,
  provider,
  linked_at,
  unlinked_at,
  last_authenticated_at,
  push_state,
  row_version
`;

export function listLineIdentitiesForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
): LineIdentityRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(`SELECT ${IDENTITY_COLUMNS} FROM line_identities WHERE applicant_id = ? ORDER BY linked_at DESC`)
    .all(scope.applicantId) as LineIdentityRow[];

  return rows.map(mapLineIdentity);
}

export function getLineIdentityForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  identityId: string,
): LineIdentityRecord | null {
  requireAdminScope(scope);
  const row = database
    .prepare(`SELECT ${IDENTITY_COLUMNS} FROM line_identities WHERE id = ?`)
    .get(identityId) as LineIdentityRow | undefined;

  return row ? mapLineIdentity(row) : null;
}

export function insertApplicantWithEncryptedDisplayLabel(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: {
    id: string;
    displayLabel: string;
    status: 'active' | 'disabled';
    createdAt: string;
    updatedAt: string;
    rowVersion: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      encryptDatabaseText(crypto, 'applicants', 'display_label_enc', input.id, input.displayLabel),
      input.status,
      input.createdAt,
      input.updatedAt,
      input.rowVersion,
    );
}

export function insertLineIdentityWithEncryptedSubject(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  input: {
    id: string;
    applicantId: string;
    lineSubject: string;
    linkedAt: string;
    pushState: 'enabled' | 'disabled';
    rowVersion: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO line_identities (
        id, applicant_id, provider, line_subject_enc, line_subject_hmac, linked_at,
        unlinked_at, last_authenticated_at, push_state, row_version
      ) VALUES (?, ?, 'line', ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.applicantId,
      encryptDatabaseText(
        crypto,
        'line_identities',
        'line_subject_enc',
        input.id,
        input.lineSubject,
      ),
      crypto.hmacLookup(input.lineSubject, 'line-subject'),
      input.linkedAt,
      input.pushState,
      input.rowVersion,
    );
}

/**
 * HMAC lookup is restricted to a trusted system workflow and returns an envelope,
 * not the LINE subject itself. The caller must establish its worker authorization
 * before it may ask a separate scoped function to decrypt it.
 */
export function findLineIdentityForSystemBySubject(
  database: FlowPassDatabase,
  scope: SystemScope,
  crypto: FieldCrypto,
  lineSubject: string,
): SystemLineIdentityRecord | null {
  requireSystemScope(scope);
  const lookupHashes = crypto.hmacLookupCandidates(lineSubject, 'line-subject');
  const row = database
    .prepare(
      `SELECT ${IDENTITY_COLUMNS}, line_subject_enc, line_subject_hmac
       FROM line_identities WHERE line_subject_hmac IN (${lookupHashes.map(() => '?').join(', ')})`,
    )
    .get(...lookupHashes) as LineIdentityStorageRow | undefined;

  return row ? mapSystemLineIdentity(row) : null;
}

export function decryptLineSubjectForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  crypto: FieldCrypto,
  identityId: string,
): string | null {
  requireAdminScope(scope);
  const row = database
    .prepare('SELECT id, line_subject_enc FROM line_identities WHERE id = ?')
    .get(identityId) as { id: string; line_subject_enc: string } | undefined;

  return row
    ? decryptDatabaseText(crypto, 'line_identities', 'line_subject_enc', row.id, row.line_subject_enc)
    : null;
}
