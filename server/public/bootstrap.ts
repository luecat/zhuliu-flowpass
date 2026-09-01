import { join } from 'node:path';
import { createLineLoginClient } from '../adapters/line/line-login-client';
import { KeychainSecretProvider, type SecretProvider } from '../config/keychain';
import { runtimeConfig } from '../config/runtime-config';
import { initializeFieldCryptoAtStartup } from '../crypto/keyring';
import { flowPassDatabasePath, openMigratedDatabase, type FlowPassDatabase } from '../db/connection';
import { createSessionRepository } from '../db/repositories/sessions';
import { createLineSessionService } from '../domain/line-session-service';
import { SessionService } from '../domain/session-service';
import { DocumentVault } from '../services/document-vault';
import { configurePublicRuntime, type PublicRuntime } from './runtime';

const KEYCHAIN_SERVICE = process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass';
const MASTER_KEY_ID = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
const MASTER_KEY_ACCOUNT = process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key';
const LINE_SECRET_ACCOUNT = process.env.FLOWPASS_LINE_CHANNEL_SECRET_KEYCHAIN_ACCOUNT ?? 'line-channel-secret';

export interface PublicRuntimeBootstrapOptions {
  provider?: SecretProvider;
  database?: FlowPassDatabase;
  clock?: () => Date;
}

function requestIp(): string {
  // The current public API is intentionally loopback-only at the origin. Do not
  // trust browser-provided forwarding headers for authorization or rate limits.
  return '127.0.0.1';
}

/** Build every dependency once, before Next starts serving API requests. */
export async function createPublicRuntime(
  options: PublicRuntimeBootstrapOptions = {},
): Promise<PublicRuntime> {
  const provider = options.provider ?? new KeychainSecretProvider();
  const database = options.database ?? openMigratedDatabase(flowPassDatabasePath(runtimeConfig.dataRoot));
  const ownsDatabase = options.database === undefined;

  try {
    const crypto = await initializeFieldCryptoAtStartup(provider, {
      activeKeyId: MASTER_KEY_ID,
      masterKeyRefs: {
        [MASTER_KEY_ID]: { service: KEYCHAIN_SERVICE, account: MASTER_KEY_ACCOUNT },
      },
    });
    // LIFF ID-token exchange uses the public Channel ID and LINE's verify API;
    // the Channel Secret is only needed for webhook signature verification.
    // Keep the core applicant flow available when webhook setup is still
    // pending, while the webhook route remains explicitly unavailable.
    let lineChannelSecret: string | undefined;
    try {
      const value = await provider.get({ service: KEYCHAIN_SERVICE, account: LINE_SECRET_ACCOUNT });
      if (value.trim()) lineChannelSecret = value.trim();
    } catch {
      lineChannelSecret = undefined;
    }

    const sessionService = new SessionService({
      repository: createSessionRepository(database),
      clock: options.clock,
      ipHasher: (value) => crypto.hmacLookup(value, 'applicant-session-ip'),
    });
    const lineSessions = createLineSessionService({
      database,
      crypto,
      sessionService,
      lineLoginClient: createLineLoginClient({ channelId: runtimeConfig.lineLoginChannelId }),
      publicOrigin: runtimeConfig.publicOrigin,
      clock: options.clock,
      clientIpResolver: requestIp,
    });
    const documentVault = new DocumentVault({ rootPath: join(runtimeConfig.dataRoot, 'vault'), crypto });

    return {
      database,
      crypto,
      lineSessions,
      publicOrigin: runtimeConfig.publicOrigin,
      requestIdGenerator: undefined,
      clock: options.clock,
      documentVault,
      lineChannelSecret,
    };
  } catch (error) {
    if (ownsDatabase) database.close();
    throw error;
  }
}

let bootstrapPromise: Promise<void> | null = null;

/** Configure the singleton once; failures leave public API routes fail-closed. */
export function bootstrapPublicRuntime(): Promise<void> {
  bootstrapPromise ??= createPublicRuntime()
    .then((runtime) => {
      configurePublicRuntime(runtime);
    })
    .catch(() => {
      // Do not expose Keychain, crypto, or database details to the browser.
    });
  return bootstrapPromise;
}

export function resetPublicRuntimeBootstrapForTests(): void {
  bootstrapPromise = null;
}
