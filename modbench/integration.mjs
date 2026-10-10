import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const vscodeTest = join(dirname(createRequire(import.meta.url).resolve('@vscode/test-cli')), 'bin.mjs');

// On Linux, VS Code runs on a display of its own, so a run opens no window on the desktop, and in X11:
// with a Wayland session in its environment, Electron would leave Xvfb for the desktop's compositor.
const run = process.platform === 'linux'
  ? spawnSync('xvfb-run', ['-a', process.execPath, vscodeTest], {
    stdio: 'inherit',
    env: { ...process.env, WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: undefined },
  })
  : spawnSync(process.execPath, [vscodeTest], { stdio: 'inherit' });
process.exit(run.status ?? 1);
