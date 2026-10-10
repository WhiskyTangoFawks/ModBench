import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'webview/src/**/*.test.tsx', 'webview/src/**/*.test.ts'],
    exclude: ['src/test/integration/**'],
    environment: 'node',
    // A date renders in the machine's time zone, so every machine renders one in the same zone.
    env: { TZ: 'UTC' },
    globals: true,
    reporters: ['basic'],
    silent: true,
    environmentMatchGlobs: [['webview/src/**', 'happy-dom']],
  },
});
