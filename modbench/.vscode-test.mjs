import { defineConfig } from '@vscode/test-cli';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const agentPort = await freePort();
const runDir = mkdtempSync(path.join(tmpdir(), 'modbench-it-'));

// Named by the setting so the instance never falls back to detecting this machine's own install.
const gameFolder = path.join(runDir, 'game');
mkdirSync(path.join(gameFolder, 'Data'), { recursive: true });

// A user task of each kind a user tasks.json holds, running a script that records its arguments in its working folder
// and exits with the last of them.
const step = path.join(runDir, 'step.js');
writeFileSync(step, "const args = process.argv.slice(2); require('fs').writeFileSync('ran.txt', args.join(' ')); process.exit(Number(args.at(-1)));");
mkdirSync(path.join(runDir, 'user-data', 'User'), { recursive: true });
writeFileSync(path.join(runDir, 'user-data', 'User', 'tasks.json'), JSON.stringify({
  version: '2.0.0',
  tasks: [
    { label: 'Process step', type: 'process', command: process.execPath, args: [step] },
    { label: 'Shell step', type: 'shell', command: process.execPath, args: [step] },
  ],
}));

const workspace = (name, fixture) => {
  const folder = path.join(runDir, name);
  if (fixture) cpSync(path.join(import.meta.dirname, fixture), folder, { recursive: true });
  mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify({
    'modbench.attachToBackendPort': port, 'modbench.mods.gameFolder': gameFolder, 'modbench.agent.port': agentPort,
  }));
  return folder;
};

const logs = path.join(runDir, 'logs');
// A failed run keeps its logs, where the suite leaves the mock backend's requests.
process.on('exit', (code) => {
  if (code !== 0 && existsSync(logs)) {
    renameSync(logs, `${runDir}-logs`);
    console.error(`The failed run's logs: ${runDir}-logs`);
  }
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5 });
});

// test-cli hands cachePath through to test-electron's download, so one install serves every
// worktree. The download makes only the last folder of the path, so a first run makes the rest.
const cachePath = path.join(process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'modbench', 'vscode-test');
mkdirSync(path.dirname(cachePath), { recursive: true });

const shared = {
  version: '1.140.0',
  cachePath,
  extensionDevelopmentPath: '.',
  launchArgs: [
    '--user-data-dir', path.join(runDir, 'user-data'), '--extensions-dir', path.join(runDir, 'extensions'),
    '--logsPath', logs,
  ],
  // Linux's OS trash lives under XDG_DATA_HOME, and every run trashes folders of the same names.
  env: { MODBENCH_TEST_PORT: String(port), MODBENCH_TEST_AGENT_PORT: String(agentPort), XDG_DATA_HOME: path.join(runDir, 'data'), MODBENCH_TEST_LOGS: logs },
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
