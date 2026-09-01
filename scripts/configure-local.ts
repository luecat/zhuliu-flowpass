import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type LocalConfig = {
  publicOrigin: string; publicPort: number; adminHost: '127.0.0.1'; adminPort: number; workerHost: '127.0.0.1'; workerPort: number; lmStudioBaseUrl: string; lmStudioModelKey: string; lmStudioApiModelId: string; timezone: 'Asia/Taipei'; lineLoginChannelId: string; liffId: string; keychain: Record<string, { service: string; account: string }>;
};

export function writeLocalConfig(dataRoot: string, overrides: Partial<LocalConfig> = {}): string {
  const config: LocalConfig = { publicOrigin: 'https://flowpass.luecat.com', publicPort: 38100, adminHost: '127.0.0.1', adminPort: 38101, workerHost: '127.0.0.1', workerPort: 38102, lmStudioBaseUrl: 'http://localhost:1234', lmStudioModelKey: 'empero-ai : Qwen3.8 9B Distill GGUF Q4_K_M', lmStudioApiModelId: 'qwen3.8-9b-distill', timezone: 'Asia/Taipei', lineLoginChannelId: '2011336492', liffId: '2011336492-ay7OJ4mO', keychain: { lineChannelSecret: { service: 'FlowPass', account: 'line-channel-secret' }, lineChannelAccessToken: { service: 'FlowPass', account: 'line-channel-access-token' }, masterKey: { service: 'FlowPass', account: 'flowpass-master-key' } }, ...overrides };
  const path = join(dataRoot, 'config', 'config.json'); mkdirSync(join(dataRoot, 'config'), { recursive: true }); writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600); return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const root = process.env.FLOWPASS_DATA_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass'; console.log(JSON.stringify({ path: writeLocalConfig(root) })); }
