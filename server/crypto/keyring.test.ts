import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { SecretProvider } from '../config/keychain';
import { FieldCrypto, type EncryptionContext } from './field-crypto';
import { initializeFieldCryptoAtStartup, loadKeyringFromSecretProvider } from './keyring';

const CONTEXT: EncryptionContext = {
  purpose: 'backup-bundle',
  aad: 'flowpass:v1:backup-bundle:backups:manifest_enc:0198f040-0000-7000-8000-000000000009',
};

function providerFor(values: Record<string, string>): SecretProvider {
  return {
    async get(ref) {
      const value = values[ref.account];
      if (!value) {
        throw new Error(`missing ${ref.account}`);
      }
      return value;
    },
    async has(ref) {
      return Boolean(values[ref.account]);
    },
  };
}

describe('versioned keyring startup loader', () => {
  it('loads fixed in-memory versioned roots from the injected secret provider without a Keychain write', async () => {
    const current = Buffer.alloc(32, 0x31).toString('base64url');
    const retained = Buffer.alloc(32, 0x32).toString('base64url');
    const keyring = await loadKeyringFromSecretProvider(providerFor({ current, retained }), {
      activeKeyId: 'current-v1',
      masterKeyRefs: {
        'current-v1': { service: 'FlowPass', account: 'current' },
        'retained-v0': { service: 'FlowPass', account: 'retained' },
      },
    });
    const crypto = new FieldCrypto(keyring);
    const encrypted = crypto.encryptText('keyring-fixture', CONTEXT);

    expect(encrypted.keyId).toBe('current-v1');
    expect(crypto.decryptText(encrypted, CONTEXT)).toBe('keyring-fixture');
    expect(keyring.getMasterKey('retained-v0')).toHaveLength(32);
  });

  it('fails closed for a missing, noncanonical, or wrong-length root without including secret provider output', async () => {
    const suppliedSecret = 'very-secret-keychain-output';
    const config = {
      activeKeyId: 'current-v1',
      masterKeyRefs: { 'current-v1': { service: 'FlowPass', account: 'current' } },
    };

    await expect(loadKeyringFromSecretProvider(providerFor({}), config)).rejects.toThrow(
      'Unable to load encryption keyring',
    );
    await expect(
      loadKeyringFromSecretProvider(providerFor({ current: `${Buffer.alloc(32).toString('base64url')}=` }), config),
    ).rejects.toThrow('Unable to load encryption keyring');
    await expect(
      loadKeyringFromSecretProvider(providerFor({ current: suppliedSecret }), config),
    ).rejects.toThrow('Unable to load encryption keyring');
    await expect(
      loadKeyringFromSecretProvider(providerFor({ current: Buffer.alloc(32, 0x34).toString('base64url') }), {
        activeKeyId: 'bad:key',
        masterKeyRefs: { 'bad:key': { service: 'FlowPass', account: 'current' } },
      }),
    ).rejects.toThrow('Unable to load encryption keyring');
    const duplicatedRoot = Buffer.alloc(32, 0x35).toString('base64url');
    await expect(
      loadKeyringFromSecretProvider(providerFor({ current: duplicatedRoot, retained: duplicatedRoot }), {
        activeKeyId: 'current-v1',
        masterKeyRefs: {
          'current-v1': { service: 'FlowPass', account: 'current' },
          'retained-v0': { service: 'FlowPass', account: 'retained' },
        },
      }),
    ).rejects.toThrow('Unable to load encryption keyring');

    try {
      await loadKeyringFromSecretProvider(providerFor({ current: suppliedSecret }), config);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(suppliedSecret);
      expect(error).toEqual(expect.objectContaining({ message: 'Unable to load encryption keyring' }));
    }
  });

  it('loads roots once at startup so request encryption never reads the secret provider', async () => {
    const current = Buffer.alloc(32, 0x33).toString('base64url');
    let reads = 0;
    const provider: SecretProvider = {
      async get(ref) {
        reads += 1;
        expect(ref).toEqual({ service: 'FlowPass', account: 'current' });
        return current;
      },
      async has() {
        return true;
      },
    };

    const crypto = await initializeFieldCryptoAtStartup(provider, {
      activeKeyId: 'current-v1',
      masterKeyRefs: { 'current-v1': { service: 'FlowPass', account: 'current' } },
    });
    const encrypted = crypto.encryptText('startup-only-read', CONTEXT);

    expect(crypto.decryptText(encrypted, CONTEXT)).toBe('startup-only-read');
    expect(reads).toBe(1);
  });
});
