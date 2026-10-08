import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename as fsRename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({
  rename: undefined as typeof import('node:fs/promises').rename | undefined,
  stat: undefined as typeof import('node:fs/promises').stat | undefined,
  readdir: undefined as typeof import('node:fs/promises').readdir | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  real.stat = actual.stat;
  real.readdir = actual.readdir;
  return { ...actual, rename: vi.fn(actual.rename), stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) };
});

const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);
const actualStat = present(real.stat, 'the real stat');
const actualReaddir = present(real.readdir, 'the real readdir');
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { isMo2Instance, mo2InstanceAdapter } from '../mo2Instance';
import { OVERWRITE_ORIGIN, type Subscription } from '../instanceAdapter';
import type { GameDetectors } from '../gameDirectory';
import type {
  GameFolder, InstanceAdapter, UpgradeExtraction, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange,
} from '../instanceAdapter';
import { tempWritePath } from '../layout';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS, snapshotTree,
} from '../../test/mo2/corpusFixture';

const NO_DETECTORS: GameDetectors = {
  paths: () => Promise.resolve(null),
  winePrefix: () => Promise.resolve(null),
};

const INI = 'ModOrganizer.ini';
const DOWNLOAD = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

const adapterAt = (
  instanceRoot: string, gameDirectory?: string, gameDirectoryChanged: (listener: () => void) => Subscription = () => ({ dispose: () => {} }),
): InstanceAdapter =>
  mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides: () => ({ gameDirectory }), gameDirectoryChanged, detectors: NO_DETECTORS });

const text = (root: string, relative: string): Promise<string> => readFile(join(root, relative), 'utf8');

const modNames = (order: readonly ModlistEntry[]): string[] => order.map((e) => `${e.kind}:${e.name}:${e.enabled}`);

