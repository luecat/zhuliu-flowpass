import { describe, expect, it } from 'vitest';
import { createRuntimeConfig } from './runtime-config';

describe('createRuntimeConfig', () => {
  it('uses the FlowPass local-system defaults', () => {
    expect(createRuntimeConfig({})).toEqual({
      publicOrigin: 'https://flowpass.luecat.com',
      publicPort: 38100,
      adminHost: '127.0.0.1',
      adminPort: 38101,
      workerHost: '127.0.0.1',
      workerPort: 38102,
      lmStudioBaseUrl: 'http://127.0.0.1:1234',
      timezone: 'Asia/Taipei',
      dataRoot: '/Users/luecat/Library/Application Support/FlowPass',
      lineLoginChannelId: 'flowpass-local-line-login',
      liffId: 'flowpass-local-liff',
    });
  });

  it('permits a public-port override for isolated tests', () => {
    expect(createRuntimeConfig({ publicPort: 39100 }).publicPort).toBe(39100);
  });

  it.each([
    ['adminHost', '0.0.0.0'],
    ['workerHost', '192.168.1.5'],
    ['lmStudioBaseUrl', 'http://192.168.1.5:1234'],
  ] as const)('rejects a non-loopback %s', (field, value) => {
    expect(() => createRuntimeConfig({ [field]: value })).toThrow();
  });

  it('permits only the deployed public origin or an explicit loopback test origin', () => {
    expect(createRuntimeConfig({ publicOrigin: 'http://127.0.0.1:39100' }).publicOrigin).toBe(
      'http://127.0.0.1:39100',
    );
    expect(() => createRuntimeConfig({ publicOrigin: 'https://sub.flowpass.luecat.com' })).toThrow();
    expect(() => createRuntimeConfig({ publicOrigin: 'http://localhost:39100' })).toThrow();
  });
});
