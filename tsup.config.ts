import { defineConfig } from 'tsup';

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
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  external: ['better-sqlite3'],
});
