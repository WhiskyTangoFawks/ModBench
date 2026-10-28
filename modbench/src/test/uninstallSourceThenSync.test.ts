import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { modCommands, modSyncOver } from '../modCommands/modCommands';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { adapterOver, managerOver, readModlistEntries } from './mo2/adapterOver';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { unreadStatus } from './unreadStatus';

const MOD = 'Built Mod';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runGit = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd }); };

async function instanceWithSourceMod(): Promise<{ root: string; adapter: InstanceAdapter }> {
  const root = cloneCorpusFixture();
  roots.push(root);
  const source = join(root, 'source', 'Built Mod source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, `${MOD}.manifest.json`), JSON.stringify({ output: MOD, packages: [] }));
  runGit(source, 'init', '--quiet', '--initial-branch=main');
  runGit(source, 'remote', 'add', 'origin', 'https://example.test/built.git');
  runGit(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'first');
  runGit(root, 'init', '--quiet');
  await managerOver(root).writeIgnoreList();
  await managerOver(root).writeSubmodules();
  await mkdir(join(root, 'mods', MOD), { recursive: true });
  await writeFile(join(root, 'mods', MOD, 'a.txt'), 'x');
  const adapter = adapterOver(root);
  expect(await modSyncOver(adapter)()).toMatchObject({ applied: true, added: expect.arrayContaining([MOD]) });
  return { root, adapter };
}

describe('an uninstall whose line write fails', () => {
  it('leaves a line that mod sync then drops, since the trashed source builds nothing', async () => {
    const { root, adapter } = await instanceWithSourceMod();
    const lineWriteFails: InstanceAdapter = { ...adapter, changeModOrder: () => Promise.reject(new Error('disk full')) };
    const trash = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

    const outcome = await modCommands(lineWriteFails, new InMemoryMEditClient(), unreadStatus).uninstallMods([MOD], trash);
    expect(outcome).toMatchObject({ applied: true, outcome: { landed: [{ name: MOD, lineRefusal: 'disk full' }] } });
    expect((await readModlistEntries(root)).some((entry) => entry.name === MOD)).toBe(true);
    const synced = await modSyncOver(adapter)();

    expect(synced).toMatchObject({ applied: true, dropped: [MOD] });
    expect((await readModlistEntries(root)).some((entry) => entry.name === MOD)).toBe(false);
  });
});
