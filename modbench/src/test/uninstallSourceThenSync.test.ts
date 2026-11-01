import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { modCommands, modSyncOver } from '../modCommands/modCommands';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { adapterOver, readModlistEntries } from './mo2/adapterOver';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { writeBuildFile } from './buildFiles';
import { writeManifestIn } from '../manifestAdapter/manifestAdapter';

const MOD = 'Built Mod';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runGit = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd }); };

async function instanceWithSourceMod(): Promise<{ root: string; source: string; adapter: InstanceAdapter }> {
  const root = cloneCorpusFixture();
  roots.push(root);
  const source = join(root, 'source', 'Built Mod source');
  await mkdir(source, { recursive: true });
  await writeBuildFile(source);
  runGit(source, 'init', '--quiet', '--initial-branch=main');
  await mkdir(join(root, 'mods', MOD), { recursive: true });
  await writeManifestIn(join(root, 'mods', MOD), {
    packages: [{ kind: 'repository', name: 'Built Mod source' }], exclude: [], ignore: [], files: new Map(),
  });
  const adapter = adapterOver(root);
  const added = await modSyncOver(adapter)();
  expect(added.applied && added.added).toContain(MOD);
  return { root, source, adapter };
}

describe('an uninstall whose line write fails', () => {
  it('keeps the repository its manifest names, and leaves a line that mod sync then drops', async () => {
    const { root, source, adapter } = await instanceWithSourceMod();
    const lineWriteFails: InstanceAdapter = { ...adapter, changeModOrder: () => Promise.reject(new Error('disk full')) };
    const trash = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

    const outcome = await modCommands(lineWriteFails).uninstallMods([MOD], trash);
    expect(outcome).toMatchObject({ applied: true, outcome: { landed: [{ name: MOD, lineRefusal: 'disk full' }] } });
    await expect(stat(source)).resolves.toBeDefined();
    expect((await readModlistEntries(root)).some((entry) => entry.name === MOD)).toBe(true);
    const synced = await modSyncOver(adapter)();

    expect(synced).toMatchObject({ applied: true, dropped: [MOD] });
    expect((await readModlistEntries(root)).some((entry) => entry.name === MOD)).toBe(false);
  });
});
