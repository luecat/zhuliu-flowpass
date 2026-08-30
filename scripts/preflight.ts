import { readFileSync } from 'node:fs';
import { createRuntimeConfig } from '../server/config/runtime-config';

export function preflightConfig(path?: string): { ok: boolean; checks: Record<string, boolean> } {
  const raw = path ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  const config = createRuntimeConfig(raw); const checks = { publicOrigin: Boolean(config.publicOrigin), adminLoopback: config.adminHost === '127.0.0.1', workerLoopback: config.workerHost === '127.0.0.1', modelLoopback: new URL(config.lmStudioBaseUrl).hostname === '127.0.0.1' };
  return { ok: Object.values(checks).every(Boolean), checks };
}
if (import.meta.url === `file://${process.argv[1]}`) { try { console.log(JSON.stringify(preflightConfig(process.env.FLOWPASS_CONFIG_PATH))); } catch (error) { console.error(error instanceof Error ? error.message : 'preflight failed'); process.exitCode = 1; } }
