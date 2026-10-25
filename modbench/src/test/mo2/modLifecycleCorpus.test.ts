import { unreadStatus } from '../unreadStatus';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modCommands } from '../../modCommands/modCommands';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, snapshotTree,
} from './corpusFixture';
import { adapterOver, readDownloadedFile, readModlistEntries } from './adapterOver';
import { fakeInstallationFileReader } from '../fakeInstallationFileReader';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const unscriptedMEdit = new InMemoryMEditClient();


const trash = async (path: string): Promise<void> => { await rm(path, { recursive: true }); };

describe('mod lifecycle corpus (uninstall)', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const DOWNLOADED_FILE_NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

  it('uninstallMods trashes the folder, removes the modlist line, and marks the downloaded file its meta.ini names uninstalled — nothing else', async () => {
    const downloadedFileMeta = `downloads/${DOWNLOADED_FILE_NAME}.meta`;
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir), unscriptedMEdit, unreadStatus).uninstallMods(['Unofficial Fallout 4 Patch'], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST, downloadedFileMeta]));

    expect(after.has('mods/Unofficial Fallout 4 Patch/meta.ini')).toBe(false);
    expect((await readModlistEntries(dir)).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    expect(await readDownloadedFile(dir, DOWNLOADED_FILE_NAME)).toMatchObject({ meta: { status: 'Uninstalled' } });
  });

  it('uninstallMods on a mod with no linked downloaded file touches only its own folder and modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir), unscriptedMEdit, unreadStatus).uninstallMods(['Harder VATS'], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Harder VATS/meta.ini', MODLIST]));
    expect(after.has('mods/Harder VATS/meta.ini')).toBe(false);
  });

  it('renameMod moves the folder with its files and meta.ini, and renames the line in each profile, its repository beside mods/ staying where it is — nothing else', async () => {
    const folder = (name: string) => join(dir, 'mods', name);
    await mkdir(join(folder('Harder VATS'), 'Scripts'));
    await writeFile(join(folder('Harder VATS'), 'Scripts', 'a.pex'), 'a\n');
    await mkdir(join(dir, 'source', 'Harder VATS', '.git'), { recursive: true });
    await writeFile(join(dir, 'source', 'Harder VATS', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const before = await snapshotTree(dir);

    await modCommands(adapterOver(dir), unscriptedMEdit, unreadStatus).renameMod('Harder VATS', 'Harder VATS 2');
    const after = await snapshotTree(dir);

    const moved = [...before.keys()].filter((path) => path.startsWith('mods/Harder VATS/'));
    expect(moved).toEqual(expect.arrayContaining(['mods/Harder VATS/meta.ini', 'mods/Harder VATS/Scripts/a.pex']));
    expect(new Map(moved.map((path) => [path, after.get(path.replace('mods/Harder VATS/', 'mods/Harder VATS 2/'))]))).toEqual(new Map(moved.map((path) => [path, before.get(path)])));
    assertOnlyChanged(before, after, new Set([...moved, ...moved.map((p) => p.replace('/Harder VATS/', '/Harder VATS 2/')), MODLIST, 'profiles/Secondary/modlist.txt']));
    expect((await readModlistEntries(dir)).find((e) => e.name === 'Harder VATS 2')).toEqual({ kind: 'mod', name: 'Harder VATS 2', enabled: false });
  });
});

describe('mod lifecycle corpus (install)', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const MANUAL = 'Manually Dropped Archive.7z';

  it('installMod from a downloaded file writes the new mod\'s folder, its disabled line in mod order and the file\'s metadata, clearing the uninstalled key MO2 left as its own markInstalled does — nothing else', async () => {
    await writeFile(join(dir, 'downloads', MANUAL), 'archive bytes');
    await writeFile(join(dir, 'downloads', `${MANUAL}.meta`), '[General]\r\nuninstalled=true\r\n');
    const before = await snapshotTree(dir);

    const outcome = await modCommands(adapterOver(dir, { installationFileReader: fakeInstallationFileReader(['Manual.esp']) }), unscriptedMEdit, unreadStatus)
      .installMod({ kind: 'downloadedFile', name: MANUAL }, { kind: 'new', name: 'Manual' }, true);
    const after = await snapshotTree(dir);

    expect(outcome).toEqual({ applied: true, downloadedFile: MANUAL });
    assertOnlyChanged(before, after, new Set(['mods/Manual/Manual.esp', 'mods/Manual/meta.ini', 'profiles/Default/modlist.txt', `downloads/${MANUAL}.meta`]));
    expect(await readModlistEntries(dir)).toContainEqual({ kind: 'mod', name: 'Manual', enabled: false });
    expect(await readDownloadedFile(dir, MANUAL)).toMatchObject({ meta: { status: 'Installed' } });
  });
});
