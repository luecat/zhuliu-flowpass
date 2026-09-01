import { existsSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function rollbackRelease(releaseRoot: string, releaseId: string): string {
  const target = join(releaseRoot, releaseId); const manifest = join(target, 'manifest.json'); if (!existsSync(manifest)) throw new Error('release manifest missing'); JSON.parse(readFileSync(manifest, 'utf8'));
  const current = join(releaseRoot, 'current'); const temp = join(releaseRoot, `.rollback-${releaseId}`); if (existsSync(temp)) throw new Error('rollback pointer already exists'); symlinkSync(target, temp); renameSync(temp, current); return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const [releaseId] = process.argv.slice(2); const root = process.env.FLOWPASS_RELEASE_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass/releases'; if (!releaseId) { console.error('release id is required'); process.exitCode = 2; } else { try { console.log(JSON.stringify({ release: rollbackRelease(root, releaseId) })); } catch (error) { console.error(error instanceof Error ? error.message : 'rollback failed'); process.exitCode = 1; } } }
