import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const RUNTIME_BY_TARGET = { 'linux-x64': 'linux-x64', 'win32-x64': 'win-x64' };

function run(...args) {
  const { status } = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
const npm = (...args) => run(process.env.npm_execpath, ...args);

copyFileSync('../LICENSE', 'LICENSE');
copyFileSync('../README.md', 'README.md');
const vscePackage = createRequire(import.meta.url).resolve('@vscode/vsce/package.json');
const vsceBin = join(dirname(vscePackage), 'vsce');
npm('run', 'build');
for (const [target, runtime] of Object.entries(RUNTIME_BY_TARGET)) {
  npm('run', 'build:backend', '--', '-r', runtime);
  run('notices.mjs');
  run(vsceBin, 'package', '--no-dependencies', '--target', target);
}
