export type AdminDataFieldType = 'text' | 'integer' | 'money' | 'date' | 'datetime' | 'boolean' | 'json' | 'status';
export type AdminDataRecordKind = 'source' | 'derived' | 'history' | 'system';

export interface AdminDataField {
  key: string;
  label: string;
  type: AdminDataFieldType;
  value: unknown;
  editable: boolean;
  lockedReason?: string;
  storage?: {
    encrypted?: boolean;
    keyId?: string;
    sha256?: string;
    byteSize?: number;
  };
}

export interface AdminDataRecord {
  resource: string;
  table: string;
  id: string;
  parentId?: string;
  rowVersion?: number;
  kind: AdminDataRecordKind;
  title: string;
  fields: AdminDataField[];
}

export interface AdminDataGroup {
  key: string;
  label: string;
  records: AdminDataRecord[];
}

export interface AdminPassportDataSnapshot {
  caseId: string;
  caseCode: string;
  state: string;
  stateLabel: string;
  applicantLabel: string;
  updatedAt: string;
  requiresAiRefresh: boolean;
  groups: AdminDataGroup[];
}

export interface AdminFieldPatch {
  resource: string;
  recordId: string;
  field: string;
  value: unknown;
  expectedRowVersion: number;
}

export interface AdminFieldPatchResult {
  rowVersion: number;
  requiresAiRefresh: boolean;
  recalculated: string[];
}

export interface PurgeTableImpact {
  table: string;
  count: number;
  ids: string[];
}

export interface PurgeAttachmentImpact {
  documentId: string;
  storageId: string;
  sha256: string;
  byteSize: number;
}

export interface PurgeBackupImpact {
  name: string;
  createdAt?: string;
}

export interface PurgePreview {
  caseId: string;
  caseCode: string;
  passportId: string;
  applicantLabel: string;
  preservedSiblingCases: number;
  tables: PurgeTableImpact[];
  attachments: PurgeAttachmentImpact[];
  attachmentBytes: number;
  backups: PurgeBackupImpact[];
  previewHash: string;
  generatedAt: string;
}

export interface PurgeAuthorizationRequest {
  previewHash: string;
  caseCode: string;
  password: string;
}

export interface PurgeAuthorization {
  token: string;
  expiresAt: string;
}

export interface PurgeResult {
  caseCode: string;
  removedRows: number;
  removedAttachments: number;
  removedBackups: number;
  completedAt: string;
}
