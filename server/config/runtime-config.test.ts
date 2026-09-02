import { describe, expect, it } from 'vitest';
import { createRuntimeConfig } from './runtime-config';
import { normalizeLoopbackOpenAiBaseUrl, openAiApiUrl } from './loopback-openai-url';

describe('createRuntimeConfig', () => {
  it('uses the FlowPass local-system defaults', () => {
    expect(createRuntimeConfig({})).toEqual({
      modelProvider: 'lm-studio',
      publicOrigin: 'https://flowpass.luecat.com',
      publicPort: 38100,
      adminHost: '127.0.0.1',
      adminPort: 38101,
      workerHost: '127.0.0.1',
      workerPort: 38102,
      lmStudioBaseUrl: 'http://127.0.0.1:1234',
      timezone: 'Asia/Taipei',
      dataRoot: '/Users/luecat/Library/Application Support/FlowPass',
      lineLoginChannelId: '2011336492',
      liffId: '2011336492-ay7OJ4mO',
    });
  });

  it('permits a public-port override for isolated tests', () => {
    expect(createRuntimeConfig({ publicPort: 39100 }).publicPort).toBe(39100);
  });

  it('normalizes a local OpenAI root or /v1 prefix exactly once', () => {
    expect(normalizeLoopbackOpenAiBaseUrl('http://localhost:1234')).toBe('http://localhost:1234');
    expect(normalizeLoopbackOpenAiBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
    expect(createRuntimeConfig({ lmStudioBaseUrl: 'http://localhost:1234/v1' }).lmStudioBaseUrl).toBe('http://localhost:1234');
    expect(openAiApiUrl('http://localhost:1234/v1', 'chat/completions')).toBe('http://localhost:1234/v1/chat/completions');
  });

  it.each([
    'http://localhost:1234/other',
    'http://user:pass@localhost:1234',
    'http://localhost:1234/v1?debug=true',
  ])('rejects an unsafe OpenAI base URL: %s', (value) => {
    expect(() => normalizeLoopbackOpenAiBaseUrl(value)).toThrow();
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
