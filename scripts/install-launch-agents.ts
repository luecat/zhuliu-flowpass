import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderLaunchAgent, type LaunchAgent } from '../ops/launchd/launch-agent-contract';

export const AGENT_LABELS = ['model', 'public', 'admin', 'worker', 'tunnel', 'backup'] as const;

export const GEMINI_MODEL_ID = 'gemini-3.6-flash';

export function buildLaunchAgents(input: { releaseRoot: string; dataRoot?: string; nodePath?: string; lmsPath?: string; cloudflaredPath?: string }): LaunchAgent[] {
  const node = input.nodePath ?? process.execPath;
  const lms = input.lmsPath ?? '/Users/luecat/.lmstudio/bin/lms';
  const current = join(input.releaseRoot, 'current');
  const dataRoot = input.dataRoot ?? '/Users/luecat/Library/Application Support/FlowPass';
  const logs = join(dataRoot, 'logs');
  const commonEnvironment = {
    NODE_ENV: 'production',
    FLOWPASS_DATA_ROOT: dataRoot,
    FLOWPASS_PUBLIC_ORIGIN: 'https://flowpass.luecat.com',
    FLOWPASS_PUBLIC_PORT: '38100',
    FLOWPASS_ADMIN_HOST: '127.0.0.1',
    FLOWPASS_ADMIN_PORT: '38101',
    FLOWPASS_CF_ACCESS_TEAM_DOMAIN: 'summer-art-4e96.cloudflareaccess.com',
    FLOWPASS_CF_ACCESS_AUD: 'cc23292d2980b221639c6ad43bd5f5bcb6c7d76f8788d12fe4a8e7a3f11f7ad1',
    FLOWPASS_WORKER_HOST: '127.0.0.1',
    FLOWPASS_WORKER_PORT: '38102',
    FLOWPASS_LM_STUDIO_BASE_URL: 'http://127.0.0.1:1234',
    FLOWPASS_MODEL_KEY: 'qwen3.8-9b-distill',
    FLOWPASS_MODEL_ID: 'qwen3.8-9b-distill',
    FLOWPASS_LINE_LOGIN_CHANNEL_ID: '2011336492',
    NEXT_PUBLIC_FLOWPASS_LIFF_ID: '2011336492-ay7OJ4mO',
  };
  // The worker is the only AI consumer, so the provider switch is scoped to it.
  // The local model agent keeps its LM Studio configuration and stays available
  // as a fallback by removing this override and setting modelProvider=lm-studio.
  const geminiEnvironment: Record<string, string> = {
    FLOWPASS_MODEL_PROVIDER: 'gemini',
    FLOWPASS_MODEL_ID: GEMINI_MODEL_ID,
  };
  const service = (label: string, programArguments: string[], options: Partial<LaunchAgent> = {}): LaunchAgent => ({
    label,
    programArguments,
    runAtLoad: true,
    keepAlive: true,
    workingDirectory: current,
    environmentVariables: commonEnvironment,
    standardOutPath: join(logs, `${label}.out.log`),
    standardErrorPath: join(logs, `${label}.err.log`),
    ...options,
  });
  return [
    service('com.luecat.flowpass.model', [node, join(current, 'server', 'model-runtime.mjs'), '--watch'], { environmentVariables: { ...commonEnvironment, FLOWPASS_LMS_PATH: lms } }),
    service('com.luecat.flowpass.public', [node, join(current, 'public', 'server.js')], { workingDirectory: join(current, 'public'), environmentVariables: { ...commonEnvironment, ...geminiEnvironment, HOSTNAME: '127.0.0.1', PORT: '38100' } }),
    service('com.luecat.flowpass.admin', [node, join(current, 'server', 'admin.mjs')]),
    service('com.luecat.flowpass.worker', [node, join(current, 'server', 'worker.mjs')], { environmentVariables: { ...commonEnvironment, FLOWPASS_WORKER_RUN: '1', ...geminiEnvironment } }),
    service('com.luecat.flowpass.tunnel', [input.cloudflaredPath ?? '/opt/homebrew/bin/cloudflared', 'tunnel', '--config', join(current, 'runtime', 'cloudflared-flowpass.yml'), 'run']),
    service('com.luecat.flowpass.backup', [node, join(current, 'server', 'backup.mjs')], { runAtLoad: false, keepAlive: false, calendarInterval: { Hour: 3, Minute: 15 } }),
  ];
}

export function installLaunchAgents(input: { releaseRoot: string; dataRoot?: string; launchAgentsDir: string; apply?: boolean; includeTunnel?: boolean; nodePath?: string; lmsPath?: string; cloudflaredPath?: string }): string[] {
  const agents = buildLaunchAgents(input).filter((agent) => input.includeTunnel !== false || agent.label !== 'com.luecat.flowpass.tunnel'); const files: string[] = [];
  if (input.apply) {
    mkdirSync(input.launchAgentsDir, { recursive: true });
    mkdirSync(join(input.dataRoot ?? '/Users/luecat/Library/Application Support/FlowPass', 'logs'), { recursive: true });
  }
  for (const agent of agents) { const path = join(input.launchAgentsDir, `${agent.label}.plist`); files.push(path); if (input.apply) writeFileSync(path, renderLaunchAgent(agent), { mode: 0o600 }); }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releaseRoot = process.env.FLOWPASS_RELEASE_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass/releases'; const launchAgentsDir = process.env.FLOWPASS_LAUNCH_AGENTS_DIR ?? `${process.env.HOME ?? '/Users/luecat'}/Library/LaunchAgents`; const apply = process.argv.includes('--apply');
  const dataRoot = process.env.FLOWPASS_DATA_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass';
  const includeTunnel = existsSync(join(releaseRoot, 'current', 'runtime', 'cloudflared-flowpass.yml'));
  console.log(JSON.stringify({ apply, includeTunnel, files: installLaunchAgents({ releaseRoot, dataRoot, launchAgentsDir, apply, includeTunnel }) }));
}
