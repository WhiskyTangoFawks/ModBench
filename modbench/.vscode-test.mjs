import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const port = await freePort();
const runDir = mkdtempSync(path.join(tmpdir(), 'modbench-it-'));
process.on('exit', () => rmSync(runDir, { recursive: true, force: true, maxRetries: 5 }));

// Named by the setting so the instance never falls back to detecting this machine's own install.
const gameDirectory = path.join(runDir, 'game');
mkdirSync(path.join(gameDirectory, 'Data'), { recursive: true });

const workspace = (name, fixture) => {
  const folder = path.join(runDir, name);
  if (fixture) cpSync(path.join(import.meta.dirname, fixture), folder, { recursive: true });
  mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify({
    'modbench.attachToBackendPort': port, 'modbench.mods.gameDirectory': gameDirectory,
  }));
  return folder;
};

// test-cli hands cachePath through to test-electron's download, so one install serves every
// worktree.
const shared = {
  version: '1.140.0',
  cachePath: path.join(process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'modbench', 'vscode-test'),
  extensionDevelopmentPath: '.',
  // Installing a dependency downloads a second VS Code into the checkout, and the one dependency,
  // vscode.git, ships with VS Code.
  skipExtensionDependencies: true,
  launchArgs: [
    '--user-data-dir', path.join(runDir, 'user-data'), '--extensions-dir', path.join(runDir, 'extensions'),
    '--logsPath', path.join(runDir, 'logs'),
  ],
  // Linux's OS trash lives under XDG_DATA_HOME, and every run trashes folders of the same names.
  env: { MODBENCH_TEST_PORT: String(port), XDG_DATA_HOME: path.join(runDir, 'data'), MODBENCH_TEST_LOGS: path.join(runDir, 'logs') },
  mocha: { timeout: 20000, ui: 'bdd' },
};

export default defineConfig([
  {
    ...shared,
    label: 'instance',
    files: 'out/test/integration/{*.test.js,!(notAnInstance)/**/*.test.js}',
    workspaceFolder: workspace('workspace', 'src/test/integration/workspace'),
  },
  {
    ...shared,
    label: 'notAnInstance',
    files: 'out/test/integration/notAnInstance/**/*.test.js',
    workspaceFolder: workspace('notAnInstanceWorkspace'),
  },
]);
