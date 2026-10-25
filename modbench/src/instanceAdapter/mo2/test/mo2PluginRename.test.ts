import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rename as fsRename, rm, symlink, writeFile } from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { present } from '../../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({
  rename: undefined as typeof import('node:fs/promises').rename | undefined,
  listEntries: undefined as typeof import('../../files').listEntries | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('../../files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../files')>();
  real.listEntries = actual.listEntries;
  return { ...actual, listEntries: vi.fn(actual.listEntries) };
});
const actualListEntries: typeof listEntries = (path, skippedLink) => present(real.listEntries, 'the real listEntries')(path, skippedLink);
const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);

import { listEntries } from '../../files';
import type { FileOrigin } from '../../instanceAdapter';
import type { ManagerAdapter } from '../../publisher';
import { managerOver, readPluginLines } from '../../../test/mo2/adapterOver';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree, textsUnder } from '../../../test/mo2/corpusFixture';

const MOD = 'mods/Patch Mod';
const ORIGIN: FileOrigin = { kind: 'mod', name: 'Patch Mod' };
const DEFAULT_PLUGINS = 'profiles/Default/plugins.txt';
const SECONDARY_PLUGINS = 'profiles/Secondary/plugins.txt';
const DEFAULT_LOAD_ORDER = 'profiles/Default/loadorder.txt';
const SECONDARY_LOAD_ORDER = 'profiles/Secondary/loadorder.txt';

const NAMED_FOR_IT: ReadonlyArray<readonly [before: string, after: string]> = [
  ['Patch Mod.esp', 'Renamed Patch.esp'],
  ['Patch Mod.ini', 'Renamed Patch.ini'],
  ['Patch Mod - Main.ba2', 'Renamed Patch - Main.ba2'],
  ['Patch Mod - Textures.ba2', 'Renamed Patch - Textures.ba2'],
  ['Strings/Patch Mod_en.STRINGS', 'Strings/Renamed Patch_en.STRINGS'],
  ['Strings/Patch Mod_en.DLSTRINGS', 'Strings/Renamed Patch_en.DLSTRINGS'],
].map(([before, after]) => [`${MOD}/${before}`, `${MOD}/${after}`] as const);

const NOT_NAMED_FOR_IT = [
  `${MOD}/Patch Mod_Extra.esp`,
  `${MOD}/Strings/Patch Mod_Extra_en.STRINGS`,
  `${MOD}/Strings/Patch Mod_xx.STRINGS`,
  `${MOD}/plugin-source/Patch Mod.esp/record.json`,
  `${MOD}/Other Archive - Main.ba2`,
];

