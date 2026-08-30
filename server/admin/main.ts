import { serve } from '@hono/node-server';
import { runtimeConfig } from '../config/runtime-config';
import { flowPassDatabasePath, openMigratedDatabase } from '../db/connection';
import { createAdminApp } from './app';
import { KeychainSecretProvider } from '../config/keychain';
import { initializeFieldCryptoAtStartup } from '../crypto/keyring';

const database = openMigratedDatabase(flowPassDatabasePath(runtimeConfig.dataRoot));

void (async () => {
  let crypto;
  try {
    const provider = new KeychainSecretProvider(); const keyId = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
    crypto = await initializeFieldCryptoAtStartup(provider, { activeKeyId: keyId, masterKeyRefs: { [keyId]: { service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key' } } });
  } catch {
    // Health, login and read-only routes remain available when Keychain is locked.
  }
  serve({ fetch: createAdminApp(database, { crypto }).fetch, hostname: runtimeConfig.adminHost, port: runtimeConfig.adminPort });
})();

process.once('SIGINT', () => database.close());
process.once('SIGTERM', () => database.close());
