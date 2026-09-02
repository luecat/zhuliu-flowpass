import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

function hashFile(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function files(root: string): string[] { if (!existsSync(root)) return []; const result: string[] = []; for (const name of readdirSync(root)) { const path = join(root, name); const stat = lstatSync(path); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) result.push(...files(path)); else result.push(path); } return result; }
function gitValue(projectRoot: string, args: string[]): string | null { try { return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } }
export function packageRelease(input: { projectRoot: string; releaseRoot: string; releaseId?: string }): { releaseDir: string; manifest: string } {
  const standalone = join(input.projectRoot, '.next', 'standalone'); const staticDir = join(input.projectRoot, '.next', 'static'); const buildIdPath = join(input.projectRoot, '.next', 'BUILD_ID'); const assetsDir = join(input.projectRoot, 'public');
  const adminDist = join(input.projectRoot, 'dist', 'admin'); const serverDist = join(input.projectRoot, 'dist', 'server');
  for (const required of [standalone, staticDir, buildIdPath, adminDist, serverDist]) { if (!existsSync(required)) throw new Error(`release artifact missing: ${relative(input.projectRoot, required)}`); }
  const releaseId = input.releaseId ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14); const releaseDir = join(input.releaseRoot, releaseId); if (existsSync(releaseDir)) throw new Error('release already exists'); mkdirSync(releaseDir, { recursive: true });
  const publicDir = join(releaseDir, 'public'); mkdirSync(publicDir, { recursive: true }); mkdirSync(join(releaseDir, 'runtime'), { recursive: true });
  cpSync(standalone, publicDir, { recursive: true });
  cpSync(staticDir, join(publicDir, '.next', 'static'), { recursive: true });
  if (existsSync(assetsDir)) cpSync(assetsDir, join(publicDir, 'public'), { recursive: true });
  cpSync(adminDist, join(releaseDir, 'admin'), { recursive: true });
  cpSync(serverDist, join(releaseDir, 'server'), { recursive: true });
  const sqlitePackage = join(input.projectRoot, 'node_modules', 'better-sqlite3');
  if (existsSync(sqlitePackage)) {
    mkdirSync(join(releaseDir, 'node_modules'), { recursive: true });
    cpSync(sqlitePackage, join(releaseDir, 'node_modules', 'better-sqlite3'), { recursive: true });
  }
  const tunnelConfig = join(input.projectRoot, 'runtime', 'cloudflared-flowpass.yml');
  if (existsSync(tunnelConfig)) cpSync(tunnelConfig, join(releaseDir, 'runtime', 'cloudflared-flowpass.yml'));
  const lockPath = join(input.projectRoot, 'package-lock.json');
  const sourceCommit = process.env.FLOWPASS_SOURCE_COMMIT ?? gitValue(input.projectRoot, ['rev-parse', 'HEAD']);
  const sourceDirty = gitValue(input.projectRoot, ['status', '--porcelain', '--untracked-files=normal']) !== null;
  const buildId = readFileSync(buildIdPath, 'utf8').trim();
  const lockHash = existsSync(lockPath) ? hashFile(lockPath) : null;
  const entries = files(releaseDir).map((path) => ({ path: relative(releaseDir, path), sha256: hashFile(path) }));
  const manifest = JSON.stringify({ format: 'flowpass-release-v1', releaseId, builtAt: new Date().toISOString(), nodeVersion: process.version, buildId, sourceCommit, sourceDirty, dependencyLockSha256: lockHash, migrationRange: '001_core..011_ai_runs_any_adapter', entries }, null, 2);
  const manifestPath = join(releaseDir, 'manifest.json'); writeFileSync(manifestPath, manifest, { mode: 0o600 });
  const verified = JSON.parse(readFileSync(manifestPath, 'utf8')) as { format?: string; entries?: Array<{ path: string; sha256: string }> };
  if (verified.format !== 'flowpass-release-v1' || !verified.entries?.every((entry) => hashFile(join(releaseDir, entry.path)) === entry.sha256)) throw new Error('release manifest verification failed');
  mkdirSync(input.releaseRoot, { recursive: true }); const current = join(input.releaseRoot, 'current'); const temp = join(input.releaseRoot, `.current-${releaseId}`);
  try { if (existsSync(temp)) throw new Error('temporary release pointer already exists'); symlinkSync(releaseDir, temp); renameSync(temp, current); } catch (error) { try { if (existsSync(temp)) renameSync(temp, join(input.releaseRoot, `.orphan-${releaseId}`)); } catch { /* preserve release for manual cleanup */ } throw error; }
  return { releaseDir, manifest: manifestPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const projectRoot = process.cwd(); const releaseRoot = process.env.FLOWPASS_RELEASE_ROOT ?? join(projectRoot, '.flowpass-releases'); try { console.log(JSON.stringify(packageRelease({ projectRoot, releaseRoot }))); } catch (error) { console.error(error instanceof Error ? error.message : 'release packaging failed'); process.exitCode = 1; } }
