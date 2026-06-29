import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/test/**/*.test.ts', 'src/modmanager/**/*.test.ts', 'webview/src/**/*.test.tsx'],
    exclude: ['src/test/integration/**'],
    environment: 'node',
    globals: true,
    reporters: ['basic'],
    silent: true,
    environmentMatchGlobs: [['webview/src/**', 'happy-dom']],
  },
});
