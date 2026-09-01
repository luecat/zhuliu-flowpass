import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
const execFile = promisify(execFileCallback);

export const SECRET_NAMES = ['line-channel-access-token', 'line-channel-secret', 'line-login-channel-secret', 'lm-studio-api-token', 'vault-master-key-v1', 'session-hmac-key-v1', 'backup-master-key-v1'] as const;
type SecretName = typeof SECRET_NAMES[number];
const service = process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass';

function assertName(value: string): asserts value is SecretName { if (!SECRET_NAMES.includes(value as SecretName)) throw new Error('unsupported logical secret name'); }
function promptHidden(label: string): Promise<string> { if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.reject(new Error('interactive TTY required')); return new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const stdin = process.stdin; const onData = (chunk: Buffer) => { const text = chunk.toString(); if (text.includes('\n') || text.includes('\r')) { stdin.setRawMode?.(false); stdin.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(text.replace(/[\r\n]/g, '')); } }; process.stdout.write(label); stdin.setRawMode?.(true); stdin.on('data', onData); }); }

export async function setSecret(operation: 'bind' | 'set' | 'generate', name: string, account = name): Promise<void> {
  assertName(name); if (operation === 'bind') { await execFile('security', ['find-generic-password', '-s', service, '-a', account]); return; }
  const value = operation === 'generate' ? randomBytes(32).toString('base64url') : await promptHidden('Secret: '); if (!value) throw new Error('secret cannot be empty');
  await execFile('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const [operation, name, account] = process.argv.slice(2); if (!operation || !name || !['bind', 'set', 'generate'].includes(operation)) { console.error('usage: set-secret.ts <bind|set|generate> <logical-name> [keychain-account]'); process.exitCode = 2; } else { void setSecret(operation as 'bind' | 'set' | 'generate', name, account).then(() => console.log('ok')).catch((error) => { console.error(error instanceof Error ? error.message : 'secret operation failed'); process.exitCode = 1; }); } }
