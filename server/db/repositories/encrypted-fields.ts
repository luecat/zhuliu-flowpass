import {
  databaseFieldContext,
  parseEncryptedField,
  serializeEncryptedField,
  type FieldCrypto,
} from '../../crypto/field-crypto';

/** Stores a UTF-8 database field as the one canonical AES-GCM envelope representation. */
export function encryptDatabaseText(
  crypto: FieldCrypto,
  table: string,
  column: string,
  recordId: string,
  value: string,
): string {
  return serializeEncryptedField(
    crypto.encryptText(value, databaseFieldContext(table, column, recordId)),
  );
}

export function decryptDatabaseText(
  crypto: FieldCrypto,
  table: string,
  column: string,
  recordId: string,
  envelope: string,
): string {
  return crypto.decryptText(
    parseEncryptedField(envelope),
    databaseFieldContext(table, column, recordId),
  );
}
