import { defineConfig } from 'vite';

export default defineConfig({
  root: 'admin',
  build: {
    outDir: '../dist/admin',
    emptyOutDir: true,
  },
});
