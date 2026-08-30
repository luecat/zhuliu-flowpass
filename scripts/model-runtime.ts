import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCallback);

export async function ensureModelRuntime(input: { lmsPath?: string; endpoint?: string; modelId?: string } = {}): Promise<{ ok: boolean; modelId: string; status: string }> {
  const lms = input.lmsPath ?? '/opt/homebrew/bin/lms'; const modelId = input.modelId ?? 'flowpass-passport';
  try { await execFile(lms, ['daemon', 'up']); await execFile(lms, ['server', 'status']); } catch { try { await execFile(lms, ['server', 'start', '--bind', '127.0.0.1', '--port', '1234']); } catch { return { ok: false, modelId, status: 'offline' }; } }
  const endpoint = input.endpoint ?? 'http://127.0.0.1:1234/v1/models'; try { const response = await fetch(endpoint); if (!response.ok) return { ok: false, modelId, status: 'unavailable' }; const payload = await response.json() as { data?: Array<{ id?: string }> }; const loaded = payload.data?.some((item) => item.id === modelId) ?? false; return { ok: loaded, modelId, status: loaded ? 'ready' : 'not_loaded' }; } catch { return { ok: false, modelId, status: 'unavailable' }; }
}
if (import.meta.url === `file://${process.argv[1]}`) void ensureModelRuntime().then((result) => console.log(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