async function isThere(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('the MO2 Instance adapter', () => {
  let root: string;
  let adapter: InstanceAdapter;

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = adapterAt(root);
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(stat).mockImplementation(actualStat);
    vi.mocked(readdir).mockImplementation(actualReaddir);
    await rm(root, { recursive: true, force: true });
  });

  describe('parsed reads', () => {
    it('answers the selected profile and the game from the settings', async () => {
      const settings = await adapter.settings();

      expect(settings.profile).toBe('Default');
      expect(settings.gameName).toBe('Fallout 4');
      expect(settings.gameRelease).toBe('Fallout4');
    });

    it('names MO2 and the file it keeps mod order in', () => {
      expect(adapter.names).toEqual({ manager: 'MO2', modOrderFile: 'modlist.txt', downloadMetadataFile: '.meta' });
    });

    it('answers no release for a game the tables hold none for, not one guessed from the name, which has the backend answer about another game', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Morrowind\r\nselected_profile=@ByteArray(Default)\r\n');

      const settings = await adapter.settings();

      expect(settings.gameName).toBe('Morrowind');
      expect(settings.gameRelease).toBeUndefined();
    });

    it('rejects when the settings name no selected profile', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\n');

      await expect(adapter.settings()).rejects.toThrow(/selected_profile/);
    });

    it('finds the game folder the setting names', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-game-'));
      try {
        await mkdir(join(game, 'Data'));

        const folder = await (await adapterAt(root, game).settings()).gameFolder();

        expect(folder).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('answers each place it looked when no game folder is found', async () => {
      const folder = await (await adapter.settings()).gameFolder();

      expect(folder.kind).toBe('notFound');
    });

    it('lists the downloaded files with their metadata parsed, and no metadata file as a file of its own', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await mkdir(join(root, 'downloads', 'a folder'));
      await writeFile(tempWritePath(join(root, 'downloads', 'manual.zip.meta')), 'half');

      const downloads = await (await adapter.settings()).downloadedFiles();

      if (downloads.kind !== 'listed') throw new Error(`expected listed, got ${downloads.reason}`);
      expect(downloads.downloadsDir).toBe(join(root, 'downloads'));
      const byName = new Map((downloads.files ?? []).map((file) => [file.name, file]));
      expect([...byName.keys()].sort()).toEqual([DOWNLOAD, 'manual.zip']);
      expect(byName.get(DOWNLOAD)?.meta).toMatchObject({ status: 'Installed', modID: '4598', excluded: false });
      expect(byName.get('manual.zip')?.meta).toBeUndefined();
      expect(byName.get('manual.zip')?.size).toBe(3);
      expect(byName.get('manual.zip')?.path).toBe(join(root, 'downloads', 'manual.zip'));
      expect(byName.get('manual.zip')?.metaPath).toBe(join(root, 'downloads', 'manual.zip.meta'));
    });

    it('answers metadata that is there but empty as metadata, so a file whose metadata is there to open does not show none', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await writeFile(join(root, 'downloads', 'manual.zip.meta'), '');

      const downloads = await (await adapter.settings()).downloadedFiles();

      if (downloads.kind !== 'listed') throw new Error(`expected listed, got ${downloads.reason}`);
      expect(downloads.files?.find((file) => file.name === 'manual.zip')?.meta).toMatchObject({ status: 'Downloaded' });
    });

    it('answers no files, rather than none, when the downloads folder is not there', async () => {
      await rm(join(root, 'downloads'), { recursive: true });

      expect(await (await adapter.settings()).downloadedFiles())
        .toEqual({ kind: 'listed', downloadsDir: join(root, 'downloads'), files: undefined });
    });

    it('answers where the downloads are from the same read the profile came from, so a rewrite between two answers does not land two generations in one value', async () => {
      const settings = await adapter.settings();
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n'
        + '[Settings]\r\ndownload_directory=@ByteArray(elsewhere)\r\n');

      const downloads = await settings.downloadedFiles();

      expect(downloads).toMatchObject({ kind: 'listed', downloadsDir: join(root, 'downloads') });
    });

    it('answers every profile, and no stray file beside them', async () => {
      await writeFile(join(root, 'profiles', 'stray.txt'), '');

      expect((await adapter.profiles()).sort()).toEqual(['Default', 'Secondary']);
    });

    it('answers no profiles when the instance has none', async () => {
      await rm(join(root, 'profiles'), { recursive: true });

      expect(await adapter.profiles()).toEqual([]);
    });

    it('answers the mods and separators in mod order, winning end first', async () => {
      const order = await adapter.modOrder('Default');

      expect(modNames(order).slice(0, 4)).toEqual([
        "mod:Ñoño's Retexture:true",
        'mod:Tracked Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
      ]);
    });

    it('answers the entry of a kind mod order lists, matched as MO2 matches names, or none, so a line another tool recased is not read as no entry', async () => {
      expect(await adapter.orderEntry('Default', { kind: 'mod', name: 'harder vats' })).toMatchObject({ kind: 'mod', name: 'Harder VATS' });
      expect(await adapter.orderEntry('Default', { kind: 'separator', name: ' unassigned (modlist development). ' }))
        .toMatchObject({ kind: 'separator', name: 'Unassigned (Modlist Development)' });
      expect(await adapter.orderEntry('Default', { kind: 'separator', name: 'Harder VATS' })).toBeUndefined();
    });

    it('rejects a profile with no mod order to read', async () => {
      await expect(adapter.modOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    it('answers a mod\'s meta', async () => {
      expect(await adapter.modMeta('Unofficial Fallout 4 Patch')).toMatchObject({
        version: '2.1.5.0',
        nexusId: '4598',
        archiveFilename: DOWNLOAD,
      });
    });

    it('answers an empty meta for a mod with none', async () => {
      expect(await adapter.modMeta('DragIn Manual Extract')).toEqual({});
    });

    it('rejects a meta that is there but cannot be read, not publishing an unreadable meta as an empty one', async () => {
      await mkdir(join(root, 'mods', 'DragIn Manual Extract', 'meta.ini'));

      await expect(adapter.modMeta('DragIn Manual Extract')).rejects.toThrow(/EISDIR/);
    });

    it('answers every mod folder as the entry it holds, with its path', async () => {
      const folders = (await adapter.modFolders())?.all;

      expect(folders).toContainEqual({
        kind: 'mod', name: 'Unofficial Fallout 4 Patch', path: join(root, 'mods', 'Unofficial Fallout 4 Patch'),
      });
      expect(folders).toContainEqual({
        kind: 'separator',
        name: 'Unassigned (Modlist Development)',
        path: join(root, 'mods', 'Unassigned (Modlist Development)_separator'),
      });
    });

    it('answers no entry for a folder named as the reserved overwrite folder, which mod sync would otherwise list as a mod', async () => {
      await mkdir(join(root, 'mods', 'Overwrite'));

      expect((await adapter.modFolders())?.all.map((f) => f.name)).not.toContain('Overwrite');
    });

    describe('a folder an install is extracting into', () => {
      const listed = async (): Promise<string[]> => present(await adapter.modFolders(), 'the mod folders').all.map((f) => f.name);

      it('is not listed while only its extraction is in it', async () => {
        await adapter.extractNewMod('New Mod');

        expect(await listed()).not.toContain('New Mod');
      });

      it('is listed once the extraction is gone', async () => {
        const extraction = await adapter.extractNewMod('New Mod');
        await rm(extraction.path, { recursive: true });

        expect(await listed()).toContain('New Mod');
      });

      it('is not listed mid-settle, with some of its entries moved up and its extraction still there', async () => {
        await adapter.extractNewMod('New Mod');
        await writeFile(join(root, 'mods', 'New Mod', 'readme.txt'), '');

        expect(await listed()).not.toContain('New Mod');
      });

      it('is listed when it is an installed mod being upgraded', async () => {
        await adapter.extractUpgrade('Harder VATS');

        expect(await listed()).toContain('Harder VATS');
      });

      it('is listed when an upgrade has cleared the mod\'s old contents and holds only its extraction', async () => {
        const extraction = await adapter.extractUpgrade('Harder VATS');
        const folder = join(root, 'mods', 'Harder VATS');
        const outsideTheExtraction = (await readdir(folder)).filter((entry) => join(folder, entry) !== extraction.path);
        await Promise.all(outsideTheExtraction.map((entry) => rm(join(folder, entry), { recursive: true })));

        expect(await listed()).toContain('Harder VATS');
      });
    });

    it('rejects when a mod folder cannot be read, rather than treating it as gone', async () => {
      const folder = join(root, 'mods', 'Harder VATS');
      vi.mocked(readdir).mockImplementation(async (path, options) => {
        if (String(path) === folder) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return actualReaddir(path, options);
      });

      await expect(adapter.modFolders()).rejects.toThrow(/permission denied/);
    });

    it('answers which mod folder holds an entry, matched as MO2 matches names, from the one listing', async () => {
      const folders = present(await adapter.modFolders(), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'harder vats' })?.path).toBe(join(root, 'mods', 'Harder VATS'));
      expect(folders.holding({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers each of two folders whose names differ only in case for the entry spelled as its own', async () => {
      await mkdir(join(root, 'mods', 'ModA'));
      await mkdir(join(root, 'mods', 'moda'));
      const folders = present(await adapter.modFolders(), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'moda' })?.path).toBe(join(root, 'mods', 'moda'));
      expect(folders.holding({ kind: 'mod', name: 'ModA' })?.path).toBe(join(root, 'mods', 'ModA'));
          });

    it('hands over a link it cannot follow rather than answering it as a folder', async () => {
      await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));
      const skipped: string[] = [];

      const folders = await adapter.modFolders((name) => skipped.push(name));

      expect(folders?.all.map((f) => f.name)).not.toContain('Loop');
      expect(skipped).toEqual(['Loop']);
    });

    it('answers undefined when there is no folder for mods at all', async () => {
      await rm(join(root, 'mods'), { recursive: true });

      expect(await adapter.modFolders()).toBeUndefined();
    });

    it('answers the plugins in plugin order, with their enabled state', async () => {
      expect(await adapter.pluginOrder('Default')).toEqual([
        { name: 'NonAsciiRetexture.esp', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: true },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
      ]);
    });

    it('rejects a profile with no plugin order to read', async () => {
      await expect(adapter.pluginOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    describe('the game folder\'s plugins', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-data-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (dataFolder: string): GameFolder => ({ kind: 'found', root: game, dataFolder });

      it('answers the plugin files at the Data folder\'s root, as the folder spells them', async () => {
        const data = join(game, 'Data');
        await mkdir(join(data, 'Nested.esp'), { recursive: true });
        await writeFile(join(data, 'Fallout4.ESM'), '');
        await writeFile(join(data, 'Patch.esp'), '');
        await writeFile(join(data, 'readme.txt'), '');

        const plugins = await adapter.gameFolderPlugins(found(data));

        expect(plugins).toEqual({ kind: 'listed', names: new Set(['Fallout4.ESM', 'Patch.esp']) });
      });

      it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers both of two files whose names differ only in case', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(data, 'Foo.esp'), '');
        await writeFile(join(data, 'foo.esp'), '');

        expect(await adapter.gameFolderPlugins(found(data))).toEqual({ kind: 'listed', names: new Set(['Foo.esp', 'foo.esp']) });
      });

      it('answers unresolved when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await adapter.gameFolderPlugins(notFound)).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when the Data folder cannot be listed', async () => {
        const plugins = await adapter.gameFolderPlugins(found(join(game, 'Missing')));

        if (plugins.kind !== 'unreadable') throw new Error(`expected unreadable, got ${plugins.kind}`);
        expect(plugins.reason).toMatch(/ENOENT/);
      });
    });

    describe('the game folder\'s Creation Club list, where Mod Management takes the Creation Club plugins from', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-ccc-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (): GameFolder => ({ kind: 'found', root: game, dataFolder: join(game, 'Data') });

      it('answers the plugins the release\'s list names, in its order', async () => {
        await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\r\nccBGSFO4001-PipBoy(Black).esl\r\n');

        expect(await adapter.creationClubList(found(), 'Fallout4'))
          .toEqual(['ccBGSFO4044-HellfirePowerArmor.esl', 'ccBGSFO4001-PipBoy(Black).esl']);
      });

      it('answers none when the game folder holds no list', async () => {
        expect(await adapter.creationClubList(found(), 'Fallout4')).toEqual([]);
      });

      it('answers none for a release with no Creation Club', async () => {
        await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\n');

        expect(await adapter.creationClubList(found(), 'Oblivion')).toEqual([]);
      });

      it('answers none when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await adapter.creationClubList(notFound, 'Fallout4')).toEqual([]);
      });
    });
  });

  describe('the watch', () => {
    afterEach(() => {
      watchers.length = 0;
    });

    const live = (): FakeWatcher[] => watchers.filter((w) => !w.disposed);

    const fire = (base: string, relative: string, heardAsByVsCodesMatcher = relative): boolean => {
      const watcher = live().find((w) => w.base === base && matchesGlob(heardAsByVsCodesMatcher, w.pattern));
      watcher?.fireChange(join(base, relative));
      return watcher !== undefined;
    };

    it('hears a file created, changed or deleted alike, so a deleted mod folder is heard', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });
      const mods = live().find((w) => w.base === root && matchesGlob('mods/A/x.esp', w.pattern));

      mods?.fireCreate(join(root, 'mods', 'A', 'x.esp'));
      mods?.fireChange(join(root, 'mods', 'A', 'x.esp'));
      mods?.fireDelete(join(root, 'mods', 'A'));

      expect(signals).toBe(3);
    });

    it('arms nothing until someone listens, and disarms when the last listener leaves', () => {
      const watched = adapterAt(root);
      expect(live()).toEqual([]);

      const first = watched.subscribe(() => undefined);
      const second = watched.subscribe(() => undefined);
      expect(live().length).toBeGreaterThan(0);

      first.dispose();
      expect(live().length).toBeGreaterThan(0);
      second.dispose();
      expect(live()).toEqual([]);
    });

    it('signals a change to the game-folder setting as it signals a file change, while anyone listens', () => {
      let setting: (() => void) | undefined;
      const adapter = adapterAt(root, undefined, (listener) => {
        setting = listener;
        return { dispose: () => { setting = undefined; } };
      });
      expect(setting).toBeUndefined();
      let signals = 0;
      const subscription = adapter.subscribe(() => { signals++; });

      setting?.();
      expect(signals).toBe(1);

      subscription.dispose();
      expect(setting).toBeUndefined();
    });

    it('signals a change to every profile\'s two order files, the settings, a mod\'s files and overwrite', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });

      const watchedPaths = [
        'profiles/Default/modlist.txt', 'profiles/Secondary/plugins.txt', 'ModOrganizer.ini',
        'mods/Harder VATS/Textures/a.dds', 'overwrite/F4SE/Plugins/x.ini',
      ];
      const pathsHeardByNoWatcher = watchedPaths.filter((relative) => !fire(root, relative));
      expect(pathsHeardByNoWatcher).toEqual([]);
      expect(fire(root, 'profiles/Default/other.txt')).toBe(false);
      expect(signals).toBe(5);
    });

    it.each(['HEAD', 'refs/heads/main', 'packed-refs', ''])(
      'hears .git/%s in a mod\'s git repository', (inside) => {
        let signals = 0;
        adapterAt(root).subscribe(() => { signals++; });

        expect(fire(root, join('mods/Harder VATS/.git', inside), join('mods/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(1);
      });

    it('tells a ref from git\'s bookkeeping in a Windows path', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });
      const mods = live().find((w) => w.base === root && matchesGlob('mods/A/x.esp', w.pattern));

      mods?.fireChange('C:\\MO2\\mods\\Harder VATS\\.git\\index');
      mods?.fireChange('C:\\MO2\\mods\\Harder VATS\\.git\\refs\\heads\\main');

      expect(signals).toBe(1);
    });

    it.each(['index', 'objects/ab/cdef', 'logs/HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'HEAD.lock'])(
      'hears nothing of .git/%s in a mod\'s git repository, git\'s own bookkeeping not reading as a change', (inside) => {
        let signals = 0;
        adapterAt(root).subscribe(() => { signals++; });

        expect(fire(root, join('mods/Harder VATS/.git', inside), join('mods/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(0);
      });

    it('follows the downloads folder the last read of the settings resolved, signalling once when it moves, not the one where the instance began, so a download landing in the folder the settings name now is heard', async () => {
      let signals = 0;
      const watched = adapterAt(root);
      watched.subscribe(() => { signals++; });
      await (await watched.settings()).downloadedFiles();
      expect(fire(join(root, 'downloads'), 'new.7z')).toBe(true);
      signals = 0;

      await writeFile(join(root, INI), `${await text(root, INI)}download_directory=@ByteArray(Elsewhere)\r\n`);
      await (await watched.settings()).downloadedFiles();
      expect(signals).toBe(1);
      await (await watched.settings()).downloadedFiles();
      expect(signals).toBe(1);

      expect(fire(join(root, 'downloads'), 'old.7z')).toBe(false);
      expect(fire(join(root, 'Elsewhere'), 'new.7z')).toBe(true);
    });

    it('follows the plugins at the root of the game folder\'s Data folder, in any case, as another tool may write a plugin\'s extension in capitals', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-game-'));
      try {
        await mkdir(join(game, 'Data'));
          const watched = adapterAt(root, game);
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        const pluginsHeardByNoWatcher = ['Fallout4.esm', 'Patch.ESP', 'cc.Esl'].filter((name) => !fire(join(game, 'Data'), name));
        expect(pluginsHeardByNoWatcher).toEqual([]);
        expect(fire(join(game, 'Data'), 'readme.txt')).toBe(false);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('follows the release\'s Creation Club list at the game folder\'s root, so a changed list does not wait for the next focus', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-ccc-'));
      try {
        await mkdir(join(game, 'Data'));
        const watched = adapterAt(root, game);
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        expect(fire(game, 'Fallout4.ccc')).toBe(true);
        expect(fire(game, 'Fallout4.ini')).toBe(false);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('follows no game folder when none is found', async () => {
      const watched = adapterAt(root);
      watched.subscribe(() => undefined);
      const before = live().length;

      await (await watched.settings()).gameFolder();

      expect(live()).toHaveLength(before);
    });
  });

  describe('get in mods/', () => {
    it('answers the folder that holds an entry, matched as MO2 matches names, or none', async () => {
      const harderVats = { kind: 'mod', name: 'Harder VATS', path: join(root, 'mods', 'Harder VATS') };

      expect(await adapter.entryFolder({ kind: 'mod', name: 'Harder VATS' })).toEqual(harderVats);
      expect(await adapter.entryFolder({ kind: 'mod', name: 'harder vats' })).toEqual(harderVats);
      expect(await adapter.entryFolder({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
      expect(await adapter.entryFolder({ kind: 'separator', name: 'Harder VATS' })).toBeUndefined();
    });

    it('answers a mod named as a separator\'s folder with that separator\'s folder, MO2 knowing a mod by its folder\'s name and a folder named for a separator holding that separator', async () => {
      expect(await adapter.entryFolder({ kind: 'mod', name: 'unassigned (modlist development)_SEPARATOR' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    it('finds a separator\'s folder by the name MO2 would give it, so a name asked for loosely finds it too', async () => {
      expect(await adapter.entryFolder({ kind: 'separator', name: '  unassigned  (Modlist Development)..' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    describe('an origin\'s files', () => {
      const mod = (name: string) => ({ kind: 'mod' as const, name });
      const relativePaths = (files: readonly { relativePath: string }[]): string[] => files.map((f) => f.relativePath).sort();

      it('walks a mod\'s folder, leaving out its metadata, its root plugin source tree, dot entries and writes in flight', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Textures', 'Source'), { recursive: true });
        await writeFile(join(folder, 'Textures', 'a.dds'), '');
        await writeFile(join(folder, 'Textures', 'Source', 'kept.psc'), '');
        await mkdir(join(folder, 'plugin-source'), { recursive: true });
        await writeFile(join(folder, 'plugin-source', 'left.json'), '');
        await mkdir(join(folder, '.git'), { recursive: true });
        await writeFile(join(folder, '.git', 'HEAD'), '');
        await writeFile(tempWritePath(join(folder, 'Textures', 'b.dds')), '');

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.origin).toBe('Harder VATS');
        expect(files.folder).toBe(folder);
        expect(relativePaths(files.files)).toEqual(['Textures/Source/kept.psc', 'Textures/a.dds']);
        expect(files.files.find((f) => f.relativePath === 'Textures/a.dds'))
          .toMatchObject({ path: join(folder, 'Textures', 'a.dds'), sourcePath: join(folder, 'Textures', 'a.dds') });
        expect(files.folders).toEqual([
          { relativePath: 'Textures', path: join(folder, 'Textures'), excluded: false },
          { relativePath: 'Textures/Source', path: join(folder, 'Textures', 'Source'), excluded: false },
        ]);
      });

      it('reads a linked file from where the link points, and places it where the link sits, and notes a broken link rather than failing', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(folder, 'Linked.esp'));
        await symlink(join(root, 'nowhere.esp'), join(folder, 'Broken.esp'));

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'Linked.esp'))
          .toEqual({ relativePath: 'Linked.esp', path: join(folder, 'Linked.esp'), sourcePath: await realpath(target), excluded: false, excludedByName: false });
        expect(relativePaths(files.files)).not.toContain('Broken.esp');
        expect(files.notes.join('\n')).toMatch(/Broken\.esp/);
      });

      it('leaves out a dot file, and a dot folder below the root, and keeps what sits beside them', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await writeFile(join(folder, '.gitignore'), '*\n');
        await mkdir(join(folder, 'Textures', '.thumbs'), { recursive: true });
        await writeFile(join(folder, 'Textures', '.thumbs', 'cache.bin'), '');
        await writeFile(join(folder, 'Textures', 'a.dds'), '');

        const paths = relativePaths((await adapter.originFiles(mod('Harder VATS'))).files);

        expect(paths).toContain('Textures/a.dds');
        expect(paths.filter((path) => path.split('/').some((segment) => segment.startsWith('.')))).toEqual([]);
      });

      it('leaves out a root plugin-source folder in any case, and keeps a root folder whose name only starts with plugin-source', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'PLUGIN-SOURCE'), { recursive: true });
        await writeFile(join(folder, 'PLUGIN-SOURCE', 'stray.json'), '');
        await mkdir(join(folder, 'plugin-sourceish'), { recursive: true });
        await writeFile(join(folder, 'plugin-sourceish', 'note.txt'), '');

        const paths = relativePaths((await adapter.originFiles(mod('Harder VATS'))).files);

        expect(paths).toContain('plugin-sourceish/note.txt');
        expect(paths).not.toContain('PLUGIN-SOURCE/stray.json');
      });

      it('keeps a root Source folder: it is ordinary content, not the plugin source root, as Skyrim SE\'s Creation Kit ships script sources at a release\'s own root Source/', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Source'), { recursive: true });
        await writeFile(join(folder, 'Source', 'Script.psc'), '');

        const paths = relativePaths((await adapter.originFiles(mod('Harder VATS'))).files);

        expect(paths).toContain('Source/Script.psc');
      });

      it.each([
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
        ['Overwrite', { kind: 'runtimeOutput' as const }, 'overwrite'],
      ])('says which files and folders of %s are excluded: a name with the suffix in any case, and everything in such a folder', async (_, origin, folder) => {
        await mkdir(join(root, folder, 'Textures.mohidden', 'Armour'), { recursive: true });
        await writeFile(join(root, folder, 'Textures.mohidden', 'Armour', 'a.dds'), '');
        await writeFile(join(root, folder, 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, folder, 'Kept.esp'), '');

        const files = await adapter.originFiles(origin);
        const excludedOf = (entries: readonly { relativePath: string; excluded: boolean }[], relativePath: string) =>
          entries.find((entry) => entry.relativePath === relativePath)?.excluded;

        expect(['Textures.mohidden/Armour/a.dds', 'Hidden.esp.MOHIDDEN', 'Kept.esp'].map((path) => excludedOf(files.files, path)))
          .toEqual([true, true, false]);
        expect(['Textures.mohidden', 'Textures.mohidden/Armour'].map((path) => excludedOf(files.folders, path))).toEqual([true, true]);
      });

      it('says which files are excluded by their own name, apart from their folder', async () => {
        await mkdir(join(root, 'mods', 'Harder VATS', 'Textures.mohidden'), { recursive: true });
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'b.dds.mohidden'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Kept.esp'), '');

        const { files } = await adapter.originFiles(mod('Harder VATS'));
        const byNameOf = (relativePath: string) => files.find((file) => file.relativePath === relativePath)?.excludedByName;

        expect(['Textures.mohidden/a.dds', 'Textures.mohidden/b.dds.mohidden', 'Hidden.esp.MOHIDDEN', 'Kept.esp'].map(byNameOf))
          .toEqual([false, true, true, false]);
      });

      it('follows a linked folder, its files keyed beneath the link\'s own name', async () => {
        const shared = join(root, 'shared-textures');
        await mkdir(shared);
        await writeFile(join(shared, 'foo.dds'), '');
        await symlink(shared, join(root, 'mods', 'Harder VATS', 'linked'));

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'linked/foo.dds')?.path).toBe(join(root, 'mods', 'Harder VATS', 'linked', 'foo.dds'));
        expect(files.folders).toContainEqual({ relativePath: 'linked', path: join(root, 'mods', 'Harder VATS', 'linked'), excluded: false });
      });

      it('notes a link cycle and walks each file once', async () => {
        const folder = join(root, 'mods', 'Cycle');
        await mkdir(folder);
        await writeFile(join(folder, 'sibling.dds'), '');
        await symlink(folder, join(folder, 'loop'));

        const files = await adapter.originFiles(mod('Cycle'));

        expect(relativePaths(files.files)).toEqual(['sibling.dds']);
        expect(files.notes.join('\n')).toMatch(/cycle.*loop/);
      });

      it('rejects when a link\'s target cannot be checked for a reason other than its absence, simulated through a mocked stat as chmod denies nothing when the runner is root', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await symlink(join(root, 'whatever.dds'), join(folder, 'restricted.dds'));
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('restricted.dds')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualStat(path, ...rest);
        });

        await expect(adapter.originFiles(mod('Harder VATS'))).rejects.toThrow(/permission denied/);
      });

      it.skipIf(process.platform === 'win32')('notes a FIFO and a link to one, and answers neither as a file, built with the POSIX mkfifo that Windows lacks', async () => {
        const folder = join(root, 'mods', 'Pipes');
        await mkdir(folder);
        execFileSync('mkfifo', [join(folder, 'pipe')]);
        execFileSync('mkfifo', [join(root, 'real-pipe')]);
        await symlink(join(root, 'real-pipe'), join(folder, 'linked-pipe'));

        const files = await adapter.originFiles(mod('Pipes'));

        expect(files.files).toEqual([]);
        expect(files.notes.join('\n')).toMatch(/pipe/);
        expect(files.notes.join('\n')).toMatch(/linked-pipe/);
        expect(files.notes).toHaveLength(2);
      });

      it('answers no files for a mod with no folder, or a name that gives it none', async () => {
        expect((await adapter.originFiles(mod('No Such Mod'))).files).toEqual([]);
        expect(await adapter.originFiles(mod('../profiles'))).toEqual({ origin: '../profiles', folder: undefined, files: [], folders: [], notes: [] });
      });

      it('lists everything the game wrote at run time, under the reserved origin, without writes in flight', async () => {
        const folder = join(root, 'overwrite');
        await writeFile(join(folder, 'Stray.esp'), '');
        await writeFile(tempWritePath(join(folder, 'Stray.esp')), '');

        const files = await adapter.originFiles({ kind: 'runtimeOutput' });

        expect(files.origin).toBe(OVERWRITE_ORIGIN);
        expect(files.folder).toBe(folder);
        expect(relativePaths(files.files)).toContain('Stray.esp');
        expect(relativePaths(files.files).some((path) => path.startsWith('F4SE/'))).toBe(true);
        expect(files.files.every((f) => !f.relativePath.endsWith('.tmp'))).toBe(true);
        expect(files.folders).toContainEqual({ relativePath: 'F4SE', path: join(folder, 'F4SE'), excluded: false });
      });

      it.each([
        ['the overwrite folder', { kind: 'runtimeOutput' as const }, 'overwrite', 'F4SE/Plugins/SomePlugin.log'],
        ['a mod\'s folder', mod('Harder VATS'), join('mods', 'Harder VATS'), 'Kept.esp'],
      ])('skips a subfolder of %s removed mid-walk, and notes it, not reading the origin as empty through one catch around the whole walk', async (_, origin, folder, kept) => {
        await writeFile(join(root, folder, 'Kept.esp'), '');
        await mkdir(join(root, folder, 'Gone'));
        await writeFile(join(root, folder, 'Gone', 'Lost.esp'), '');
        vi.mocked(readdir).mockImplementation(async (path, options) => {
          if (String(path) === join(root, folder, 'Gone')) await rm(path, { recursive: true });
          return actualReaddir(path, options);
        });

        const files = await adapter.originFiles(origin);

        expect(relativePaths(files.files)).toContain(kept);
        expect(relativePaths(files.files)).not.toContain('Gone/Lost.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Gone/)]);
      });

      it('notes a link in the overwrite folder, which it does not follow, rather than skipping it with no word and dropping its file from the picture', async () => {
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(root, 'overwrite', 'Linked.esp'));

        const files = await adapter.originFiles({ kind: 'runtimeOutput' });

        expect(relativePaths(files.files)).not.toContain('Linked.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Linked\.esp/)]);
      });

      it('answers no files when there is no overwrite folder', async () => {
        await rm(join(root, 'overwrite'), { recursive: true });

        expect((await adapter.originFiles({ kind: 'runtimeOutput' })).files).toEqual([]);
      });
    });

    describe('a mod\'s repository', () => {
      it('answers tracked for a mod whose folder holds a `.git`, tracked being its presence there, and not for a mod whose folder holds none', async () => {
        await mkdir(join(root, 'mods', 'Harder VATS', '.git'));

        expect([await adapter.modTracked('Harder VATS'), await adapter.modTracked('Unofficial Fallout 4 Patch')]).toEqual([true, false]);
      });
    });
  });

  describe('put and rename in mods/', () => {
    it('creates a mod\'s folder, and refuses a name that escapes the mod folders', async () => {
      await adapter.createModFolder('Brand New');

      expect(await isThere(join(root, 'mods', 'Brand New'))).toBe(true);
      await expect(adapter.createModFolder('../escape')).rejects.toThrow(/Not a valid mod name/);
    });

    it.each([
      ['a mod\'s, in another case', 'harder vats', 'Harder VATS'],
      ['a separator\'s, whose name it decodes to', 'unassigned (modlist development)_SEPARATOR', 'Unassigned (Modlist Development)_separator'],
    ])('refuses a folder already there as %s, naming it, never adopting another mod\'s folder or a separator\'s in silence', async (_, mod, folder) => {
      const before = await snapshotTree(root);

      await expect(adapter.createModFolder(mod)).rejects.toThrow(`The folder "${join(root, 'mods', folder)}" is in the way`);

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('renames a mod\'s folder, keeping what is in it, and takes a case-only rename', async () => {
      await adapter.renameModFolder('harder vats', 'Harder VATS 2');
      await adapter.renameModFolder('Harder VATS 2', 'HARDER VATS 2');

      expect(await isThere(join(root, 'mods', 'Harder VATS'))).toBe(false);
      expect(await isThere(join(root, 'mods', 'HARDER VATS 2', 'meta.ini'))).toBe(true);
    });

    it('refuses to rename a folder that is not there', async () => {
      await expect(adapter.renameModFolder('No Such Mod', 'Anything')).rejects.toThrow(/No Such Mod/);
    });

    it('refuses a rename onto a folder already there, in any case, and moves nothing', async () => {
      const before = await snapshotTree(root);

      await expect(adapter.renameModFolder('Harder VATS', 'unofficial fallout 4 patch'))
        .rejects.toThrow(`The folder "${join(root, 'mods', 'Unofficial Fallout 4 Patch')}" is in the way`);

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('moves the folder that holds a mod or a separator to the trash, and answers false when none does', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      };

      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'harder vats' }, trash)).toBe(true);
      expect(await adapter.trashEntryFolder({ kind: 'separator', name: 'Unassigned (Modlist Development)' }, trash)).toBe(true);
      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'No Such Mod' }, trash)).toBe(false);

      expect(trashed).toEqual([
        join(root, 'mods', 'Harder VATS'), join(root, 'mods', 'Unassigned (Modlist Development)_separator'),
      ]);
    });
  });

  describe('excluding and including a file of a mod or Overwrite', () => {
    const modOrigin = { kind: 'mod' as const, name: 'Harder VATS' };
    const overwrite = { kind: 'runtimeOutput' as const };
    const put = async (path: string, content = ''): Promise<void> => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    };

    it.each([
      ['a mod\'s', modOrigin, join('mods', 'Harder VATS')],
      ['Overwrite\'s', overwrite, 'overwrite'],
    ])('renames %s file with the suffix, and back', async (_, origin, folder) => {
      await put(join(root, folder, 'Textures', 'a.dds'), 'pixels');

      expect(await adapter.markOriginFile(origin, 'Textures/a.dds', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'Textures/a.dds.mohidden' });
      expect(await isThere(join(root, folder, 'Textures', 'a.dds'))).toBe(false);
      expect(await text(root, join(folder, 'Textures', 'a.dds.mohidden'))).toBe('pixels');

      expect(await adapter.markOriginFile(origin, 'Textures/a.dds.mohidden', 'Included')).toEqual({ gone: false, wrote: true, relativePath: 'Textures/a.dds' });
      expect(await text(root, join(folder, 'Textures', 'a.dds'))).toBe('pixels');
      expect(await isThere(join(root, folder, 'Textures', 'a.dds.mohidden'))).toBe(false);
    });

    it('renames a folder, which excludes everything in it', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds'));

      expect(await adapter.markOriginFile(modOrigin, 'Textures', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'Textures.mohidden' });

      expect(await isThere(join(root, 'mods', 'Harder VATS', 'Textures'))).toBe(false);
      expect(await isThere(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'))).toBe(true);
    });

    it('refuses to include a file with no suffix of its own that its folder excludes, changing nothing', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'));
      const before = await snapshotTree(root);

      expect(await adapter.markOriginFile(modOrigin, 'Textures.mohidden/a.dds', 'Included')).toEqual({
        gone: false, refusal: '"Textures.mohidden/a.dds" has no suffix of its own to remove, and its folder excludes it.',
      });

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('includes a file with its own suffix inside an excluded folder, removing its own suffix alone', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds.mohidden'), 'pixels');

      expect(await adapter.markOriginFile(modOrigin, 'Textures.mohidden/a.dds.mohidden', 'Included')).toEqual({ gone: false, wrote: true, relativePath: 'Textures.mohidden/a.dds' });

      expect(await text(root, join('mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'))).toBe('pixels');
    });

    it('excludes a file inside an excluded folder by its own name', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'), 'pixels');

      expect(await adapter.markOriginFile(modOrigin, 'Textures.mohidden/a.dds', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'Textures.mohidden/a.dds.mohidden' });

      expect(await text(root, join('mods', 'Harder VATS', 'Textures.mohidden', 'a.dds.mohidden'))).toBe('pixels');
    });

    it('includes a file whose suffix is in capitals', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'a.dds.MOHIDDEN'), 'pixels');

      expect(await adapter.markOriginFile(modOrigin, 'a.dds.MOHIDDEN', 'Included')).toEqual({ gone: false, wrote: true, relativePath: 'a.dds' });

      expect(await text(root, join('mods', 'Harder VATS', 'a.dds'))).toBe('pixels');
    });

    it('leaves a file already as asked, and reads the suffix without case', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'a.dds.MOHIDDEN'));
      await put(join(root, 'mods', 'Harder VATS', 'b.dds'));
      const before = await snapshotTree(root);

      expect(await adapter.markOriginFile(modOrigin, 'a.dds.MOHIDDEN', 'Excluded')).toEqual({ gone: false, wrote: false, relativePath: 'a.dds.MOHIDDEN' });
      expect(await adapter.markOriginFile(modOrigin, 'b.dds', 'Included')).toEqual({ gone: false, wrote: false, relativePath: 'b.dds' });

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('answers gone for a file that is not there', async () => {
      expect(await adapter.markOriginFile(modOrigin, 'Missing.esp', 'Excluded')).toEqual({ gone: true });
    });

    it.each([
      ['Excluded', 'a.dds', 'a.dds.mohidden'],
      ['Included', 'a.dds.mohidden', 'a.dds'],
    ] as const)('refuses, and changes nothing, when %s would replace a file already at the new name', async (mark, from, to) => {
      const folder = join(root, 'mods', 'Harder VATS');
      await put(join(folder, from), 'mine');
      await put(join(folder, to), 'theirs');
      const before = await snapshotTree(root);

      expect(await adapter.markOriginFile(modOrigin, from, mark)).toEqual({ gone: false, refusal: `"${to}" is already there.` });

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('takes a mod named overwrite for a mod, never for Overwrite', async () => {
      await put(join(root, 'mods', 'overwrite', 'a.esp'));
      await put(join(root, 'overwrite', 'a.esp'));

      expect(await adapter.markOriginFile({ kind: 'mod', name: 'overwrite' }, 'a.esp', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'a.esp.mohidden' });

      expect(await isThere(join(root, 'mods', 'overwrite', 'a.esp.mohidden'))).toBe(true);
      expect(await isThere(join(root, 'overwrite', 'a.esp'))).toBe(true);
    });

    it.each(['../outside.txt', 'a/../../outside.txt', '/etc/hosts', '', 'a\\..\\..\\outside.txt'])('refuses the path "%s", which leaves the origin\'s folder, changing nothing', async (path) => {
      const before = await snapshotTree(root);

      await expect(adapter.markOriginFile(modOrigin, path, 'Excluded')).rejects.toThrow(/Not a file of/);

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('refuses a mod that has no folder', async () => {
      await expect(adapter.markOriginFile({ kind: 'mod', name: '../profiles' }, 'a.esp', 'Excluded')).rejects.toThrow(/Not a file of/);
    });
  });

  describe('changes to mod order', () => {
    const change = (changes: readonly ModOrderChange[]) =>
      adapter.changeModOrder('Default', () => changes);
    const separatorFolder = (name: string): string => join(root, 'mods', `${name}_separator`);

    it('hands the decision the order and the mod folders as they stand, and which folder holds an entry', async () => {
      const seen: string[][] = [];
      let folders: readonly ModFolder[] | undefined;
      let holding: ModFolder | undefined;

      await adapter.changeModOrder('Default', (order, found) => {
        seen.push(modNames(order));
        folders = found?.all;
        holding = found?.holding({ kind: 'mod', name: 'harder vats' });
        return [];
      });

      expect(seen).toEqual([modNames(await adapter.modOrder('Default'))]);
      expect(folders).toEqual((await adapter.modFolders())?.all);
      expect(holding?.path).toBe(join(root, 'mods', 'Harder VATS'));
    });

    it('lands every change in one write of mod order alone', async () => {
      const before = await snapshotTree(root);

      const written = await change([
        { kind: 'enable', mod: 'Harder VATS', enabled: true },
        { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'New Mod' } },
        { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'Orphan' } },
        { kind: 'dropMod', mod: 'ENBoost - 12k' },
        { kind: 'dropSeparator', separator: 'Radfall - All-In-One Survival Overhaul' },
      ]);

      expect(written).toEqual({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_MODLIST]));
      expect(modNames(await adapter.modOrder('Default'))).toEqual([
        'separator:Orphan:false',
        'mod:New Mod:false',
        "mod:Ñoño's Retexture:true",
        'mod:Tracked Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'mod:Harder VATS:true',
        'mod:Cracked and Smudged Pip-Boy Screen:true',
      ]);
    });

    it('moves mods and separators to a place in mod order', async () => {
      await change([
        { kind: 'moveMods', mods: ['Harder VATS'], place: { kind: 'modOrder' }, end: 'winning' },
        {
          kind: 'moveSeparators',
          separators: ['Radfall - All-In-One Survival Overhaul'],
          place: { kind: 'modOrder' },
          end: 'winning',
        },
      ]);

      expect(modNames(await adapter.modOrder('Default')).slice(0, 3)).toEqual([
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'separator:Radfall - All-In-One Survival Overhaul:false',
      ]);
      expect(modNames(await adapter.modOrder('Default'))).toContain('mod:Harder VATS:false');
    });

    it('adds a separator with its folder', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', afterIndex: -1 }]);

      expect(modNames(await adapter.modOrder('Default'))[0]).toBe('separator:New Separator:true');
      expect(await isThere(separatorFolder('New Separator'))).toBe(true);
    });

    it('renames a separator\'s line and its folder as one change', async () => {
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames(await adapter.modOrder('Default'))).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(false);
    });

    it('renames a mod\'s line in place, keeping its state, and nothing else', async () => {
      const before = await snapshotTree(root);
      const order = modNames(await adapter.modOrder('Default'));

      expect(await change([{ kind: 'renameMod', from: 'harder vats', to: 'Harder VATS 2' }])).toEqual({ wrote: true });

      expect(modNames(await adapter.modOrder('Default'))).toEqual(order.map((n) => n.replace('mod:Harder VATS:', 'mod:Harder VATS 2:')));
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_MODLIST]));
    });

    it('writes nothing for a rename of a mod the profile does not list', async () => {
      expect(await change([{ kind: 'renameMod', from: 'No Such Mod', to: 'Anything' }])).toEqual({ wrote: false });
    });

    it('refuses a rename onto a name another listed mod has, in any case', async () => {
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'renameMod', from: 'Harder VATS', to: 'unofficial fallout 4 patch' }])).rejects.toThrow();

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    it('writes nothing when the changes are already true of mod order', async () => {
      const before = await text(root, DEFAULT_MODLIST);
      const mtime = (await stat(join(root, DEFAULT_MODLIST))).mtimeMs;

      expect(await change([{ kind: 'enable', mod: 'Tracked Patch Mod', enabled: true }])).toEqual({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect((await stat(join(root, DEFAULT_MODLIST))).mtimeMs).toBe(mtime);
    });

    it.each<[string, ModOrderChange]>([
      ['enable', { kind: 'enable', mod: 'No Such Mod', enabled: true }],
      ['moveMods', { kind: 'moveMods', mods: ['No Such Mod'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['moveSeparators', { kind: 'moveSeparators', separators: ['No Such Sep'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['renameSeparator', { kind: 'renameSeparator', from: 'No Such Sep', to: 'Anything' }],
      ['addSeparator a listed separator', { kind: 'addSeparator', separator: 'Unassigned (Modlist Development)', afterIndex: 0 }],
      ['renameSeparator onto a listed separator', {
        kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Radfall - All-In-One Survival Overhaul',
      }],
    ])('rejects %s naming an entry that is not there, or adding a separator that is, and writes nothing, not leaving the text as it was and dropping the change in silence', async (_, bad) => {
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'enable', mod: 'Harder VATS', enabled: true }, bad])).rejects.toThrow(/modlist/);

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    it.each<[string, ModOrderChange]>([
      ['adding a mod listed in another case', { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'HARDER VATS' } }],
      ['adding a separator listed in another case', { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'radfall - all-in-one survival overhaul' } }],
      ['dropping a mod not listed', { kind: 'dropMod', mod: 'No Such Mod' }],
      ['dropping a separator not listed', { kind: 'dropSeparator', separator: 'No Such Sep' }],
    ])('writes nothing for %s, and says so, the entry already being as the change would leave it, so a gesture that raced mod sync to the same line does not fail', async (_, already) => {
      const before = await text(root, DEFAULT_MODLIST);

      expect(await change([already])).toEqual({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    it('decides each change from the order the change before it left, not an order read before queueing behind one in flight', async () => {
      const seenBySecond: string[][] = [];

      await Promise.all([
        change([{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'First' } }]),
        adapter.changeModOrder('Default', (order) => {
          seenBySecond.push(order.map((e) => e.name));
          return [];
        }),
      ]);

      expect(seenBySecond[0]).toContain('First');
    });

    describe('a failed change writes nothing', () => {
      const modlist = (): string => join(root, DEFAULT_MODLIST);

      it('leaves line and folder as they were when the folder cannot be renamed, the line not written before the folder moves', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(join(separatorFolder('Core Mods'), 'occupied'), { recursive: true });

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow();

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
      });

      it('refuses a rename onto a folder already there, listed or not, before anything moves, as on Linux a rename onto an empty folder would replace it in silence where Windows refuses', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(separatorFolder('Core Mods'));

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow(`The folder "${separatorFolder('Core Mods')}" is in the way`);

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
        expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      });

      it('refuses a rename onto a folder that holds the name in another case', async () => {
        await mkdir(separatorFolder('core mods'));

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow(/is in the way/);

        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
      });

      it('refuses adding a separator whose folder is already there, not adopting it as its own and taking it away as one it made if the line cannot be written', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(separatorFolder('Orphan'));
        await writeFile(join(separatorFolder('Orphan'), 'kept.txt'), '');

        await expect(change([{ kind: 'addSeparator', separator: 'Orphan', afterIndex: -1 }])).rejects.toThrow(/is in the way/);

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(join(separatorFolder('Orphan'), 'kept.txt'))).toBe(true);
      });

      it('puts the folder back when the renamed line cannot be written, not leaving the folder renamed alone', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await chmod(modlist(), 0o444);
        try {
          await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
            .rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
        expect(await isThere(separatorFolder('Core Mods'))).toBe(false);
      });

      it('takes a new separator\'s folder away when its line cannot be written', async () => {
        await chmod(modlist(), 0o444);
        try {
          await expect(change([{ kind: 'addSeparator', separator: 'New Separator', afterIndex: -1 }])).rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await isThere(separatorFolder('New Separator'))).toBe(false);
      });

      it('puts every folder back newest first, so a separator added and then renamed in one change leaves no first folder behind', async () => {
        await chmod(modlist(), 0o444);
        try {
          await expect(change([
            { kind: 'addSeparator', separator: 'Brief', afterIndex: -1 },
            { kind: 'renameSeparator', from: 'Brief', to: 'Briefer' },
          ])).rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await isThere(separatorFolder('Brief'))).toBe(false);
        expect(await isThere(separatorFolder('Briefer'))).toBe(false);
      });

      it('tries every put-back when one fails, and names each failure, so an older move is still put back', async () => {
        await mkdir(separatorFolder('Radfall - All-In-One Survival Overhaul'));
        const blocked = separatorFolder('Second');
        vi.mocked(fsRename).mockImplementation((from, to) =>
          (from === blocked ? Promise.reject(new Error('put-back blocked')) : actualRename(from, to)));
        await chmod(modlist(), 0o444);
        try {
          await expect(change([
            { kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'First' },
            { kind: 'renameSeparator', from: 'Radfall - All-In-One Survival Overhaul', to: 'Second' },
          ])).rejects.toThrow(/not put back: put-back blocked/);
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
        expect(await isThere(separatorFolder('First'))).toBe(false);
      });

      it('holds the lock until every folder is back, so a change queued behind this one never reads the folders while the moved one is out of place', async () => {
        const moved = separatorFolder('Core Mods');
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => { open = resolve; });
        vi.mocked(fsRename).mockImplementation((from, to) =>
          (from === moved ? gate.then(() => actualRename(from, to)) : actualRename(from, to)));
        let sawItBack: boolean | undefined;
        await chmod(modlist(), 0o444);
        try {
          const first = change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);
          const second = adapter.changeModOrder('Default', (_order, folders) => {
            sawItBack = folders?.holding({ kind: 'separator', name: 'Unassigned (Modlist Development)' }) !== undefined;
            return [];
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          open();
          await expect(first).rejects.toThrow();
          await second;
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(sawItBack).toBe(true);
      });
    });

    describe('names, matched as MO2 matches them', () => {
      it('finds each entry a change names in any case, and writes it as mod order lists it', async () => {
        await change([
          { kind: 'enable', mod: 'harder vats', enabled: true },
          { kind: 'moveMods', mods: ['CRACKED AND SMUDGED PIP-BOY SCREEN'], place: { kind: 'separator', name: 'unassigned (modlist development)' }, end: 'losing' },
          { kind: 'dropSeparator', separator: 'RADFALL - ALL-IN-ONE SURVIVAL OVERHAUL' },
        ]);

        const order = modNames(await adapter.modOrder('Default'));
        expect(order).toContain('mod:Harder VATS:true');
        expect(order).not.toContain('separator:Radfall - All-In-One Survival Overhaul:false');
        expect(order.indexOf('mod:Cracked and Smudged Pip-Boy Screen:true'))
          .toBe(order.indexOf('separator:Unassigned (Modlist Development):false') - 1);
      });

      it.each<[string, ModOrderChange]>([
        ['a separator', { kind: 'addSeparator', separator: 'unassigned (modlist development)', afterIndex: 0 }],
        ['a rename', { kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'radfall - all-in-one survival overhaul' }],
      ])('rejects adding %s mod order already lists in another case', async (_, bad) => {
        await expect(change([bad])).rejects.toThrow(/already in modlist/);
      });

      it('names a separator as MO2 names its folder, and refuses a name with nothing of it left', async () => {
        await change([{ kind: 'addSeparator', separator: '  Core:  Mods.  ', afterIndex: -1 }]);

        expect(modNames(await adapter.modOrder('Default'))[0]).toBe('separator:Core Mods:true');
        expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
        await expect(change([{ kind: 'addSeparator', separator: 'CON', afterIndex: -1 }])).rejects.toThrow(/Not a valid separator name/);
      });
    });
  });

  describe('changes to plugin order', () => {
    const change = (changes: readonly PluginOrderChange[]) =>
      adapter.changePluginOrder('Default', () => changes);

    it('lands every change in one write of plugin order alone, keeping its byte-order mark', async () => {
      const before = await snapshotTree(root);

      const written = await change([
        { kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: false },
        { kind: 'drop', plugin: 'NonAsciiRetexture.esp' },
        { kind: 'add', plugin: 'New.esp' },
        { kind: 'move', plugins: ['ccSBJFO4003-Grenade.esl'], toIndex: 0 },
      ]);

      expect(written).toEqual({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_PLUGINS]));
      expect(await adapter.pluginOrder('Default')).toEqual([
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: false },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'New.esp', enabled: false },
      ]);
      expect((await text(root, DEFAULT_PLUGINS)).startsWith('﻿')).toBe(true);
    });

    it('hands the decision the order as it stands', async () => {
      const seen: string[][] = [];

      await adapter.changePluginOrder('Default', (order) => {
        seen.push(order.map((p) => p.name));
        return [];
      });

      expect(seen).toEqual([(await adapter.pluginOrder('Default')).map((p) => p.name)]);
    });

    it('finds each plugin a change names in any case, and writes it as plugin order lists it, a filename comparing as the game compares it, ignoring case', async () => {
      await change([
        { kind: 'enable', plugin: 'tracked patch mod.esp', enabled: false },
        { kind: 'move', plugins: ['CCSBJFO4003-GRENADE.ESL'], toIndex: 0 },
        { kind: 'drop', plugin: 'nonasciiretexture.ESP' },
      ]);

      expect(await adapter.pluginOrder('Default')).toEqual([
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: false },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
      ]);
    });

    it('writes nothing to add a plugin plugin order already lists in another case, doing nothing not being an error so a gesture that raced plugin sync to the same line does not fail', async () => {
      const before = await adapter.pluginOrder('Default');

      expect(await change([{ kind: 'add', plugin: 'TRACKED PATCH MOD.ESP' }])).toEqual({ wrote: false });
      expect(await adapter.pluginOrder('Default')).toEqual(before);
    });

    it('writes nothing when the changes are already true of plugin order', async () => {
      expect(await change([{ kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: true }])).toEqual({ wrote: false });
    });

    it.each<[string, PluginOrderChange]>([
      ['enable', { kind: 'enable', plugin: 'No Such.esp', enabled: true }],
      ['move', { kind: 'move', plugins: ['No Such.esp'], toIndex: 0 }],
      ['drop', { kind: 'drop', plugin: 'No Such.esp' }],
    ])('rejects %s naming a plugin that is not there, and writes nothing, not leaving the text as it was and dropping the change in silence', async (_, bad) => {
      const before = await text(root, DEFAULT_PLUGINS);

      await expect(change([{ kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: false }, bad]))
        .rejects.toThrow(/plugins\.txt/);

      expect(await text(root, DEFAULT_PLUGINS)).toBe(before);
    });
  });

  describe('a downloaded file\'s metadata', () => {
    const downloads = (): string => join(root, 'downloads');
    const metaOf = (name: string): Promise<string> => text(root, join('downloads', `${name}.meta`));

    beforeEach(() => writeFile(join(downloads(), 'manual.zip'), 'zip'));

    it('marks a downloaded file installed, creating its metadata when it has none', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Installed')).toEqual({ gone: false, wrote: true });

      const listed = await (await adapter.settings()).downloadedFiles();
      if (listed.kind !== 'listed') throw new Error(`expected listed, got ${listed.reason}`);
      expect(listed.files?.find((file) => file.name === 'manual.zip')?.meta?.status).toBe('Installed');
    });

    it('marks a downloaded file uninstalled beside its installed mark', async () => {
      await adapter.markDownloadedFile(DOWNLOAD, 'Uninstalled');

      expect(await metaOf(DOWNLOAD)).toMatch(/^uninstalled=true\r$/m);
      expect(await metaOf(DOWNLOAD)).toMatch(/^installed=true\r$/m);
    });

    it('marks a downloaded file excluded, and then included again', async () => {
      await adapter.markDownloadedFile(DOWNLOAD, 'Excluded');
      expect(await metaOf(DOWNLOAD)).toMatch(/removed=true/);

      await adapter.markDownloadedFile(DOWNLOAD, 'Included');
      expect(await metaOf(DOWNLOAD)).toMatch(/removed=false/);
    });

    it('writes no metadata for a file already included, so a file at rest does not gain metadata', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Included')).toEqual({ gone: false, wrote: false });

      expect(await isThere(join(downloads(), 'manual.zip.meta'))).toBe(false);
    });

    it('marks nothing for a downloaded file that is gone, as MO2 never writes a metadata file beside no downloaded file', async () => {
      expect(await adapter.markDownloadedFile('gone.zip', 'Installed')).toEqual({ gone: true });

      expect(await isThere(join(downloads(), 'gone.zip.meta'))).toBe(false);
    });

    it('names the downloaded file at a path, and none for a path outside the downloads folder', async () => {
      expect(await adapter.downloadedFileAt(join(downloads(), 'manual.zip'))).toBe('manual.zip');
      expect(await adapter.downloadedFileAt(join(root, 'manual.zip'))).toBeUndefined();
    });

    it('names no downloaded file where the settings name another downloads folder, never falling back to the default downloads folder, whether the D: folder resolves (on Windows) or not (elsewhere)', async () => {
      await writeFile(join(root, INI), (await text(root, INI)).replace('language=en', 'language=en\ndownload_directory=D:\\Elsewhere'));

      expect(await adapter.downloadedFileAt(join(downloads(), 'manual.zip'))).toBeUndefined();
    });

    it('sweeps its own leftover temp write when it trashes metadata, even for a file with none, as a crash during a first write leaves its temp beside no metadata at all', async () => {
      const leftover = join(downloads(), 'manual.zip.meta.0123456789ab.tmp');
      await writeFile(leftover, 'half written');

      expect(await adapter.trashDownloadedFileMeta('manual.zip', () => Promise.resolve())).toBe(false);

      expect(await isThere(leftover)).toBe(false);
    });

    it('moves a downloaded file\'s metadata to the trash, and answers false when it has none', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      };

      expect(await adapter.trashDownloadedFileMeta(DOWNLOAD, trash)).toBe(true);
      expect(await adapter.trashDownloadedFileMeta('manual.zip', trash)).toBe(false);

      expect(trashed).toEqual([join(downloads(), `${DOWNLOAD}.meta`)]);
    });
  });

  describe('extracting a mod', () => {
    const meta = (mod: string): Promise<string> => text(root, join('mods', mod, 'meta.ini'));

    it('lists an extracted folder\'s entries, each a folder or a file', async () => {
      const extraction = await adapter.extractNewMod('New Mod');
      await mkdir(join(extraction.path, 'Data'));
      await writeFile(join(extraction.path, 'readme.txt'), '');

      const entries = await adapter.extractedEntries(extraction.path);

      expect([...entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'Data', kind: 'folder' }, { name: 'readme.txt', kind: 'file' },
      ]);
    });

    describe('a new mod', () => {
      it('extracts inside the mod\'s own folder and writes nowhere else', async () => {
        const before = await snapshotTree(root);

        const extraction = await adapter.extractNewMod('New Mod');

        expect(extraction.path.startsWith(join(root, 'mods', 'New Mod'))).toBe(true);
        assertOnlyChanged(before, await snapshotTree(root), new Set());
        expect(await readdir(join(root, 'mods', 'New Mod'))).toHaveLength(1);
      });

      it('copies a folder in, leaving the folder as it was', async () => {
        const source = join(root, 'mods', 'Unofficial Fallout 4 Patch');
        const before = await snapshotTree(source);
        const extraction = await adapter.extractNewMod('New Mod');

        await extraction.copyIn(source);

        expect(await snapshotTree(extraction.path)).toEqual(before);
        expect(await snapshotTree(source)).toEqual(before);
      });

      it('lands whole, its meta holding only the keys it is given', async () => {
        const extraction = await adapter.extractNewMod('New Mod');
        await mkdir(join(extraction.path, 'Wrapper'));
        await writeFile(join(extraction.path, 'Wrapper', 'meta.ini'), 'shipped=true\n');
        await writeFile(join(extraction.path, 'Wrapper', 'New.esp'), '');
        await writeFile(join(extraction.path, 'leftover.txt'), '');

        await extraction.land(join(extraction.path, 'Wrapper'), { gameName: 'Fallout4', archiveFilename: 'Mod-1.7z' });

        expect(await meta('New Mod')).toBe('[General]\ngameName=Fallout4\ninstallationFile=Mod-1.7z\n');
        expect((await readdir(join(root, 'mods', 'New Mod'))).sort()).toEqual(['New.esp', 'meta.ini']);
      });

      it('abandoned, takes its whole folder with it', async () => {
        const extraction = await adapter.extractNewMod('New Mod');
        await writeFile(join(extraction.path, 'Half.esp'), '');

        await extraction.abandon();

        expect(await isThere(join(root, 'mods', 'New Mod'))).toBe(false);
      });

      it('refuses a folder already there, matched as the manager matches names, and leaves it', async () => {
        const before = await snapshotTree(join(root, 'mods', 'Unofficial Fallout 4 Patch'));

        await expect(adapter.extractNewMod('unofficial fallout 4 patch')).rejects.toThrow(/is in the way/);

        expect(await snapshotTree(join(root, 'mods', 'Unofficial Fallout 4 Patch'))).toEqual(before);
      });
    });

    describe('an upgrade', () => {
      const mod = 'Unofficial Fallout 4 Patch';
      const folder = (): string => join(root, 'mods', mod);
      let extraction: UpgradeExtraction;

      beforeEach(async () => {
        await mkdir(join(folder(), '.git'));
        await writeFile(join(folder(), '.gitignore'), 'mine');
        await writeFile(join(folder(), 'Old.esp'), '');
        await mkdir(join(folder(), 'plugin-source', 'kept'), { recursive: true });
        extraction = await adapter.extractUpgrade('unofficial fallout 4 patch');
        await writeFile(join(extraction.path, 'New.esp'), '');
      });

      it('extracts inside the mod\'s own folder, touching nothing of what it holds', async () => {
        expect(extraction.path.startsWith(folder())).toBe(true);
        expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
      });

      it('replaces the contents around the mod\'s repository and plugin source', async () => {
        expect(await extraction.land(extraction.path, { gameName: 'Fallout4' })).toEqual({ refused: false });

        expect(await isThere(join(folder(), '.git'))).toBe(true);
        expect(await text(root, join('mods', mod, '.gitignore'))).toBe('mine');
        expect(await isThere(join(folder(), 'plugin-source', 'kept'))).toBe(true);
        expect(await isThere(join(folder(), 'Old.esp'))).toBe(false);
        expect(await isThere(join(folder(), 'New.esp'))).toBe(true);
        expect(await isThere(extraction.path)).toBe(false);
      });

      it('abandoned, removes the extraction and keeps everything the folder held', async () => {
        await extraction.abandon();

        expect(await isThere(extraction.path)).toBe(false);
        expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
        expect(await isThere(join(folder(), '.git'))).toBe(true);
        expect(await isThere(join(folder(), 'plugin-source', 'kept'))).toBe(true);
      });

      it.each(['.git', '.gitignore', 'plugin-source', 'Plugin-Source', '.GITIGNORE'])(
        'refuses a release holding %s, naming it, before anything is removed, matched case-insensitively as on Windows Plugin-Source is the kept plugin-source and the move onto it would fail part way while elsewhere it lands beside it and drops out of the mod\'s files',
        async (entry) => {
          await mkdir(join(extraction.path, entry));

          expect(await extraction.land(extraction.path, { gameName: 'Fallout4' })).toEqual({ refused: true, repositoryOrPluginSourceEntry: entry });

          expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
          expect(await isThere(join(folder(), 'plugin-source', 'kept'))).toBe(true);
        },
      );

      it('refuses a release holding a repository or plugin source entry the folder has none of, so a first upgrade does not plant one that every later upgrade then refuses', async () => {
        await rm(join(folder(), 'plugin-source'), { recursive: true });
        await mkdir(join(extraction.path, 'plugin-source'));

        expect(await extraction.land(extraction.path, { gameName: 'Fallout4' })).toEqual({ refused: true, repositoryOrPluginSourceEntry: 'plugin-source' });

        expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
      });

      it.each(['Source', 'source'])('does not refuse a release holding a root %s folder, Skyrim SE\'s Creation Kit shipping script sources at a release\'s own root Source/ — ordinary content, not a collision', async (entry) => {
        await mkdir(join(extraction.path, entry));

        expect(await extraction.land(extraction.path, { gameName: 'Fallout4' })).toEqual({ refused: false });

        expect(await isThere(join(folder(), entry))).toBe(true);
        expect(await isThere(join(folder(), 'plugin-source', 'kept'))).toBe(true);
      });

      it('settles a release nested below the extraction, leaving no wrapper behind', async () => {
        const root = join(extraction.path, 'Wrapper', 'Data');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'Nested.esp'), '');

        expect(await extraction.land(root, { gameName: 'Fallout4' })).toEqual({ refused: false });

        expect(await isThere(join(folder(), 'Nested.esp'))).toBe(true);
        expect(await isThere(extraction.path)).toBe(false);
        expect(await isThere(join(folder(), 'Wrapper'))).toBe(false);
      });

      it('refuses a mod no folder holds', async () => {
        await expect(adapter.extractUpgrade('No Such Mod')).rejects.toThrow(/No folder holds/);
      });

      it('sets the keys over the meta the mod had before its contents went, not over one a release ships, which would replace the keys the mod had', async () => {
        await writeFile(join(extraction.path, 'meta.ini'), 'shipped=true\r\n');

        await extraction.land(extraction.path, { gameName: 'Fallout4', version: '2.2' });

        expect(await meta(mod)).toBe(
          `[General]\r\ngameName=Fallout4\r\nmodid=4598\r\nversion=2.2\r\ncategory="-1,"\r\ninstallationFile=${DOWNLOAD}\r\n`,
        );
      });
    });
  });

  describe('the selected profile', () => {
    it('selects a profile, touching the settings alone', async () => {
      const before = await snapshotTree(root);

      expect(await adapter.selectProfile('Secondary')).toEqual({ wrote: true });

      assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
      expect((await adapter.settings()).profile).toBe('Secondary');
    });

    it('writes nothing when the profile is already selected, not rewriting an unwrapped value', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n');
      const before = await text(root, INI);

      expect(await adapter.selectProfile('Default')).toEqual({ wrote: false });

      expect(await text(root, INI)).toBe(before);
    });
  });
});

describe('isMo2Instance', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-detect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const layInstance = async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\n');
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
  };

  it('is true when ModOrganizer.ini, mods/, and profiles/ are all present', async () => {
    await layInstance();
    expect(isMo2Instance(root)).toBe(true);
  });

  it('is false when ModOrganizer.ini is missing', async () => {
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when mods/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when profiles/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'mods'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a completely empty folder', () => {
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a nonexistent path, without throwing', () => {
    expect(isMo2Instance(join(root, 'does-not-exist'))).toBe(false);
  });

  it('does not read modlist.txt content — a corrupt-but-present instance still reads true', async () => {
    await layInstance();
    await mkdir(join(root, 'profiles', 'Default'));
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '\x00not valid text\xff');
    expect(isMo2Instance(root)).toBe(true);
  });
});
