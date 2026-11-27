import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const vscodeTest = join(dirname(createRequire(import.meta.url).resolve('@vscode/test-cli')), 'bin.mjs');
// Its arguments pass through, so a run can select its tests, as --grep does.
const args = [vscodeTest, ...process.argv.slice(2)];

// On Linux, VS Code runs on a display of its own, so a run opens no window on the desktop, and in X11:
// with a Wayland session in its environment, Electron would leave Xvfb for the desktop's compositor.
const run = process.platform === 'linux'
  ? spawnSync('xvfb-run', ['-a', process.execPath, ...args], {
    stdio: 'inherit',
    env: { ...process.env, WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: undefined },
  })
  : spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(run.status ?? 1);
