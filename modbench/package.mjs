import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

copyFileSync('../LICENSE', 'LICENSE');
const vscePackage = createRequire(import.meta.url).resolve('@vscode/vsce/package.json');
const vsceBin = join(dirname(vscePackage), 'vsce');
const target = `${process.platform}-${process.arch}`;
const vsce = spawnSync(process.execPath, [vsceBin, 'package', '--no-dependencies', '--target', target], {
  stdio: 'inherit',
});
process.exit(vsce.status ?? 1);
