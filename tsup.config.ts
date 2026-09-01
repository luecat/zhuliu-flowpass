import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  entry: {
    'server/admin': 'server/admin/main.ts',
    'server/worker': 'server/worker/main.ts',
    'server/backup': 'scripts/backup.ts',
    'server/model-runtime': 'scripts/model-runtime.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  // The admin Vite build shares dist/. Cleaning here deletes dist/admin.
  clean: false,
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  external: ['better-sqlite3'],
  noExternal: ['@hono/node-server', 'hono', 'uuid', 'zod'],
  onSuccess: async () => {
    mkdirSync('dist/server/migrations', { recursive: true });
    cpSync('server/db/migrations', 'dist/server/migrations', { recursive: true });
  },
});
