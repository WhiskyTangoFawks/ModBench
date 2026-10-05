import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { Dirent, type PathLike } from 'node:fs';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({
  rename: undefined as typeof import('node:fs/promises').rename | undefined,
  listDir: undefined as typeof import('../files').listDir | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('../files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../files')>();
  real.listDir = actual.listDir;
  return { ...actual, listDir: vi.fn(actual.listDir) };
});
const actualListDir = (path: string): ReturnType<typeof listDir> => present(real.listDir, 'the real listDir')(path);
const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);

import { listDir } from '../files';
import type { FileOrigin, InstanceAdapter } from '../instanceAdapter';
import { mo2InstanceAdapter } from '../mo2Instance';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';

const MOD = 'mods/Tracked Patch Mod';
const ORIGIN: FileOrigin = { kind: 'mod', name: 'Tracked Patch Mod' };
const DEFAULT_PLUGINS = 'profiles/Default/plugins.txt';
const SECONDARY_PLUGINS = 'profiles/Secondary/plugins.txt';

const NAMED_FOR_IT: ReadonlyArray<readonly [before: string, after: string]> = [
  ['Tracked Patch Mod.esp', 'Renamed Patch.esp'],
  ['Tracked Patch Mod.ini', 'Renamed Patch.ini'],
  ['Tracked Patch Mod - Main.ba2', 'Renamed Patch - Main.ba2'],
  ['Tracked Patch Mod - Textures.ba2', 'Renamed Patch - Textures.ba2'],
  ['Strings/Tracked Patch Mod_en.STRINGS', 'Strings/Renamed Patch_en.STRINGS'],
  ['Strings/Tracked Patch Mod_en.DLSTRINGS', 'Strings/Renamed Patch_en.DLSTRINGS'],
].map(([before, after]) => [`${MOD}/${before}`, `${MOD}/${after}`] as const);

const NOT_NAMED_FOR_IT = [
  `${MOD}/Tracked Patch Mod_Extra.esp`,
  `${MOD}/Strings/Tracked Patch Mod_Extra_en.STRINGS`,
  `${MOD}/Strings/Tracked Patch Mod_xx.STRINGS`,
  `${MOD}/plugin-source/Tracked Patch Mod.esp/record.json`,
  `${MOD}/Other Archive - Main.ba2`,
];

