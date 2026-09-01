import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRuntimeConfig } from '../server/config/runtime-config';
import { isLoopbackHost } from '../server/config/loopback-openai-url';

export function preflightConfig(path?: string): { ok: boolean; checks: Record<string, boolean> } {
  const raw = path ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  const config = createRuntimeConfig(raw); const checks = { publicOrigin: Boolean(config.publicOrigin), adminLoopback: config.adminHost === '127.0.0.1', workerLoopback: config.workerHost === '127.0.0.1', modelLoopback: isLoopbackHost(new URL(config.lmStudioBaseUrl).hostname) };
  return { ok: Object.values(checks).every(Boolean), checks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { console.log(JSON.stringify(preflightConfig(process.env.FLOWPASS_CONFIG_PATH))); } catch (error) { console.error(error instanceof Error ? error.message : 'preflight failed'); process.exitCode = 1; } }
