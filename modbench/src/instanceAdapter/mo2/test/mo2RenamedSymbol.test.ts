import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { ManagerAdapter } from '../../publisher';
import { managerOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';
import { OVERWRITE_ORIGIN } from '../../../wire/pluginAddress';

const SEPARATOR_FOLDER = 'mods/Unassigned (Modlist Development)_separator';

describe('the MO2 Instance adapter, on a file or folder another program renames', () => {
  let root: string;
  let adapter: ManagerAdapter;
  const at = (relative: string): string => join(root, relative);
  const renamed = (from: string, to: string) => adapter.renamedSymbol(at(from), at(to));

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it.each([
    ['a plugin at a mod\'s root', 'mods/Patch Mod/Patch Mod.esp', 'mods/Patch Mod/Renamed.esp',
      { kind: 'plugin', plugin: { name: 'Patch Mod.esp', origin: 'Patch Mod' }, to: 'Renamed.esp' }],
    ['a plugin of Overwrite', 'overwrite/Ran.esp', 'overwrite/Run.esp',
      { kind: 'plugin', plugin: { name: 'Ran.esp', origin: OVERWRITE_ORIGIN }, to: 'Run.esp' }],
    ['a plugin given a name that is no plugin\'s', 'mods/Patch Mod/Patch Mod.esp', 'mods/Patch Mod/Patch Mod.esp.bak',
      { kind: 'plugin', plugin: { name: 'Patch Mod.esp', origin: 'Patch Mod' }, to: 'Patch Mod.esp.bak' }],
    ['a mod\'s folder', 'mods/Patch Mod', 'mods/Renamed Mod',
      { kind: 'entry', entry: { kind: 'mod', name: 'Patch Mod' }, to: { kind: 'mod', name: 'Renamed Mod' } }],
    ['a separator\'s folder', SEPARATOR_FOLDER, 'mods/Gear_separator',
      { kind: 'entry', entry: { kind: 'separator', name: 'Unassigned (Modlist Development)' }, to: { kind: 'separator', name: 'Gear' } }],
    ['a separator\'s folder given a mod\'s name', SEPARATOR_FOLDER, 'mods/Gear',
      { kind: 'entry', entry: { kind: 'separator', name: 'Unassigned (Modlist Development)' }, to: { kind: 'mod', name: 'Gear' } }],
  ])('names %s and the name it takes', async (_case, from, to, expected) => {
    expect(await renamed(from, to)).toEqual(expected);
  });

  it.each([
    ['a file at a mod\'s root that is no plugin', 'mods/Patch Mod/meta.ini', 'mods/Patch Mod/meta.old'],
    ['a plugin below a mod\'s root, which the game never loads', 'mods/Patch Mod/Optional/Extra.esp', 'mods/Patch Mod/Optional/Other.esp'],
    ['a plugin moved to another mod, which no rename is', 'mods/Patch Mod/Patch Mod.esp', 'mods/Harder VATS/Patch Mod.esp'],
    ['a profile\'s file', 'profiles/Default/plugins.txt', 'profiles/Default/plugins.old'],
  ])('names nothing for %s', async (_case, from, to) => {
    expect(await renamed(from, to)).toBeUndefined();
  });
});

describe('the MO2 Instance adapter renaming a mod\'s folder', () => {
  let root: string;
  let adapter: ManagerAdapter;
  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('counts a folder another program renamed to the new name as renamed', async () => {
    await rename(join(root, 'mods/Patch Mod'), join(root, 'mods/Renamed Mod'));

    await expect(adapter.renameModFolder('Patch Mod', 'Renamed Mod')).resolves.toBeUndefined();
  });
});
