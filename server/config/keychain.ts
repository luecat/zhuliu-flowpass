import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface SecretRef {
  service: string;
  account: string;
}

export interface SecretProvider {
  get(ref: SecretRef): Promise<string>;
  has(ref: SecretRef): Promise<boolean>;
}

type ExecFileRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export class KeychainSecretProvider implements SecretProvider {
  constructor(private readonly run: ExecFileRunner = execFileAsync) {}

  async get(ref: SecretRef): Promise<string> {
    try {
      const { stdout } = await this.run('security', [
        'find-generic-password',
        '-s',
        ref.service,
        '-a',
        ref.account,
        '-w',
      ]);
      return stdout.trim();
    } catch {
      throw new Error('Unable to read secret from the macOS Keychain');
    }
  }

  async has(ref: SecretRef): Promise<boolean> {
    try {
      await this.get(ref);
      return true;
    } catch {
      return false;
    }
  }
}
