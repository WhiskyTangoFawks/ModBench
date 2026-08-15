import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  extensionDevelopmentPath: '.',
  workspaceFolder: './src/test/integration/workspace',
  mocha: {
    timeout: 20000,
    ui: 'bdd',
  },
});
