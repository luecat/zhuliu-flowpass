import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openMigratedDatabase, flowPassDatabasePath } from '../server/db/connection';
import { localReadiness } from '../server/services/health-service';
import { preflightConfig } from './preflight';

export function opsDoctor(input: { dataRoot: string; releaseRoot: string; offline?: boolean }): Record<string, unknown> {
  const current = join(input.releaseRoot, 'current'); const manifestPath = join(current, 'manifest.json'); let releaseManifestValid = false;
  try { const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { format?: string; entries?: Array<{ path?: string; sha256?: string }> }; releaseManifestValid = manifest.format === 'flowpass-release-v1' && Array.isArray(manifest.entries); } catch { releaseManifestValid = false; }
  const configPath = join(input.dataRoot, 'config', 'config.json'); let configPermissions0600 = false; try { configPermissions0600 = (statSync(configPath).mode & 0o777) === 0o600; } catch { /* missing */ }
  let databaseReady = false; try { const db = openMigratedDatabase(flowPassDatabasePath(input.dataRoot)); databaseReady = localReadiness(db).ready; db.close(); } catch { databaseReady = false; }
  let config = { ok: false, checks: {} as Record<string, boolean> }; try { config = preflightConfig(existsSync(configPath) ? configPath : undefined); } catch { /* invalid config */ }
  return { releaseManifestValid, configPermissions0600, databaseReady, config: config.checks, offline: input.offline === true, skippedLiveChecks: input.offline === true ? ['keychain', 'line', 'cloudflare', 'publicHttps', 'listeners', 'model'] : [] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const dataRoot = process.env.FLOWPASS_DATA_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass'; const releaseRoot = process.env.FLOWPASS_RELEASE_ROOT ?? join(dataRoot, 'releases'); try { console.log(JSON.stringify(opsDoctor({ dataRoot, releaseRoot, offline: process.argv.includes('--offline') }), null, 2)); } catch (error) { console.error(error instanceof Error ? error.message : 'ops doctor failed'); process.exitCode = 1; } }
