import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameMod, uninstallMods } from '../../modlist/modlist';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, snapshotTree,
} from './corpusFixture';
import { adapterOver, readModlistEntries } from './adapterOver';

const PROFILE = 'Default';

const trash = async (path: string): Promise<void> => { await rm(path, { recursive: true }); };

describe('mod lifecycle corpus (uninstall)', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const ARCHIVE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

  it('uninstallMods trashes the folder, removes the modlist line, and marks its download uninstalled — nothing else', async () => {
    const downloadMeta = `downloads/${ARCHIVE}.meta`;
    const before = await snapshotTree(dir);
    await uninstallMods(adapterOver(dir), PROFILE, [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST, downloadMeta]));

    expect(after.has('mods/Unofficial Fallout 4 Patch/meta.ini')).toBe(false);
    expect((await readModlistEntries(dir)).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    const metaText = await readFile(join(dir, downloadMeta), 'utf8');
    expect(metaText).toContain('uninstalled=true');
  });

  it('uninstallMods marks no download when none is handed in, though the mod\'s meta.ini names one', async () => {
    const downloadMeta = `downloads/${ARCHIVE}.meta`;
    const before = await snapshotTree(dir);
    await uninstallMods(adapterOver(dir), PROFILE, [{ name: 'Unofficial Fallout 4 Patch' }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST]));
    expect(after.get(downloadMeta)).toEqual(before.get(downloadMeta));
  });

  it('uninstallMods on a mod with no linked download touches only its own folder and modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await uninstallMods(adapterOver(dir), PROFILE, [{ name: 'Harder VATS' }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Harder VATS/meta.ini', MODLIST]));
    expect(after.has('mods/Harder VATS/meta.ini')).toBe(false);
  });

  it('renameMod moves the folder with its repository, plugin source and meta.ini, and renames the line in each profile — nothing else', async () => {
    const folder = (name: string) => join(dir, 'mods', name);
    await mkdir(join(folder('Harder VATS'), '.git'));
    await mkdir(join(folder('Harder VATS'), 'plugin-source'));
    await writeFile(join(folder('Harder VATS'), '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(folder('Harder VATS'), 'plugin-source', 'a.psc'), 'Scriptname a\n');
    const before = await snapshotTree(dir);

    await renameMod(adapterOver(dir), PROFILE, [PROFILE, 'Secondary'], 'Harder VATS', 'Harder VATS 2');
    const after = await snapshotTree(dir);

    const moved = [...before.keys()].filter((path) => path.startsWith('mods/Harder VATS/'));
    expect(moved).toEqual(expect.arrayContaining([
      'mods/Harder VATS/meta.ini', 'mods/Harder VATS/.git/HEAD', 'mods/Harder VATS/plugin-source/a.psc',
    ]));
    for (const path of moved) {
      expect(after.get(path.replace('mods/Harder VATS/', 'mods/Harder VATS 2/')), path).toEqual(before.get(path));
    }
    assertOnlyChanged(before, after, new Set([...moved, ...moved.map((p) => p.replace('/Harder VATS/', '/Harder VATS 2/')), MODLIST, 'profiles/Secondary/modlist.txt']));
    expect((await readModlistEntries(dir)).find((e) => e.name === 'Harder VATS 2')).toEqual({ kind: 'mod', name: 'Harder VATS 2', enabled: false });
  });
});
