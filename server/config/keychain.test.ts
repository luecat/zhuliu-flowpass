import { describe, expect, it } from 'vitest';
import { KeychainSecretProvider } from './keychain';

describe('KeychainSecretProvider', () => {
  it('reads a generic password using security arguments without shell interpolation', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const provider = new KeychainSecretProvider(async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'secret-value\n', stderr: '' };
    });

    await expect(
      provider.get({ service: 'FlowPass', account: 'line-channel-secret' }),
    ).resolves.toBe('secret-value');
    expect(calls).toEqual([
      {
        file: 'security',
        args: [
          'find-generic-password',
          '-s',
          'FlowPass',
          '-a',
          'line-channel-secret',
          '-w',
        ],
      },
    ]);
  });

  it('reports a redacted lookup error when security fails', async () => {
    const provider = new KeychainSecretProvider(async () => {
      throw Object.assign(new Error('raw-secret in stdout'), {
        stdout: 'raw-secret',
        stderr: 'also-sensitive',
      });
    });

    await expect(
      provider.get({ service: 'FlowPass', account: 'line-channel-secret' }),
    ).rejects.toThrow('Unable to read secret from the macOS Keychain');
    await expect(
      provider.get({ service: 'FlowPass', account: 'line-channel-secret' }),
    ).rejects.not.toThrow(/raw-secret|also-sensitive/);
  });

  it('returns false when a secret is absent', async () => {
    const provider = new KeychainSecretProvider(async () => {
      throw new Error('not found');
    });

    await expect(
      provider.has({ service: 'FlowPass', account: 'missing' }),
    ).resolves.toBe(false);
  });
});
