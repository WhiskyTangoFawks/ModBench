import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FomodEngine } from '../instanceAdapter/fomodInstaller/fomodInstaller';

const bundles = mkdtempSync(join(tmpdir(), 'modbench-fomod-engine-'));
process.on('exit', () => rmSync(bundles, { recursive: true, force: true }));

/** `entry` bundled as the build bundles the engine's process. */
export function engineProcessFrom(entry: string): string {
  const outfile = join(bundles, `${basename(entry, '.ts')}.js`);
  buildSync({ entryPoints: [entry], outfile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
  return outfile;
}

/** The engine as the development tree holds it: its process from its source, and the add-on npm installed. */
export const FOMOD_ENGINE: FomodEngine = {
  process: engineProcessFrom(join(__dirname, '..', 'instanceAdapter', 'fomodInstaller', 'engineProcess.ts')),
  folder: join(__dirname, '..', '..', 'node_modules', '@nexusmods', 'fomod-installer-native', 'prebuilds', `${process.platform}-${process.arch}`),
  silence: 60_000,
};
