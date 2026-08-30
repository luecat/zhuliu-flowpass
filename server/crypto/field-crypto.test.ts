import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  FieldCrypto,
  parseEncryptedField,
  serializeEncryptedField,
  type EncryptedField,
  type EncryptionContext,
  type Keyring,
} from './field-crypto';

const CURRENT_KEY = Buffer.alloc(32, 0x11);
const RETAINED_KEY = Buffer.alloc(32, 0x22);
const CONTEXT: EncryptionContext = {
  purpose: 'database-field',
  aad: 'flowpass:v1:database-field:line_identities:line_subject_enc:0198f040-0000-7000-8000-000000000001',
};
const SENTINEL = 'LINE-SUBJECT-PRIVATE-ONLY';

function createKeyring(
  activeKeyId = 'current-v1',
  keys: Record<string, Uint8Array> = {
    'current-v1': CURRENT_KEY,
    'retained-v0': RETAINED_KEY,
  },
): Keyring {
  return {
    activeKeyId,
    keyIds: Object.keys(keys),
    getMasterKey(keyId) {
      return keys[keyId];
    },
  };
}

function changeBase64urlByte(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

describe('FieldCrypto', () => {
  it('round-trips UTF-8 text and binary data with a fixed 32-byte master root', () => {
    const crypto = new FieldCrypto(createKeyring());
    const textEnvelope = crypto.encryptText(SENTINEL, CONTEXT);
    const binary = Uint8Array.from([0, 1, 2, 127, 255]);
    const binaryEnvelope = crypto.encryptBytes(binary, CONTEXT);

    expect(crypto.decryptText(textEnvelope, CONTEXT)).toBe(SENTINEL);
    expect([...crypto.decryptBytes(binaryEnvelope, CONTEXT)]).toEqual([...binary]);
  });

  it('uses a fresh 12-byte nonce on every encryption and never serializes plaintext', () => {
    const crypto = new FieldCrypto(createKeyring());
    const first = crypto.encryptText(SENTINEL, CONTEXT);
    const second = crypto.encryptText(SENTINEL, CONTEXT);
    const serialized = serializeEncryptedField(first);

    expect(Buffer.from(first.nonce, 'base64url')).toHaveLength(12);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(serialized).not.toContain(SENTINEL);
    expect(JSON.stringify({ line_subject_enc: serialized })).not.toContain(SENTINEL);
  });

  it('fails closed when the envelope, context, or purpose is tampered with', () => {
    const crypto = new FieldCrypto(createKeyring());
    const envelope = crypto.encryptText(SENTINEL, CONTEXT);
    const changedValues: EncryptedField[] = [
      { ...envelope, version: 2 as 1 },
      { ...envelope, keyId: 'retained-v0' },
      { ...envelope, nonce: changeBase64urlByte(envelope.nonce) },
      { ...envelope, ciphertext: changeBase64urlByte(envelope.ciphertext) },
      { ...envelope, tag: changeBase64urlByte(envelope.tag) },
    ];

    for (const changed of changedValues) {
      expect(() => crypto.decryptText(changed, CONTEXT)).toThrow(
        'Unable to decrypt encrypted field',
      );
    }

    expect(() =>
      crypto.decryptText(envelope, {
        ...CONTEXT,
        aad: 'flowpass:v1:database-field:line_identities:line_subject_enc:0198f040-0000-7000-8000-000000000099',
      }),
    ).toThrow('Unable to decrypt encrypted field');
    expect(() =>
      crypto.decryptText(envelope, { ...CONTEXT, purpose: 'document-file' }),
    ).toThrow('Unable to decrypt encrypted field');
  });

  it('cryptographically binds an envelope key ID even when two IDs hold identical root bytes', () => {
    const crypto = new FieldCrypto(
      createKeyring('current-v1', {
        'current-v1': CURRENT_KEY,
        'alias-v1': CURRENT_KEY,
      }),
    );
    const envelope = crypto.encryptText(SENTINEL, CONTEXT);

    expect(() => crypto.decryptText({ ...envelope, keyId: 'alias-v1' }, CONTEXT)).toThrow(
      'Unable to decrypt encrypted field',
    );
  });

  it('routes decryptions by retained key ID and rejects unknown or invalid roots', () => {
    const oldCrypto = new FieldCrypto(createKeyring('retained-v0'));
    const oldEnvelope = oldCrypto.encryptText(SENTINEL, CONTEXT);
    const currentCrypto = new FieldCrypto(createKeyring());
    const unknownCrypto = new FieldCrypto(createKeyring('current-v1', { 'current-v1': CURRENT_KEY }));

    expect(currentCrypto.decryptText(oldEnvelope, CONTEXT)).toBe(SENTINEL);
    expect(() => unknownCrypto.decryptText(oldEnvelope, CONTEXT)).toThrow(
      'Unable to decrypt encrypted field',
    );
    expect(() => new FieldCrypto(createKeyring('bad', { bad: new Uint8Array(31) })).encryptText(SENTINEL, CONTEXT)).toThrow(
      'Encryption key is invalid',
    );
    expect(() =>
      new FieldCrypto(createKeyring('not:a-key', { 'not:a-key': CURRENT_KEY })).encryptText(
        SENTINEL,
        CONTEXT,
      ),
    ).toThrow('Encryption key is invalid');
  });

  it('parses only the exact canonical base64url envelope shape', () => {
    const crypto = new FieldCrypto(createKeyring());
    const envelope = crypto.encryptText(SENTINEL, CONTEXT);

    expect(parseEncryptedField(serializeEncryptedField(envelope))).toEqual(envelope);

    const malformed = [
      JSON.stringify({ ...envelope, nonce: `${envelope.nonce}=` }),
      JSON.stringify({ ...envelope, nonce: 'aGVsbG8' }),
      JSON.stringify({ ...envelope, tag: 'aGVsbG8' }),
      JSON.stringify({ ...envelope, keyId: '' }),
      JSON.stringify({ ...envelope, version: 2 }),
      JSON.stringify({ ...envelope, extra: 'not-allowed' }),
      '[]',
    ];

    for (const value of malformed) {
      expect(() => parseEncryptedField(value)).toThrow('Encrypted field is invalid');
    }
  });

  it('uses a separately derived stable HMAC key for equality lookup', () => {
    const crypto = new FieldCrypto(createKeyring());
    const first = crypto.hmacLookup('U1234567890', 'line-subject');

    expect(first).toBe(crypto.hmacLookup('U1234567890', 'line-subject'));
    expect(first).not.toBe(crypto.hmacLookup('U1234567891', 'line-subject'));
    expect(first).not.toBe(crypto.hmacLookup('U1234567890', 'invoice-fingerprint'));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('retains lookup candidates for historical roots while encrypting only with the active key', () => {
    const oldCrypto = new FieldCrypto(createKeyring('retained-v0'));
    const currentCrypto = new FieldCrypto(createKeyring());
    const value = 'U1234567890';
    const oldHmac = oldCrypto.hmacLookup(value, 'line-subject');

    expect(currentCrypto.hmacLookupCandidates(value, 'line-subject')).toEqual(
      expect.arrayContaining([currentCrypto.hmacLookup(value, 'line-subject'), oldHmac]),
    );
  });

  it('rejects unknown purposes and malformed AAD segments before encryption', () => {
    const crypto = new FieldCrypto(createKeyring());

    expect(() =>
      crypto.encryptText(SENTINEL, {
        purpose: 'not-an-approved-purpose' as EncryptionContext['purpose'],
        aad: 'flowpass:v1:not-an-approved-purpose:line_identities:line_subject_enc:0198f040-0000-7000-8000-000000000001',
      }),
    ).toThrow('Encryption context is invalid');
    expect(() =>
      crypto.encryptText(SENTINEL, {
        purpose: 'database-field',
        aad: 'flowpass:v1:database-field:line_identities:line_subject_enc',
      }),
    ).toThrow('Encryption context is invalid');
    expect(() =>
      crypto.encryptText(SENTINEL, {
        purpose: 'database-field',
        aad: 'flowpass:v1:database-field:line:identities:line_subject_enc:0198f040-0000-7000-8000-000000000001',
      }),
    ).toThrow('Encryption context is invalid');
  });
});