describe('the MO2 Instance adapter renaming a plugin', () => {
  let root: string;
  let adapter: ManagerAdapter;
  const at = (relative: string): string => join(root, relative);
  const text = (relative: string): Promise<string> => readFile(at(relative), 'utf8');
  const rename = (to = 'Renamed Patch.esp'): Promise<void> =>
    adapter.renamePlugin(ORIGIN, 'Patch Mod.esp', to);

  async function settingsNameGame(gameName: string): Promise<void> {
    const file = join(root, 'ModOrganizer.ini');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^gameName=.*$/m, `gameName=${gameName}`));
  }

  async function put(relative: string, contents = relative): Promise<void> {
    await mkdir(join(at(relative), '..'), { recursive: true });
    await writeFile(at(relative), contents);
  }

  beforeEach(async () => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
    for (const [before] of NAMED_FOR_IT.slice(1)) await put(before);
    for (const path of NOT_NAMED_FOR_IT) await put(path);
    await put(SECONDARY_PLUGINS, '*Unofficial Fallout 4 Patch.esp\r\nPatch Mod.esp\r\n*Last.esp\r\n');
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(listEntries).mockImplementation(actualListEntries);
    await rm(root, { recursive: true, force: true });
  });

  describe('whether an origin holds a plugin', () => {
    it('finds the folder of a mod named in another case', async () => {
      expect(await adapter.originHoldsPlugin({ kind: 'mod', name: 'patch mod' }, 'Patch Mod.esp')).toBe(true);
    });

    it('answers false for a folder of the name and for a mod with no folder', async () => {
      await mkdir(at(`${MOD}/Folder.esp`));

      expect(await adapter.originHoldsPlugin(ORIGIN, 'Folder.esp')).toBe(false);
      expect(await adapter.originHoldsPlugin({ kind: 'mod', name: 'Gone' }, 'Patch Mod.esp')).toBe(false);
    });

    it('answers for Overwrite as the run-time output', async () => {
      await put('overwrite/Ran.esp');

      expect(await adapter.originHoldsPlugin({ kind: 'runtimeOutput' }, 'Ran.esp')).toBe(true);
      expect(await adapter.originHoldsPlugin({ kind: 'runtimeOutput' }, 'Patch Mod.esp')).toBe(false);
    });
  });

  it('renames the plugin, its strings, its archives and its ini, and its line in every profile that lists it, in the place and the enabled state it had', async () => {
    const before = await snapshotTree(root);

    await rename();

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set([...NAMED_FOR_IT.flat(), DEFAULT_PLUGINS, SECONDARY_PLUGINS]));
    expect(textsUnder(after, MOD)).toEqual({
      [`${MOD}/meta.ini`]: '[General]\r\ngameName=Fallout4\r\nmodid=0\r\nversion=1.2.3\r\ncategory="-1,"\r\ninstallationFile=\r\n',
      [`${MOD}/Renamed Patch.esp`]: 'placeholder plugin bytes: Patch Mod.esp',
      [`${MOD}/Renamed Patch.ini`]: `${MOD}/Patch Mod.ini`,
      [`${MOD}/Renamed Patch - Main.ba2`]: `${MOD}/Patch Mod - Main.ba2`,
      [`${MOD}/Renamed Patch - Textures.ba2`]: `${MOD}/Patch Mod - Textures.ba2`,
      [`${MOD}/Strings/Renamed Patch_en.STRINGS`]: `${MOD}/Strings/Patch Mod_en.STRINGS`,
      [`${MOD}/Strings/Renamed Patch_en.DLSTRINGS`]: `${MOD}/Strings/Patch Mod_en.DLSTRINGS`,
      [`${MOD}/Patch Mod_Extra.esp`]: `${MOD}/Patch Mod_Extra.esp`,
      [`${MOD}/Strings/Patch Mod_Extra_en.STRINGS`]: `${MOD}/Strings/Patch Mod_Extra_en.STRINGS`,
      [`${MOD}/Strings/Patch Mod_xx.STRINGS`]: `${MOD}/Strings/Patch Mod_xx.STRINGS`,
      [`${MOD}/plugin-source/Patch Mod.esp/record.json`]: `${MOD}/plugin-source/Patch Mod.esp/record.json`,
      [`${MOD}/Other Archive - Main.ba2`]: `${MOD}/Other Archive - Main.ba2`,
    });
    expect(await readPluginLines(root)).toEqual([
      { name: 'NonAsciiRetexture.esp', enabled: true },
      { name: 'Renamed Patch.esp', enabled: true },
      { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
      { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
    ]);
    expect(await text(SECONDARY_PLUGINS)).toBe('*Unofficial Fallout 4 Patch.esp\r\nRenamed Patch.esp\r\n*Last.esp\r\n');
    expect((await text(DEFAULT_PLUGINS)).startsWith('﻿')).toBe(true);
  });

  it('renames the plugin\'s line in every loadorder.txt that lists it, as MO2 takes the order from there', async () => {
    await put(DEFAULT_LOAD_ORDER, 'Patch Mod.esp\r\nOther.esp\r\n');
    await put(SECONDARY_LOAD_ORDER, 'Other.esp\r\n');

    await rename();

    expect(await text(DEFAULT_LOAD_ORDER)).toBe('Renamed Patch.esp\r\nOther.esp\r\n');
    expect(await text(SECONDARY_LOAD_ORDER)).toBe('Other.esp\r\n');
  });

  it('settles a plugin move overlapping a rename on one profile, both taking the plugin order files\' locks in one order', async () => {
    await put(DEFAULT_LOAD_ORDER, 'Patch Mod.esp\r\nOther.esp\r\n');
    const move = adapter.changePluginOrder('Default', () => [{ kind: 'move', plugins: ['Patch Mod.esp'], toIndex: 0 }]);

    await Promise.all([rename(), move]);

    expect(await text(DEFAULT_LOAD_ORDER)).toContain('Renamed Patch.esp');
  }, 2000);

  it.each(NOT_NAMED_FOR_IT)('leaves the files of other plugins named alike, the plugin source and an archive of another name where they are: %s', async (path) => {
    await rename();

    expect((await snapshotTree(root)).has(path)).toBe(true);
  });

  it('leaves an archive that belongs to a plugin whose name starts with this one, as the archive\'s name cut at its last " - " is that plugin\'s', async () => {
    await put(`${MOD}/Patch Mod - Bar.esp`);
    await put(`${MOD}/Patch Mod - Bar - Main.ba2`);

    await rename();

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/Patch Mod - Bar - Main.ba2`)).toBe(true);
    expect(after.has(`${MOD}/Renamed Patch - Bar - Main.ba2`)).toBe(false);
  });

  it('renames the files a release of another game names for a plugin, by that release\'s archive extension and language spellings', async () => {
    await put(`${MOD}/Patch Mod - Main.bsa`);
    await put(`${MOD}/Strings/Patch Mod_English.STRINGS`);
    await settingsNameGame('Skyrim Special Edition');

    await adapter.renamePlugin(ORIGIN, 'Patch Mod.esp', 'Renamed Patch.esp');

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/Renamed Patch - Main.bsa`)).toBe(true);
    expect(after.has(`${MOD}/Strings/Renamed Patch_English.STRINGS`)).toBe(true);
    expect(after.has(`${MOD}/Patch Mod - Main.ba2`)).toBe(true);
    expect(after.has(`${MOD}/Strings/Patch Mod_en.STRINGS`)).toBe(true);
  });

  it('renames a plugin whose name changes only its case, and its files and line with it', async () => {
    await rename('PATCH MOD.esp');

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/PATCH MOD.esp`)).toBe(true);
    expect(after.has(`${MOD}/PATCH MOD - Main.ba2`)).toBe(true);
    expect((await readPluginLines(root)).map((p) => p.name)).toContain('PATCH MOD.esp');
  });

  it('renames a plugin of Overwrite, which holds files as a mod does', async () => {
    await put('overwrite/Run.esp');
    await put(DEFAULT_PLUGINS, '*Run.esp\r\n');

    await adapter.renamePlugin({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp');

    expect((await snapshotTree(root)).has('overwrite/Ran.esp')).toBe(true);
    expect(await text(DEFAULT_PLUGINS)).toBe('*Ran.esp\r\n');
  });

  it('renames the files and no line when no profile lists the plugin', async () => {
    await put(DEFAULT_PLUGINS, '*Other.esp\r\n');
    await put(SECONDARY_PLUGINS, '*Other.esp\r\n');

    await rename();

    expect((await snapshotTree(root)).has(`${MOD}/Renamed Patch.esp`)).toBe(true);
    expect(await text(DEFAULT_PLUGINS)).toBe('*Other.esp\r\n');
  });

  describe('a refusal changes nothing', () => {
    const refused = async (attempt: () => Promise<void>, reason: RegExp): Promise<void> => {
      const before = await snapshotTree(root);
      await expect(attempt()).rejects.toThrow(reason);
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    };

    it('refuses a plugin that is not in the origin', () =>
      refused(() => adapter.renamePlugin(ORIGIN, 'Missing.esp', 'Renamed Patch.esp'), /Missing\.esp/));

    it('refuses a name a file of the origin already has, in any case', async () => {
      await put(`${MOD}/RENAMED PATCH.esp`);
      await refused(() => rename(), /RENAMED PATCH\.esp/);
    });

    it('refuses a name a link to nothing already has', async () => {
      await symlink(join(root, 'nowhere.esp'), at(`${MOD}/Renamed Patch.esp`));
      await refused(() => rename(), /Renamed Patch\.esp/);
    });

    it('refuses a name that would put a file named for the plugin over another', async () => {
      await put(`${MOD}/Strings/renamed patch_en.strings`);
      await refused(() => rename(), /renamed patch_en\.strings/);
    });

    it('refuses a name a profile already lists for another plugin', async () => {
      await put(SECONDARY_PLUGINS, 'Patch Mod.esp\r\n*renamed patch.ESP\r\n');
      await refused(() => rename(), /renamed patch\.ESP/);
    });

    it('refuses two files that the rename would put on one name, which on a file system that tells case apart would overwrite one with the other', async () => {
      const twinIni = { name: 'patch mod.ini', isFile: true, isDirectory: false };
      vi.mocked(listEntries).mockImplementation(async (path, skippedLink) => [...await actualListEntries(path, skippedLink), ...(path === at(MOD) ? [twinIni] : [])]);
      await refused(() => rename().finally(() => vi.mocked(listEntries).mockImplementation(actualListEntries)), /is in the way/);
    });

    it.each(['a/b.esp', 'a\\b.esp', '..', ''])('refuses the name "%s", which is no file of the origin', (name) =>
      refused(() => rename(name), /not a valid/i));

  });

  describe('a failed write leaves every file under its old name', () => {
    it('puts back the files and the lines already written when a later line cannot be written', async () => {
      const before = await snapshotTree(root);
      vi.mocked(fsRename).mockImplementation((from, to) =>
        (String(to) === at(SECONDARY_PLUGINS) ? Promise.reject(new Error('disk full')) : actualRename(from, to)));

      await expect(rename()).rejects.toThrow('disk full');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('puts back the loadorder.txt already written when a later line cannot be written', async () => {
      await put(DEFAULT_LOAD_ORDER, 'Patch Mod.esp\r\n');
      await put(SECONDARY_LOAD_ORDER, 'Patch Mod.esp\r\n');
      const before = await snapshotTree(root);
      vi.mocked(fsRename).mockImplementation((from, to) =>
        (String(to) === at(SECONDARY_PLUGINS) ? Promise.reject(new Error('disk full')) : actualRename(from, to)));

      await expect(rename()).rejects.toThrow('disk full');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('puts back the files already renamed when a later file cannot be', async () => {
      const before = await snapshotTree(root);
      vi.mocked(fsRename).mockImplementation((from, to) =>
        (String(to) === at(`${MOD}/Strings/Renamed Patch_en.DLSTRINGS`) ? Promise.reject(new Error('in use')) : actualRename(from, to)));

      await expect(rename()).rejects.toThrow('in use');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });
  });
});
