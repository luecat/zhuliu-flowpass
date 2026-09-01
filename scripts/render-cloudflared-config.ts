import { execFile as execFileCallback } from 'node:child_process';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const execFile = promisify(execFileCallback);

export async function renderCloudflaredConfig(input: { cloudflaredPath?: string; tunnelName?: string; tunnelId?: string; credentialsFile?: string; cloudflaredDir?: string; outputPath: string }): Promise<string> {
  const executable = input.cloudflaredPath ?? '/opt/homebrew/bin/cloudflared'; const name = input.tunnelName ?? 'flowpass'; const directory = input.cloudflaredDir ?? '/Users/luecat/.cloudflared';
  let id = input.tunnelId;
  if (!id) {
    const { stdout } = await execFile(executable, ['tunnel', 'list', '--output', 'json']); const tunnels = JSON.parse(stdout) as Array<{ id?: string; name?: string }>;
    const matches = tunnels.filter((tunnel) => tunnel.name === name && typeof tunnel.id === 'string'); if (matches.length !== 1) throw new Error('expected exactly one named tunnel');
    id = matches[0].id!;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('tunnel id is invalid');
  const credentials = input.credentialsFile ?? `${directory}/${id}.json`; const mode = statSync(credentials).mode & 0o777; if ((mode & 0o077) !== 0) throw new Error('credentials file permissions are too permissive');
  const config = `tunnel: ${id}\ncredentials-file: ${credentials}\noriginRequest:\n  connectTimeout: 10s\ningress:\n  - hostname: flowpass.luecat.com\n    service: http://127.0.0.1:38100\n  - hostname: admin.luecat.com\n    service: http://127.0.0.1:38101\n  - service: http_status:404\n`; mkdirSync(dirname(input.outputPath), { recursive: true }); writeFileSync(input.outputPath, config, { mode: 0o600 }); chmodSync(input.outputPath, 0o600); return input.outputPath;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const outputPath = process.env.FLOWPASS_CLOUDFLARED_CONFIG ?? `${process.cwd()}/runtime/cloudflared-flowpass.yml`; void renderCloudflaredConfig({ outputPath, tunnelId: process.env.FLOWPASS_TUNNEL_ID ?? '06a57a58-4a96-4fa1-9486-76734660374f', credentialsFile: process.env.FLOWPASS_TUNNEL_CREDENTIALS_FILE }).then((path) => console.log(JSON.stringify({ path }))).catch((error) => { console.error(error instanceof Error ? error.message : 'cloudflared config failed'); process.exitCode = 1; }); }
