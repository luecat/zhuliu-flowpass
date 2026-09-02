import { KeychainSecretProvider } from '../server/config/keychain';
import { pathToFileURL } from 'node:url';

export const LOGICAL_SECRETS = ['line-channel-access-token', 'line-channel-secret', 'line-login-channel-secret', 'lm-studio-api-token', 'gemini-api-key', 'vault-master-key-v1', 'flowpass-master-key', 'session-hmac-key-v1', 'backup-master-key-v1'] as const;
export async function keychainDoctor(service = process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass'): Promise<Record<string, 'present' | 'missing' | 'inaccessible'>> {
  const provider = new KeychainSecretProvider(); const result: Record<string, 'present' | 'missing' | 'inaccessible'> = {};
  for (const account of LOGICAL_SECRETS) { try { result[account] = (await provider.has({ service, account })) ? 'present' : 'missing'; } catch { result[account] = 'inaccessible'; } }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void keychainDoctor().then((result) => console.log(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
