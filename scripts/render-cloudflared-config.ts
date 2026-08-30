import { execFile as execFileCallback } from 'node:child_process';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
const execFile = promisify(execFileCallback);

export async function renderCloudflaredConfig(input: { cloudflaredPath?: string; tunnelName?: string; cloudflaredDir?: string; outputPath: string }): Promise<string> {
  const executable = input.cloudflaredPath ?? '/opt/homebrew/bin/cloudflared'; const name = input.tunnelName ?? 'flowpass'; const directory = input.cloudflaredDir ?? '/Users/luecat/.cloudflared';
  const { stdout } = await execFile(executable, ['tunnel', 'list', '--output', 'json']); const tunnels = JSON.parse(stdout) as Array<{ id?: string; name?: string }>;
  const matches = tunnels.filter((tunnel) => tunnel.name === name && typeof tunnel.id === 'string'); if (matches.length !== 1) throw new Error('expected exactly one named tunnel');
  const id = matches[0].id!; const credentials = `${directory}/${id}.json`; const mode = statSync(credentials).mode & 0o777; if ((mode & 0o077) !== 0) throw new Error('credentials file permissions are too permissive');
  const config = `tunnel: ${id}\ncredentials-file: ${credentials}\noriginRequest:\n  connectTimeout: 10s\ningress:\n  - hostname: flowpass.luecat.com\n    service: http://127.0.0.1:38100\n  - service: http_status:404\n`; mkdirSync(dirname(input.outputPath), { recursive: true }); writeFileSync(input.outputPath, config, { mode: 0o600 }); chmodSync(input.outputPath, 0o600); return input.outputPath;
}
if (import.meta.url === `file://${process.argv[1]}`) { const outputPath = process.env.FLOWPASS_CLOUDFLARED_CONFIG ?? `${process.cwd()}/runtime/cloudflared-flowpass.yml`; void renderCloudflaredConfig({ outputPath }).then((path) => console.log(JSON.stringify({ path }))).catch((error) => { console.error(error instanceof Error ? error.message : 'cloudflared config failed'); process.exitCode = 1; }); }
