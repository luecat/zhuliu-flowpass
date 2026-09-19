import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
const execFile = promisify(execFileCallback);

export const SECRET_NAMES = ['line-channel-access-token', 'line-channel-secret', 'line-login-channel-secret', 'lm-studio-api-token', 'gemini-api-key', 'gemini-api-key-2', 'gemini-api-key-3', 'vault-master-key-v1', 'session-hmac-key-v1', 'backup-master-key-v1'] as const;
type SecretName = typeof SECRET_NAMES[number];
const service = process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass';

function assertName(value: string): asserts value is SecretName {
  if (!SECRET_NAMES.includes(value as SecretName)) throw new Error('unsupported logical secret name');
}

/** Accumulate keystrokes until Enter — a lone final `\n` chunk used to wipe the pasted secret. */
function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.reject(new Error('interactive TTY required'));
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    let buffer = '';
    const finish = (value: string) => {
      stdin.setRawMode?.(false);
      stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const char of text) {
        if (char === '\n' || char === '\r') {
          finish(buffer);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode?.(false);
          stdin.off('data', onData);
          rl.close();
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    process.stdout.write(label);
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
  });
}

async function readClipboard(): Promise<string> {
  const { stdout } = await execFile('pbpaste', []);
  return stdout.replace(/^\s+|\s+$/g, '');
}

export async function setSecret(
  operation: 'bind' | 'set' | 'generate',
  name: string,
  account = name,
  options: { fromClipboard?: boolean } = {},
): Promise<void> {
  assertName(name);
  if (operation === 'bind') {
    await execFile('security', ['find-generic-password', '-s', service, '-a', account]);
    return;
  }
  let value: string;
  if (operation === 'generate') {
    value = randomBytes(32).toString('base64url');
  } else if (options.fromClipboard) {
    value = await readClipboard();
  } else {
    value = await promptHidden('Secret: ');
  }
  if (!value) throw new Error('secret cannot be empty');
  await execFile('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const fromClipboard = args.includes('--clipboard');
  const positional = args.filter((value) => value !== '--clipboard');
  const [operation, name, account] = positional;
  if (!operation || !name || !['bind', 'set', 'generate'].includes(operation)) {
    console.error('usage: set-secret.ts <bind|set|generate> <logical-name> [keychain-account] [--clipboard]');
    process.exitCode = 2;
  } else {
    void setSecret(operation as 'bind' | 'set' | 'generate', name, account, { fromClipboard })
      .then(() => console.log('ok'))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'secret operation failed');
        process.exitCode = 1;
      });
  }
}
