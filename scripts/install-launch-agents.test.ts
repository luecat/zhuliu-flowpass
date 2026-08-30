import { describe, expect, it } from 'vitest';
import { buildLaunchAgents, installLaunchAgents } from './install-launch-agents';
import { renderLaunchAgent } from '../ops/launchd/launch-agent-contract';

describe('launch agent generation', () => {
  it('uses absolute arguments and never a shell', () => {
    const agents = buildLaunchAgents({ releaseRoot: '/tmp/flowpass/releases', nodePath: '/usr/local/bin/node', lmsPath: '/usr/local/bin/lms', cloudflaredPath: '/usr/local/bin/cloudflared' });
    expect(agents).toHaveLength(6); expect(agents.every((agent) => agent.programArguments.every((arg) => arg.startsWith('/') || ['server', 'status', 'tunnel', '--config', 'run'].includes(arg)))).toBe(true);
    expect(renderLaunchAgent(agents[2])).not.toContain('sh -c');
  });
  it('dry-runs without writing files', () => { expect(installLaunchAgents({ releaseRoot: '/tmp/flowpass/releases', launchAgentsDir: '/tmp/flowpass/LaunchAgents' })).toHaveLength(6); });
});
