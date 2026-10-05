import { copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

copyFileSync('../LICENSE', 'LICENSE');
const target = `${process.platform}-${process.arch}`;
const vsce = spawnSync('npx', ['--no-install', 'vsce', 'package', '--no-dependencies', '--target', target], {
  stdio: 'inherit',
  shell: true,
});
process.exit(vsce.status ?? 1);
