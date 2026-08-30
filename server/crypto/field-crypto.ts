import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

export type EncryptionPurpose =
  | 'database-field'
  | 'document-file'
  | 'session'
  | 'backup-bundle';

export interface EncryptedField {
  version: 1;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface EncryptionContext {
  purpose: EncryptionPurpose;
  aad: string;
}

export interface Keyring {
  readonly activeKeyId: string;
  /** Includes the active ID plus retained historical roots when lookup continuity is required. */
  readonly keyIds?: readonly string[];
  getMasterKey(keyId: string): Uint8Array | undefined;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AAD_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_LENGTH = 32;
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const ENCRYPTION_PURPOSES: readonly EncryptionPurpose[] = [
  'database-field',
  'document-file',
  'session',
  'backup-bundle',
];

function invalidEnvelope(): Error {
  return new Error('Encrypted field is invalid');
}

function cryptoFailure(): Error {
  return new Error('Unable to decrypt encrypted field');
}

function decodeCanonicalBase64url(value: unknown): Buffer {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw invalidEnvelope();
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw invalidEnvelope();
  }

  return decoded;
}

function requireExactByteLength(value: unknown, length: number): Buffer {
  const decoded = decodeCanonicalBase64url(value);
  if (decoded.length !== length) {
    throw invalidEnvelope();
  }
  return decoded;
}

function parseEnvelopeValue(value: unknown): EncryptedField {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidEnvelope();
  }

  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  const expectedKeys = ['ciphertext', 'keyId', 'nonce', 'tag', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw invalidEnvelope();
  }
  if (envelope.version !== 1 || typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) {
    throw invalidEnvelope();
  }

  requireExactByteLength(envelope.nonce, GCM_NONCE_LENGTH);
  decodeCanonicalBase64url(envelope.ciphertext);
  requireExactByteLength(envelope.tag, GCM_TAG_LENGTH);

  return {
    version: 1,
    keyId: envelope.keyId,
    nonce: envelope.nonce as string,
    ciphertext: envelope.ciphertext as string,
    tag: envelope.tag as string,
  };
}

function validateContext(context: EncryptionContext): void {
  if (
    !context ||
    !ENCRYPTION_PURPOSES.includes(context.purpose) ||
    typeof context.aad !== 'string'
  ) {
    throw new Error('Encryption context is invalid');
  }

  const parts = context.aad.split(':');
  if (
    parts.length !== 6 ||
    parts[0] !== 'flowpass' ||
    parts[1] !== 'v1' ||
    parts[2] !== context.purpose ||
    !AAD_SEGMENT_PATTERN.test(parts[3]) ||
    !AAD_SEGMENT_PATTERN.test(parts[4]) ||
    !AAD_SEGMENT_PATTERN.test(parts[5])
  ) {
    throw new Error('Encryption context is invalid');
  }
}

function hkdfKey(masterKey: Uint8Array, info: string): Buffer {
  if (masterKey.byteLength !== KEY_LENGTH) {
    throw new Error('Encryption key is invalid');
  }

  return Buffer.from(
    hkdfSync('sha256', Buffer.from(masterKey), Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_LENGTH),
  );
}

function fieldEncryptionKeyInfo(purpose: EncryptionPurpose, keyId: string): string {
  return `flowpass:v1:${purpose}:key-id:${keyId}`;
}

export function serializeEncryptedField(value: EncryptedField): string {
  const envelope = parseEnvelopeValue(value);
  return JSON.stringify({
    version: envelope.version,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
  });
}

export function parseEncryptedField(value: string): EncryptedField {
  if (typeof value !== 'string') {
    throw invalidEnvelope();
  }

  try {
    return parseEnvelopeValue(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message === 'Encrypted field is invalid') {
      throw error;
    }
    throw invalidEnvelope();
  }
}

export function databaseFieldContext(
  table: string,
  column: string,
  recordId: string,
): EncryptionContext {
  if (
    !AAD_SEGMENT_PATTERN.test(table) ||
    !AAD_SEGMENT_PATTERN.test(column) ||
    !AAD_SEGMENT_PATTERN.test(recordId)
  ) {
    throw new Error('Encryption context is invalid');
  }

  return {
    purpose: 'database-field',
    aad: `flowpass:v1:database-field:${table}:${column}:${recordId}`,
  };
}

export class FieldCrypto {
  constructor(private readonly keyring: Keyring) {}

  /** Key identifier is metadata, not secret material; vault rows persist it for recovery. */
  get activeKeyId(): string {
    return this.keyring.activeKeyId;
  }

  encryptBytes(value: Uint8Array, context: EncryptionContext): EncryptedField {
    validateContext(context);
    if (!KEY_ID_PATTERN.test(this.keyring.activeKeyId)) {
      throw new Error('Encryption key is invalid');
    }
    const masterKey = this.keyring.getMasterKey(this.keyring.activeKeyId);
    if (!masterKey) {
      throw new Error('Encryption key is invalid');
    }

    const key = hkdfKey(
      masterKey,
      fieldEncryptionKeyInfo(context.purpose, this.keyring.activeKeyId),
    );
    const nonce = randomBytes(GCM_NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_LENGTH });
    cipher.setAAD(Buffer.from(context.aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]);

    return {
      version: 1,
      keyId: this.keyring.activeKeyId,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
  }

  decryptBytes(value: EncryptedField, context: EncryptionContext): Uint8Array {
    try {
      validateContext(context);
      const envelope = parseEnvelopeValue(value);
      const masterKey = this.keyring.getMasterKey(envelope.keyId);
      if (!masterKey) {
        throw cryptoFailure();
      }

      const key = hkdfKey(masterKey, fieldEncryptionKeyInfo(context.purpose, envelope.keyId));
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        requireExactByteLength(envelope.nonce, GCM_NONCE_LENGTH),
        { authTagLength: GCM_TAG_LENGTH },
      );
      decipher.setAAD(Buffer.from(context.aad, 'utf8'));
      decipher.setAuthTag(requireExactByteLength(envelope.tag, GCM_TAG_LENGTH));
      return Buffer.concat([
        decipher.update(decodeCanonicalBase64url(envelope.ciphertext)),
        decipher.final(),
      ]);
    } catch {
      throw cryptoFailure();
    }
  }

  encryptText(value: string, context: EncryptionContext): EncryptedField {
    return this.encryptBytes(Buffer.from(value, 'utf8'), context);
  }

  decryptText(value: EncryptedField, context: EncryptionContext): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.decryptBytes(value, context));
    } catch {
      throw cryptoFailure();
    }
  }

  hmacLookup(value: string, purpose: string): string {
    if (!purpose || typeof value !== 'string') {
      throw new Error('Lookup input is invalid');
    }
    return this.hmacLookupForKey(value, purpose, this.keyring.activeKeyId);
  }

  hmacLookupCandidates(value: string, purpose: string): string[] {
    if (!purpose || typeof value !== 'string') {
      throw new Error('Lookup input is invalid');
    }

    const keyIds = [this.keyring.activeKeyId, ...(this.keyring.keyIds ?? [])];
    return [...new Set(keyIds)].map((keyId) => this.hmacLookupForKey(value, purpose, keyId));
  }

  private hmacLookupForKey(value: string, purpose: string, keyId: string): string {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error('Encryption key is invalid');
    }
    const masterKey = this.keyring.getMasterKey(keyId);
    if (!masterKey) {
      throw new Error('Encryption key is invalid');
    }

    const key = hkdfKey(masterKey, `flowpass:v1:hmac:${purpose}`);
    return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
  }
}
