import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join } from 'node:path';
import { openMigratedDatabase } from '../server/db/connection';
import { hashAdminPassword } from '../server/admin/auth/password';
import { v7 as uuidv7 } from 'uuid';

if (!input.isTTY || !output.isTTY) throw new Error('bootstrap-admin requires an interactive TTY');
const rl = createInterface({ input, output });
async function hiddenQuestion(prompt: string): Promise<string> {
  output.write(prompt);
  input.setRawMode?.(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) { cleanup(); reject(new Error('cancelled')); return; }
        if (byte === 13 || byte === 10) { output.write('\n'); cleanup(); resolve(value); return; }
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    const cleanup = () => { input.off('data', onData); input.setRawMode?.(false); input.pause(); };
    input.on('data', onData);
  });
}
try {
  const displayName = (await rl.question('Admin display name: ')).trim();
  const password = await hiddenQuestion('Admin password: ');
  const confirm = await hiddenQuestion('Repeat admin password: ');
  if (!displayName || password !== confirm) throw new Error('display name or password confirmation is invalid');
  const database = openMigratedDatabase(join(process.env.FLOWPASS_DATA_ROOT ?? join(process.cwd(), '.flowpass-local'), 'data', 'flowpass.sqlite3'));
  try {
    const id = uuidv7();
    database.prepare(`INSERT INTO admin_users (id, display_name, password_hash, status, created_at, disabled_at, row_version) VALUES (?, ?, ?, 'active', ?, NULL, 1)`).run(id, displayName, hashAdminPassword(password), new Date().toISOString());
    console.log(`Admin account ${displayName} created.`);
  } finally { database.close(); }
} finally { rl.close(); }
