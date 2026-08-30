import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LocalConfig = {
  publicOrigin: string; publicPort: number; adminHost: '127.0.0.1'; adminPort: number; workerHost: '127.0.0.1'; workerPort: number; lmStudioBaseUrl: string; lmStudioModelKey: string; lmStudioApiModelId: string; timezone: 'Asia/Taipei'; lineLoginChannelId: string; liffId: string; keychain: Record<string, { service: string; account: string }>;
};

export function writeLocalConfig(dataRoot: string, overrides: Partial<LocalConfig> = {}): string {
  const config: LocalConfig = { publicOrigin: 'https://flowpass.luecat.com', publicPort: 38100, adminHost: '127.0.0.1', adminPort: 38101, workerHost: '127.0.0.1', workerPort: 38102, lmStudioBaseUrl: 'http://127.0.0.1:1234', lmStudioModelKey: 'unselected', lmStudioApiModelId: 'flowpass-passport', timezone: 'Asia/Taipei', lineLoginChannelId: 'flowpass-local-line-login', liffId: 'flowpass-local-liff', keychain: {}, ...overrides };
  const path = join(dataRoot, 'config', 'config.json'); mkdirSync(join(dataRoot, 'config'), { recursive: true }); writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600); return path;
}

if (import.meta.url === `file://${process.argv[1]}`) { const root = process.env.FLOWPASS_DATA_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass'; console.log(JSON.stringify({ path: writeLocalConfig(root) })); }
