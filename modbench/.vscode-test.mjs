import { defineConfig } from '@vscode/test-cli';

const mocha = { timeout: 20000, ui: 'bdd' };

export default defineConfig([
  {
    label: 'instance',
    files: 'out/test/integration/{*.test.js,!(notAnInstance)/**/*.test.js}',
    extensionDevelopmentPath: '.',
    workspaceFolder: './src/test/integration/workspace',
    mocha,
  },
  {
    label: 'notAnInstance',
    files: 'out/test/integration/notAnInstance/**/*.test.js',
    extensionDevelopmentPath: '.',
    workspaceFolder: './src/test/integration/notAnInstanceWorkspace',
    mocha,
  },
]);
