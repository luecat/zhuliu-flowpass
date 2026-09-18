import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Admin auth tests derive scrypt keys at the production N=131072 cost, which
    // overruns the 5s default whenever the machine is under load.
    testTimeout: 30_000,
  },
});
