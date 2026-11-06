import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { ManagerAdapter } from '../../publisher';
import { managerOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';
import { OVERWRITE_ORIGIN } from '../../../wire/pluginAddress';

const SEPARATOR_FOLDER = 'mods/Unassigned (Modlist Development)_separator';
const UFO4P = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

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
    ['a downloaded file', `downloads/${UFO4P}`, 'downloads/UFO4P.7z',
      { kind: 'entry', entry: { kind: 'downloadedFile', name: UFO4P }, to: { kind: 'downloadedFile', name: 'UFO4P.7z' } }],
    ['a downloaded file given a name install cannot take', `downloads/${UFO4P}`, 'downloads/UFO4P.7z.bak',
      { kind: 'entry', entry: { kind: 'downloadedFile', name: UFO4P }, to: { kind: 'downloadedFile', name: 'UFO4P.7z.bak' } }],
    ['a profile\'s folder', 'profiles/Secondary', 'profiles/Third',
      { kind: 'entry', entry: { kind: 'profile', name: 'Secondary' }, to: { kind: 'profile', name: 'Third' } }],
    ['a mod\'s folder with a name install can take', 'mods/Patch Mod.zip', 'mods/Patch Mod.7z',
      { kind: 'entry', entry: { kind: 'mod', name: 'Patch Mod.zip' }, to: { kind: 'mod', name: 'Patch Mod.7z' } }],
    ['a script\'s source in a mod', 'mods/Patch Mod/Scripts/Source/User/Ns/Quest.psc', 'mods/Patch Mod/Scripts/Source/User/Ns/Renamed.psc', {
      kind: 'script', origin: { kind: 'mod', name: 'Patch Mod' }, path: 'Scripts/Source/User/Ns/Quest.psc', name: 'Ns:Quest',
      to: { path: 'Scripts/Source/User/Ns/Renamed.psc', name: 'Ns:Renamed' },
    }],
    ['a compiled script of Overwrite', 'overwrite/Scripts/Quest.pex', 'overwrite/Scripts/Renamed.pex', {
      kind: 'script', origin: { kind: 'runtimeOutput' }, path: 'Scripts/Quest.pex', name: 'Quest', to: { path: 'Scripts/Renamed.pex', name: 'Renamed' },
    }],
    ['a script given a name that is no script\'s', 'mods/Patch Mod/Scripts/Quest.pex', 'mods/Patch Mod/Scripts/Quest.pex.bak', {
      kind: 'script', origin: { kind: 'mod', name: 'Patch Mod' }, path: 'Scripts/Quest.pex', name: 'Quest', to: { path: 'Scripts/Quest.pex.bak' },
    }],
  ])('names %s and the name it takes', async (_case, from, to, expected) => {
    await mkdir(at('mods/Patch Mod.zip'), { recursive: true });
    expect(await renamed(from, to)).toEqual(expected);
  });

  it.each([
    ['a file at a mod\'s root that is no plugin', 'mods/Patch Mod/meta.ini', 'mods/Patch Mod/meta.old'],
    ['a plugin below a mod\'s root, which the game never loads', 'mods/Patch Mod/Optional/Extra.esp', 'mods/Patch Mod/Optional/Other.esp'],
    ['a plugin moved to another mod, which no rename is', 'mods/Patch Mod/Patch Mod.esp', 'mods/Harder VATS/Patch Mod.esp'],
    ['a profile\'s file', 'profiles/Default/plugins.txt', 'profiles/Default/plugins.old'],
    ['a downloaded file\'s metadata', `downloads/${UFO4P}.meta`, 'downloads/UFO4P.7z.meta'],
    ['a file of the downloads folder install cannot take', 'downloads/notes.txt', 'downloads/notes.old'],
    ['a script outside a mod', 'Scripts/Quest.pex', 'Scripts/Renamed.pex'],
  ])('names nothing for %s', async (_case, from, to) => {
    expect(await renamed(from, to)).toBeUndefined();
  });

  it('says why it cannot tell whether a file install can take is a downloaded file while the downloads folder cannot be resolved, and names a mod\'s folder still', async () => {
    const unresolved = managerOver(root, { downloadsFolder: { kind: 'unresolved', reason: 'download_directory names no folder' } });

    await expect(unresolved.renamedSymbol(at(`downloads/${UFO4P}`), at('downloads/UFO4P.7z'))).rejects.toThrow('download_directory names no folder');
    expect(await unresolved.renamedSymbol(at('mods/Patch Mod'), at('mods/Renamed Mod'))).toMatchObject({ entry: { kind: 'mod', name: 'Patch Mod' } });
  });

  it('names nothing for a file install can take in a mod while the downloads folder cannot be resolved', async () => {
    const unresolved = managerOver(root, { downloadsFolder: { kind: 'unresolved', reason: 'download_directory names no folder' } });

    expect(await unresolved.renamedSymbol(at('mods/Patch Mod/Bundled.zip'), at('mods/Patch Mod/Renamed.zip'))).toBeUndefined();
  });

  describe('renaming a downloaded file', () => {
    const META = 'mods/Unofficial Fallout 4 Patch/meta.ini';

    it('moves the file and its metadata, then names it in each mod\'s meta.ini that was installed from it, below the folder it names', async () => {
      await writeFile(at('mods/Harder VATS/meta.ini'), `[General]\ninstallationFile=C:/Downloads/${UFO4P.toUpperCase()}\n`);

      expect(await adapter.renameDownloadedFile(UFO4P, 'UFO4P.7z')).toEqual([]);

      expect([existsSync(at(`downloads/${UFO4P}`)), existsSync(at('downloads/UFO4P.7z')), existsSync(at('downloads/UFO4P.7z.meta'))]).toEqual([false, true, true]);
      expect(await readFile(at(META), 'utf8')).toContain('installationFile=UFO4P.7z\r\n');
      expect(await readFile(at('mods/Harder VATS/meta.ini'), 'utf8')).toBe('[General]\ninstallationFile=C:/Downloads/UFO4P.7z\n');
    });

    it('counts the file and its metadata already at the new name as moved', async () => {
      await rename(at(`downloads/${UFO4P}`), at('downloads/UFO4P.7z'));

      await adapter.renameDownloadedFile(UFO4P, 'UFO4P.7z');

      expect([existsSync(at('downloads/UFO4P.7z')), existsSync(at('downloads/UFO4P.7z.meta'))]).toEqual([true, true]);
      expect(await readFile(at(META), 'utf8')).toContain('installationFile=UFO4P.7z\r\n');
    });

    it('refuses a file already at the new name, and moves nothing', async () => {
      await writeFile(at('downloads/Other.7z'), '');

      await expect(adapter.renameDownloadedFile(UFO4P, 'Other.7z')).rejects.toThrow('Other.7z');

      expect(existsSync(at(`downloads/${UFO4P}`))).toBe(true);
    });

    it('answers each meta.ini that could not follow, and follows in the rest', async () => {
      await rm(at('mods/Harder VATS/meta.ini'));
      await mkdir(at('mods/Harder VATS/meta.ini'));

      const cannotFollow = await adapter.renameDownloadedFile(UFO4P, 'UFO4P.7z');

      expect(cannotFollow).toEqual([expect.stringContaining(join('Harder VATS', 'meta.ini')) as unknown]);
      expect(await readFile(at(META), 'utf8')).toContain('installationFile=UFO4P.7z');
    });
  });

  describe('renaming a profile', () => {
    it('moves its folder, then the profile ModOrganizer.ini selects', async () => {
      expect(await adapter.renameProfile('Default', 'Main')).toEqual([]);

      expect([existsSync(at('profiles/Default')), existsSync(at('profiles/Main/modlist.txt'))]).toEqual([false, true]);
      expect(await readFile(at('ModOrganizer.ini'), 'utf8')).toContain('selected_profile=@ByteArray(Main)\r\n');
    });

    it('counts a folder already at the new name as moved, and leaves a selected profile it does not name', async () => {
      await rename(at('profiles/Secondary'), at('profiles/Third'));

      expect(await adapter.renameProfile('Secondary', 'Third')).toEqual([]);

      expect(await readFile(at('ModOrganizer.ini'), 'utf8')).toContain('selected_profile=@ByteArray(Default)\r\n');
    });

    it('refuses a profile whose folder is at neither name', async () => {
      await expect(adapter.renameProfile('Gone', 'Third')).rejects.toThrow('Gone');
    });
  });
});
