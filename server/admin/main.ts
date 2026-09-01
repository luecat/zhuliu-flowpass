import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { runtimeConfig } from '../config/runtime-config';
import { flowPassDatabasePath, openMigratedDatabase } from '../db/connection';
import { createAdminApp } from './app';
import { KeychainSecretProvider } from '../config/keychain';
import { initializeFieldCryptoAtStartup } from '../crypto/keyring';
import { createCloudflareAccessVerifier } from './auth/cloudflare-access';
import type { AdminAppDependencies } from './app';
import { DocumentVault } from '../services/document-vault';

const database = openMigratedDatabase(flowPassDatabasePath(runtimeConfig.dataRoot));

void (async () => {
  let crypto;
  try {
    const provider = new KeychainSecretProvider(); const keyId = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
    crypto = await initializeFieldCryptoAtStartup(provider, { activeKeyId: keyId, masterKeyRefs: { [keyId]: { service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key' } } });
  } catch {
    // Health, login and read-only routes remain available when Keychain is locked.
  }
  const documentVaultPath = join(runtimeConfig.dataRoot, 'vault');
  const dependencies: AdminAppDependencies = { crypto, documentVaultPath, dataRoot: runtimeConfig.dataRoot, backupRoot: join(runtimeConfig.dataRoot, 'backups') };
  if (crypto) dependencies.documentVault = new DocumentVault({ rootPath: documentVaultPath, crypto });
  const teamDomain = process.env.FLOWPASS_CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.FLOWPASS_CF_ACCESS_AUD;
  if (teamDomain && audience) dependencies.verifyAccessToken = createCloudflareAccessVerifier({ teamDomain, audience });
  serve({ fetch: createAdminApp(database, dependencies).fetch, hostname: runtimeConfig.adminHost, port: runtimeConfig.adminPort });
})();

process.once('SIGINT', () => database.close());
process.once('SIGTERM', () => database.close());
