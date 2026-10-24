import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WINDOWS = { target: 'win32-x64', runtime: 'win-x64' };
const LINUX = { target: 'linux-x64', runtime: 'linux-x64' };
// A zip written on Windows carries no execute bit, so a Linux backend packaged there cannot start.
// The host's target packages last, so backend/ and the FOMOD engine end as the host's for a dev run.
const targets = process.platform === 'win32' ? [WINDOWS] : [WINDOWS, LINUX];

function nodeWith(env, ...args) {
  const { status } = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (status !== 0) process.exit(status ?? 1);
}
const node = (...args) => nodeWith({}, ...args);
const npm = (...args) => node(process.env.npm_execpath, ...args);

copyFileSync('../LICENSE', 'LICENSE');
copyFileSync('../README.md', 'README.md');
const vscePackage = createRequire(import.meta.url).resolve('@vscode/vsce/package.json');
const vsceBin = join(dirname(vscePackage), 'vsce');
npm('run', 'build');
for (const { target, runtime } of targets) {
  npm('run', 'build:backend', '--', '-r', runtime);
  nodeWith({ FOMOD_ENGINE_TARGET: target }, 'esbuild.mjs');
  node('notices.mjs');
  node(vsceBin, 'package', '--no-dependencies', '--target', target);
}
