import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'chmod-executable',
      closeBundle() {
        const outFile = resolve(__dirname, 'dist/cli.js');
        if (existsSync(outFile)) {
          chmodSync(outFile, 0o755);
        }
      },
    },
  ],
  build: {
    ssr: 'src/cli.tsx',
    outDir: 'dist',
    target: 'node20',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        banner: '#!/usr/bin/env node',
        entryFileNames: 'cli.js',
        format: 'esm',
      },
    },
  },
});