describe('the MO2 Instance adapter renaming a plugin', () => {
  let root: string;
  let adapter: InstanceAdapter;
  const at = (relative: string): string => join(root, relative);
  const text = (relative: string): Promise<string> => readFile(at(relative), 'utf8');
  const rename = (to = 'Renamed Patch.esp'): Promise<void> =>
    adapter.renamePlugin(ORIGIN, 'Tracked Patch Mod.esp', to, 'Fallout4');

  async function put(relative: string, contents = relative): Promise<void> {
    await mkdir(join(at(relative), '..'), { recursive: true });
    await writeFile(at(relative), contents);
  }

  beforeEach(async () => {
    root = cloneCorpusFixture();
    adapter = mo2InstanceAdapter({
      instanceRoot: root,
      gameDirectoryOverrides: () => ({}),
      detectors: { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(null) },
    });
    for (const [before] of NAMED_FOR_IT.slice(1)) await put(before);
    for (const path of NOT_NAMED_FOR_IT) await put(path);
    await put(SECONDARY_PLUGINS, '*Unofficial Fallout 4 Patch.esp\r\nTracked Patch Mod.esp\r\n*Last.esp\r\n');
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(listDir).mockImplementation(actualListDir);
    await rm(root, { recursive: true, force: true });
  });

  it('renames the plugin, its strings, its archives and its ini, and its line in every profile that lists it, in the place and the enabled state it had', async () => {
    const before = await snapshotTree(root);

    await rename();

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set([...NAMED_FOR_IT.flat(), DEFAULT_PLUGINS, SECONDARY_PLUGINS]));
    for (const [from, to] of NAMED_FOR_IT) {
      expect(after.has(from), from).toBe(false);
      expect(after.get(to)?.toString(), to).toBe(before.get(from)?.toString());
    }
    expect(await adapter.pluginOrder('Default')).toEqual([
      { name: 'NonAsciiRetexture.esp', enabled: true },
      { name: 'Renamed Patch.esp', enabled: true },
      { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
      { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
    ]);
    expect(await text(SECONDARY_PLUGINS)).toBe('*Unofficial Fallout 4 Patch.esp\r\nRenamed Patch.esp\r\n*Last.esp\r\n');
    expect((await text(DEFAULT_PLUGINS)).startsWith('﻿')).toBe(true);
  });

  it('leaves the files of other plugins named alike, the plugin source and an archive of another name where they are', async () => {
    await rename();

    const after = await snapshotTree(root);
    for (const path of NOT_NAMED_FOR_IT) expect(after.has(path), path).toBe(true);
  });

  it('leaves an archive that belongs to a plugin whose name starts with this one, as the archive\'s name cut at its last " - " is that plugin\'s', async () => {
    await put(`${MOD}/Tracked Patch Mod - Bar.esp`);
    await put(`${MOD}/Tracked Patch Mod - Bar - Main.ba2`);

    await rename();

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/Tracked Patch Mod - Bar - Main.ba2`)).toBe(true);
    expect(after.has(`${MOD}/Renamed Patch - Bar - Main.ba2`)).toBe(false);
  });

  it('renames the files a release of another game names for a plugin, by that release\'s archive extension and language spellings', async () => {
    await put(`${MOD}/Tracked Patch Mod - Main.bsa`);
    await put(`${MOD}/Strings/Tracked Patch Mod_English.STRINGS`);

    await adapter.renamePlugin(ORIGIN, 'Tracked Patch Mod.esp', 'Renamed Patch.esp', 'SkyrimSE');

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/Renamed Patch - Main.bsa`)).toBe(true);
    expect(after.has(`${MOD}/Strings/Renamed Patch_English.STRINGS`)).toBe(true);
    expect(after.has(`${MOD}/Tracked Patch Mod - Main.ba2`)).toBe(true);
    expect(after.has(`${MOD}/Strings/Tracked Patch Mod_en.STRINGS`)).toBe(true);
  });

  it('renames a plugin whose name changes only its case, and its files and line with it', async () => {
    await rename('TRACKED PATCH MOD.esp');

    const after = await snapshotTree(root);
    expect(after.has(`${MOD}/TRACKED PATCH MOD.esp`)).toBe(true);
    expect(after.has(`${MOD}/TRACKED PATCH MOD - Main.ba2`)).toBe(true);
    expect((await adapter.pluginOrder('Default')).map((p) => p.name)).toContain('TRACKED PATCH MOD.esp');
  });

  it('renames a plugin of Overwrite, which holds files as a mod does', async () => {
    await put('overwrite/Run.esp');
    await put(DEFAULT_PLUGINS, '*Run.esp\r\n');

    await adapter.renamePlugin({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');

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
      refused(() => adapter.renamePlugin(ORIGIN, 'Missing.esp', 'Renamed Patch.esp', 'Fallout4'), /Missing\.esp/));

    it('refuses a name a file of the origin already has, in any case', async () => {
      await put(`${MOD}/RENAMED PATCH.esp`);
      await refused(() => rename(), /RENAMED PATCH\.esp/);
    });

    it('refuses a name that would put a file named for the plugin over another', async () => {
      await put(`${MOD}/Strings/renamed patch_en.strings`);
      await refused(() => rename(), /renamed patch_en\.strings/);
    });

    it('refuses a name a profile already lists for another plugin', async () => {
      await put(SECONDARY_PLUGINS, 'Tracked Patch Mod.esp\r\n*renamed patch.ESP\r\n');
      await refused(() => rename(), /renamed patch\.ESP/);
    });

    it('refuses two files that the rename would put on one name, which on a file system that tells case apart would overwrite one with the other', async () => {
      class TwinIni extends Dirent {
        override name = 'tracked patch mod.ini';
      }
      vi.mocked(listDir).mockImplementation(async (path) => [...await actualListDir(path), ...(path === at(MOD) ? [new TwinIni()] : [])]);
      await refused(() => rename().finally(() => vi.mocked(listDir).mockImplementation(actualListDir)), /is in the way/);
    });

    it.each(['a/b.esp', 'a\\b.esp', '..', ''])('refuses the name "%s", which is no file of the origin', (name) =>
      refused(() => rename(name), /not a valid/i));

    it('refuses a release the tables hold no row for, as it cannot say which files are named for the plugin', () =>
      refused(() => adapter.renamePlugin(ORIGIN, 'Tracked Patch Mod.esp', 'Renamed Patch.esp', undefined), /release/i));
  });

  describe('checking a rename before it is made', () => {
    const check = (to = 'Renamed Patch.esp', from = 'Tracked Patch Mod.esp'): Promise<void> =>
      adapter.checkPluginRename(ORIGIN, from, to, 'Fallout4');

    it('passes a rename that would be made, and changes nothing', async () => {
      const before = await snapshotTree(root);

      await expect(check()).resolves.toBeUndefined();

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it.each([
      ['a plugin that is not in the origin', () => check('Renamed Patch.esp', 'Missing.esp'), /Missing\.esp/],
      ['a name no file can have', () => check('a/b.esp'), /not a valid/i],
      ['a release the tables hold no row for', () => adapter.checkPluginRename(ORIGIN, 'Tracked Patch Mod.esp', 'Renamed Patch.esp', undefined), /release/i],
      ['a name a file of the origin already has', async () => {
        await put(`${MOD}/RENAMED PATCH.esp`);
        await check();
      }, /RENAMED PATCH\.esp/],
      ['a name a profile already lists for another plugin', async () => {
        await put(SECONDARY_PLUGINS, 'Tracked Patch Mod.esp\r\n*renamed patch.ESP\r\n');
        await check();
      }, /renamed patch\.ESP/],
    ])('refuses %s, as the rename would, and changes nothing', async (_name, attempt, reason) => {
      const before = await snapshotTree(root);

      await expect(attempt()).rejects.toThrow(reason);

      assertOnlyChanged(before, await snapshotTree(root), new Set([`${MOD}/RENAMED PATCH.esp`, SECONDARY_PLUGINS]));
    });
  });

  describe('a failed write leaves every file under its old name', () => {
    it('puts back the files and the lines already written when a later line cannot be written', async () => {
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
