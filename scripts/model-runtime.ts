import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execFile = promisify(execFileCallback);

type ExecRunner = (file: string, args: string[]) => Promise<unknown>;

export async function ensureModelRuntime(input: {
  lmsPath?: string;
  endpoint?: string;
  modelKey?: string;
  modelId?: string;
  execRunner?: ExecRunner;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ ok: boolean; modelId: string; status: string }> {
  const lms = input.lmsPath ?? process.env.FLOWPASS_LMS_PATH ?? '/Users/luecat/.lmstudio/bin/lms';
  const modelKey = input.modelKey ?? process.env.FLOWPASS_MODEL_KEY ?? 'qwen3.8-9b-distill';
  const modelId = input.modelId ?? process.env.FLOWPASS_MODEL_ID ?? 'qwen3.8-9b-distill';
  const endpoint = input.endpoint ?? 'http://127.0.0.1:1234/v1/models';
  const run = input.execRunner ?? execFile;
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    await run(lms, ['server', 'status']);
  } catch {
    try {
      await run(lms, ['server', 'start', '--bind', '127.0.0.1', '--port', '1234']);
    } catch {
      return { ok: false, modelId, status: 'offline' };
    }
  }
  const models = async () => {
    const response = await fetchImpl(endpoint, { redirect: 'error' });
    if (!response.ok) return [];
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    return payload.data ?? [];
  };
  try {
    if ((await models()).some((item) => item.id === modelId)) return { ok: true, modelId, status: 'ready' };
    await run(lms, ['load', modelKey, '--identifier', modelId, '--parallel', '1', '-y']);
    const loaded = (await models()).some((item) => item.id === modelId);
    return { ok: loaded, modelId, status: loaded ? 'ready' : 'not_loaded' };
  } catch {
    return { ok: false, modelId, status: 'unavailable' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = () => void ensureModelRuntime().then((result) => console.log(JSON.stringify(result))).catch(() => undefined);
  check();
  if (process.argv.includes('--watch')) setInterval(check, 60_000);
}
