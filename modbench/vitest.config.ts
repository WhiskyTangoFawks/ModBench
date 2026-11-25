import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // As esbuild.mjs defines it for the bundle.
  define: { GLOSSARY: JSON.stringify(readFileSync('../spec/GLOSSARY.md', 'utf8')) },
  test: {
    include: ['src/**/*.test.ts', 'webview/src/**/*.test.tsx', 'webview/src/**/*.test.ts'],
    // A *.posix.test.ts file holds what exists only where the platform is POSIX: Windows does not collect it.
    exclude: ['src/test/integration/**', ...(process.platform === 'win32' ? ['**/*.posix.test.ts'] : [])],
    environment: 'node',
    // A date renders in the machine's time zone, so every machine renders one in the same zone.
    env: { TZ: 'UTC' },
    globals: true,
    reporters: ['basic'],
    silent: true,
    environmentMatchGlobs: [['webview/src/**', 'happy-dom']],
  },
});
