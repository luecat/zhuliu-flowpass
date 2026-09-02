import { describe, expect, it } from 'vitest';
import { buildLaunchAgents, installLaunchAgents } from './install-launch-agents';
import { renderLaunchAgent } from '../ops/launchd/launch-agent-contract';

describe('launch agent generation', () => {
  it('uses absolute arguments and never a shell', () => {
    const agents = buildLaunchAgents({ releaseRoot: '/tmp/flowpass/releases', nodePath: '/usr/local/bin/node', lmsPath: '/usr/local/bin/lms', cloudflaredPath: '/usr/local/bin/cloudflared' });
    expect(agents).toHaveLength(6);
    expect(agents[1].programArguments.at(-1)).toBe('/tmp/flowpass/releases/current/public/server.js');
    expect(agents[3].environmentVariables).toMatchObject({ FLOWPASS_WORKER_RUN: '1', FLOWPASS_MODEL_PROVIDER: 'gemini', FLOWPASS_MODEL_ID: 'gemini-3.6-flash' });
    expect(agents[2].environmentVariables).toMatchObject({
      FLOWPASS_CF_ACCESS_TEAM_DOMAIN: 'summer-art-4e96.cloudflareaccess.com',
      FLOWPASS_CF_ACCESS_AUD: 'cc23292d2980b221639c6ad43bd5f5bcb6c7d76f8788d12fe4a8e7a3f11f7ad1',
    });
    expect(agents.every((agent) => agent.standardOutPath?.startsWith('/Users/luecat/Library/Application Support/FlowPass/logs/'))).toBe(true);
    expect(renderLaunchAgent(agents[2])).not.toContain('sh -c');
    expect(renderLaunchAgent(agents[1])).toContain('<key>WorkingDirectory</key>');
  });
  it('dry-runs without writing files', () => { expect(installLaunchAgents({ releaseRoot: '/tmp/flowpass/releases', launchAgentsDir: '/tmp/flowpass/LaunchAgents' })).toHaveLength(6); });
  it('can omit only the tunnel when credentials are not provisioned', () => {
    const files = installLaunchAgents({ releaseRoot: '/tmp/flowpass/releases', launchAgentsDir: '/tmp/flowpass/LaunchAgents', includeTunnel: false });
    expect(files).toHaveLength(5);
    expect(files.some((file) => file.includes('tunnel'))).toBe(false);
  });
});
