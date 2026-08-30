import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLaunchAgent, type LaunchAgent } from '../ops/launchd/launch-agent-contract';

export const AGENT_LABELS = ['model', 'public', 'admin', 'worker', 'tunnel', 'backup'] as const;

export function buildLaunchAgents(input: { releaseRoot: string; nodePath?: string; lmsPath?: string; cloudflaredPath?: string }): LaunchAgent[] {
  const node = input.nodePath ?? process.execPath; const current = join(input.releaseRoot, 'current');
  const run = (entry: string) => [node, join(current, 'server', entry)];
  return [
    { label: 'com.luecat.flowpass.model', programArguments: [input.lmsPath ?? '/opt/homebrew/bin/lms', 'server', 'status'], runAtLoad: true, keepAlive: true },
    { label: 'com.luecat.flowpass.public', programArguments: run('public.mjs'), runAtLoad: true, keepAlive: true },
    { label: 'com.luecat.flowpass.admin', programArguments: run('admin.mjs'), runAtLoad: true, keepAlive: true },
    { label: 'com.luecat.flowpass.worker', programArguments: run('worker.mjs'), runAtLoad: true, keepAlive: true },
    { label: 'com.luecat.flowpass.tunnel', programArguments: [input.cloudflaredPath ?? '/opt/homebrew/bin/cloudflared', 'tunnel', '--config', join(current, 'runtime', 'cloudflared-flowpass.yml'), 'run'], runAtLoad: true, keepAlive: true },
    { label: 'com.luecat.flowpass.backup', programArguments: run('backup.mjs'), calendarInterval: { Hour: 3, Minute: 15 } },
  ];
}

export function installLaunchAgents(input: { releaseRoot: string; launchAgentsDir: string; apply?: boolean; nodePath?: string; lmsPath?: string; cloudflaredPath?: string }): string[] {
  const agents = buildLaunchAgents(input); const files: string[] = [];
  if (input.apply) mkdirSync(input.launchAgentsDir, { recursive: true });
  for (const agent of agents) { const path = join(input.launchAgentsDir, `${agent.label}.plist`); files.push(path); if (input.apply) writeFileSync(path, renderLaunchAgent(agent), { mode: 0o600 }); }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const releaseRoot = process.env.FLOWPASS_RELEASE_ROOT ?? '/Users/luecat/Library/Application Support/FlowPass/releases'; const launchAgentsDir = process.env.FLOWPASS_LAUNCH_AGENTS_DIR ?? `${process.env.HOME ?? '/Users/luecat'}/Library/LaunchAgents`; const apply = process.argv.includes('--apply');
  console.log(JSON.stringify({ apply, files: installLaunchAgents({ releaseRoot, launchAgentsDir, apply }) }));
}
