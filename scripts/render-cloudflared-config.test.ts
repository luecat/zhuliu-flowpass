import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCloudflaredConfig } from './render-cloudflared-config';

describe('renderCloudflaredConfig', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('renders public then admin ingress followed by a catch-all from an explicit protected credential path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpass-tunnel-')); roots.push(root);
    const credentials = join(root, 'credentials.json');
    const outputPath = join(root, 'runtime', 'cloudflared-flowpass.yml');
    writeFileSync(credentials, '{}', { mode: 0o600 }); chmodSync(credentials, 0o600);
    await renderCloudflaredConfig({ tunnelId: '06a57a58-4a96-4fa1-9486-76734660374f', credentialsFile: credentials, outputPath });
    const config = readFileSync(outputPath, 'utf8');
    expect(config).toBe(`tunnel: 06a57a58-4a96-4fa1-9486-76734660374f
credentials-file: ${credentials}
originRequest:
  connectTimeout: 10s
ingress:
  - hostname: flowpass.luecat.com
    service: http://127.0.0.1:38100
  - hostname: admin.luecat.com
    service: http://127.0.0.1:38101
  - service: http_status:404
`);
  });
});
