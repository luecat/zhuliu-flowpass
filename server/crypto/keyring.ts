import { Buffer } from 'node:buffer';
import type { SecretProvider, SecretRef } from '../config/keychain';
import { FieldCrypto, type Keyring } from './field-crypto';

export interface VersionedKeyringConfig {
  activeKeyId: string;
  masterKeyRefs: Readonly<Record<string, SecretRef>>;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MASTER_KEY_LENGTH = 32;

function decodeMasterKey(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error('invalid master key');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== MASTER_KEY_LENGTH || decoded.toString('base64url') !== value) {
    throw new Error('invalid master key');
  }

  return Buffer.from(decoded);
}

class LoadedKeyring implements Keyring {
  constructor(
    readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, Uint8Array>,
  ) {}

  get keyIds(): readonly string[] {
    return [...this.keys.keys()];
  }

  getMasterKey(keyId: string): Uint8Array | undefined {
    const key = this.keys.get(keyId);
    return key ? Buffer.from(key) : undefined;
  }
}

export async function loadKeyringFromSecretProvider(
  provider: SecretProvider,
  config: VersionedKeyringConfig,
): Promise<Keyring> {
  try {
    if (
      !config ||
      !KEY_ID_PATTERN.test(config.activeKeyId) ||
      !config.masterKeyRefs ||
      !config.masterKeyRefs[config.activeKeyId]
    ) {
      throw new Error('active key is not configured');
    }

    const entries = await Promise.all(
      Object.entries(config.masterKeyRefs).map(async ([keyId, ref]) => {
        if (!KEY_ID_PATTERN.test(keyId) || !ref?.service || !ref.account) {
          throw new Error('invalid key reference');
        }

        return [keyId, decodeMasterKey(await provider.get(ref))] as const;
      }),
    );

    const rootFingerprints = new Set<string>();
    for (const [, masterKey] of entries) {
      const fingerprint = Buffer.from(masterKey).toString('base64url');
      if (rootFingerprints.has(fingerprint)) {
        throw new Error('duplicate master key');
      }
      rootFingerprints.add(fingerprint);
    }

    return new LoadedKeyring(config.activeKeyId, new Map(entries));
  } catch {
    throw new Error('Unable to load encryption keyring');
  }
}

/**
 * Trusted process composition seam: load all versioned roots before serving and
 * hand request paths only an in-memory FieldCrypto instance, never a SecretProvider.
 */
export async function initializeFieldCryptoAtStartup(
  provider: SecretProvider,
  config: VersionedKeyringConfig,
): Promise<FieldCrypto> {
  return new FieldCrypto(await loadKeyringFromSecretProvider(provider, config));
}
