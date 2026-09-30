import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename as fsRename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
// Passthrough, so a test can hold a folder's move back, remove a folder mid-walk, or fail a link's
// stat with an error other than ENOENT: chmod denies nothing when the runner is root.
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
import { mo2InstanceAdapter } from '../mo2Instance';
import { OVERWRITE_ORIGIN } from '../instanceAdapter';
import type { GameDetectors } from '../gameDirectory';
import type {
  GameFolder, InstanceAdapter, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange,
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

const adapterAt = (instanceRoot: string, gameDirectory?: string): InstanceAdapter =>
  mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides: () => ({ gameDirectory }), detectors: NO_DETECTORS });

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

  beforeEach(async () => {
    root = await cloneCorpusFixture();
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

    // Rival: a release guessed from the name, which has the backend answer about another game.
    it('answers no release for a game the tables hold none for', async () => {
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

    // Rival: empty metadata read as none, so a file whose metadata is there to open shows none.
    it('answers metadata that is there but empty as metadata', async () => {
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

    // Rival: each answer reading the settings again, so a rewrite between two answers lands two
    // generations in one value.
    it('answers where the downloads are from the same read the profile came from', async () => {
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

    // Rival: an exact match, which reads a line another tool recased as no entry.
    it('answers the entry of a kind mod order lists, matched as MO2 matches names, or none', async () => {
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

    // Rival: any failure read as no meta, which publishes an unreadable meta as an empty one.
    it('rejects a meta that is there but cannot be read', async () => {
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

    // Rival: the reserved overwrite name answered as a mod, which mod sync would then list.
    it('answers no entry for a folder named as the reserved overwrite folder', async () => {
      await mkdir(join(root, 'mods', 'Overwrite'));

      expect((await adapter.modFolders())?.all.map((f) => f.name)).not.toContain('Overwrite');
    });

    it('answers which mod folder holds an entry, matched as MO2 matches names, from the one listing', async () => {
      const folders = present(await adapter.modFolders(), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'harder vats' })?.path).toBe(join(root, 'mods', 'Harder VATS'));
      expect(folders.holding({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
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

      it('answers the plugin files at the Data folder\'s root, case-folded', async () => {
        const data = join(game, 'Data');
        await mkdir(join(data, 'Nested.esp'), { recursive: true });
        await writeFile(join(data, 'Fallout4.ESM'), '');
        await writeFile(join(data, 'Patch.esp'), '');
        await writeFile(join(data, 'readme.txt'), '');

        const plugins = await adapter.gameFolderPlugins(found(data));

        expect(plugins).toEqual({ kind: 'listed', names: new Set(['fallout4.esm', 'patch.esp']) });
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
  });

  describe('the watch', () => {
    afterEach(() => {
      watchers.length = 0;
    });

    const live = (): FakeWatcher[] => watchers.filter((w) => !w.disposed);

    // `heardAs` stands in for a path the matcher here reads differently than VS Code's does.
    const fire = (base: string, relative: string, heardAs = relative): boolean => {
      const watcher = live().find((w) => w.base === base && matchesGlob(heardAs, w.pattern));
      watcher?.fireChange(join(base, relative));
      return watcher !== undefined;
    };

    // Rival: a watch that hears one kind of event, so a deleted mod folder is never heard.
    it('hears a file created, changed or deleted alike', () => {
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

    it('signals a change to every profile\'s two order files, the settings, a mod\'s files and overwrite', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });

      for (const relative of [
        'profiles/Default/modlist.txt', 'profiles/Secondary/plugins.txt', 'ModOrganizer.ini',
        'mods/Harder VATS/Textures/a.dds', 'overwrite/F4SE/Plugins/x.ini',
      ]) expect(fire(root, relative), relative).toBe(true);
      expect(fire(root, 'profiles/Default/other.txt')).toBe(false);
      expect(signals).toBe(5);
    });

    // Rival: every path under a mod heard alike, so a git operation inside a tracked mod reads as
    // a change to the instance.
    it('hears nothing inside a mod\'s git repository, but hears the repository folder itself come or go', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });

      expect(fire(root, 'mods/Harder VATS/.git/index', 'mods/Harder VATS/index')).toBe(true);
      expect(signals).toBe(0);
      expect(fire(root, 'mods/Harder VATS/.git', 'mods/Harder VATS/git')).toBe(true);
      expect(signals).toBe(1);
    });

    // Rival: the downloads folder watched where the instance began, so a download landing in the
    // folder the settings name now is never heard.
    it('follows the downloads folder the last read of the settings resolved, signalling once when it moves', async () => {
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

    // Rival: a glob of one case, which misses a plugin whose extension another tool wrote in capitals.
    it('follows the plugins at the root of the game folder\'s Data folder, in any case', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-game-'));
      try {
        await mkdir(join(game, 'Data'));
          const watched = adapterAt(root, game);
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        for (const name of ['Fallout4.esm', 'Patch.ESP', 'cc.Esl']) expect(fire(join(game, 'Data'), name), name).toBe(true);
        expect(fire(join(game, 'Data'), 'readme.txt')).toBe(false);
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

    // MO2 knows a mod by its folder's name, and a folder named for a separator holds that
    // separator. Rival: matching the kind first, so the name reads as free.
    it('answers a mod named as a separator\'s folder with that separator\'s folder', async () => {
      expect(await adapter.entryFolder({ kind: 'mod', name: 'unassigned (modlist development)_SEPARATOR' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    // A separator is named as MO2 names its folder, so a name asked for loosely finds it too.
    it('finds a separator\'s folder by the name MO2 would give it', async () => {
      expect(await adapter.entryFolder({ kind: 'separator', name: '  unassigned  (Modlist Development)..' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    describe('an origin\'s files', () => {
      const mod = (name: string) => ({ kind: 'mod' as const, name });
      const relativePaths = (files: readonly { relativePath: string }[]): string[] => files.map((f) => f.relativePath).sort();

      it('walks a mod\'s folder, leaving out its metadata, its root source tree, dot entries and writes in flight', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Textures', 'Source'), { recursive: true });
        await writeFile(join(folder, 'Textures', 'a.dds'), '');
        await writeFile(join(folder, 'Textures', 'Source', 'kept.psc'), '');
        await mkdir(join(folder, 'source'), { recursive: true });
        await writeFile(join(folder, 'source', 'left.json'), '');
        await mkdir(join(folder, '.git'), { recursive: true });
        await writeFile(join(folder, '.git', 'HEAD'), '');
        await writeFile(tempWritePath(join(folder, 'Textures', 'b.dds')), '');

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.origin).toBe('Harder VATS');
        expect(files.folder).toBe(folder);
        expect(relativePaths(files.files)).toEqual(['Textures/Source/kept.psc', 'Textures/a.dds']);
        expect(files.files.find((f) => f.relativePath === 'Textures/a.dds')?.path).toBe(join(folder, 'Textures', 'a.dds'));
      });

      it('reads a linked file from where the link points, and notes a broken link rather than failing', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(folder, 'Linked.esp'));
        await symlink(join(root, 'nowhere.esp'), join(folder, 'Broken.esp'));

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'Linked.esp')?.path).toBe(await realpath(target));
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

      it('leaves out a root source folder in any case, and keeps a root folder whose name only starts with source', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'SOURCE'), { recursive: true });
        await writeFile(join(folder, 'SOURCE', 'stray.json'), '');
        await mkdir(join(folder, 'sourceish'), { recursive: true });
        await writeFile(join(folder, 'sourceish', 'note.txt'), '');

        const paths = relativePaths((await adapter.originFiles(mod('Harder VATS'))).files);

        expect(paths).toContain('sourceish/note.txt');
        expect(paths).not.toContain('SOURCE/stray.json');
      });

      it('follows a linked folder, its files keyed beneath the link\'s own name', async () => {
        const shared = join(root, 'shared-textures');
        await mkdir(shared);
        await writeFile(join(shared, 'foo.dds'), '');
        await symlink(shared, join(root, 'mods', 'Harder VATS', 'linked'));

        const files = await adapter.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'linked/foo.dds')?.path).toBe(join(root, 'mods', 'Harder VATS', 'linked', 'foo.dds'));
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

      it('rejects when a link\'s target cannot be checked for a reason other than its absence', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await symlink(join(root, 'whatever.dds'), join(folder, 'restricted.dds'));
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('restricted.dds')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualStat(path, ...rest);
        });

        await expect(adapter.originFiles(mod('Harder VATS'))).rejects.toThrow(/permission denied/);
      });

      // mkfifo is POSIX, so Windows has no FIFO to build.
      it.skipIf(process.platform === 'win32')('notes a FIFO and a link to one, and answers neither as a file', async () => {
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
        expect(await adapter.originFiles(mod('../profiles'))).toEqual({ origin: '../profiles', folder: undefined, files: [], notes: [] });
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
      });

      // Rival: one catch around the whole walk, which reads a folder removed mid-walk as an empty
      // origin.
      it.each([
        ['the overwrite folder', { kind: 'runtimeOutput' as const }, 'overwrite', 'F4SE/Plugins/SomePlugin.log'],
        ['a mod\'s folder', mod('Harder VATS'), join('mods', 'Harder VATS'), 'Kept.esp'],
      ])('skips a subfolder of %s removed mid-walk, and notes it', async (_, origin, folder, kept) => {
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

      // Rival: skipping a link in overwrite/ with no word, which drops its file from the picture.
      it('notes a link in the overwrite folder, which it does not follow', async () => {
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

    // ADR-0007: tracked is the presence of `.git` in the mod's folder.
    describe('a plugin file\'s tracked folder', () => {
      it('answers the mod folder a plugin file sits in when it holds a repository', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, '.git'));

        expect(await adapter.trackedFolderOf(join(folder, 'Harder VATS.esp'))).toBe(folder);
      });

      it('answers none for a plugin file in a folder with no repository', async () => {
        expect(await adapter.trackedFolderOf(join(root, 'mods', 'Harder VATS', 'Harder VATS.esp'))).toBeUndefined();
      });
    });
  });

  describe('put and rename in mods/', () => {
    it('creates a mod\'s folder, and refuses a name that escapes the mod folders', async () => {
      await adapter.createModFolder('Brand New');

      expect(await isThere(join(root, 'mods', 'Brand New'))).toBe(true);
      await expect(adapter.createModFolder('../escape')).rejects.toThrow(/Not a valid mod name/);
    });

    // Rival: making the folder whatever is there, which adopts another mod's folder, or a
    // separator's, in silence.
    it.each([
      ['a mod\'s, in another case', 'harder vats', 'Harder VATS'],
      ['a separator\'s, whose name it decodes to', 'unassigned (modlist development)_SEPARATOR', 'Unassigned (Modlist Development)_separator'],
    ])('refuses a folder already there as %s, naming it', async (_, mod, folder) => {
      const before = await snapshotTree(root);

      await expect(adapter.createModFolder(mod)).rejects.toThrow(`The folder "${join(root, 'mods', folder)}" is in the way`);

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

    it('writes nothing when the changes are already true of mod order', async () => {
      const before = await text(root, DEFAULT_MODLIST);
      const mtime = (await stat(join(root, DEFAULT_MODLIST))).mtimeMs;

      expect(await change([{ kind: 'enable', mod: 'Tracked Patch Mod', enabled: true }])).toEqual({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect((await stat(join(root, DEFAULT_MODLIST))).mtimeMs).toBe(mtime);
    });

    // Rival for each: a splice that finds no line to change and leaves the text as it was, so the
    // change is dropped in silence.
    it.each<[string, ModOrderChange]>([
      ['enable', { kind: 'enable', mod: 'No Such Mod', enabled: true }],
      ['moveMods', { kind: 'moveMods', mods: ['No Such Mod'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['moveSeparators', { kind: 'moveSeparators', separators: ['No Such Sep'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['renameSeparator', { kind: 'renameSeparator', from: 'No Such Sep', to: 'Anything' }],
      ['addSeparator a listed separator', { kind: 'addSeparator', separator: 'Unassigned (Modlist Development)', afterIndex: 0 }],
      ['renameSeparator onto a listed separator', {
        kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Radfall - All-In-One Survival Overhaul',
      }],
    ])('rejects %s naming an entry that is not there, or adding a separator that is, and writes nothing', async (_, bad) => {
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'enable', mod: 'Harder VATS', enabled: true }, bad])).rejects.toThrow(/modlist/);

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    // An entry already added, or already dropped, is already as the change would leave it. Rival:
    // rejecting it, which fails a gesture that raced mod sync to the same line.
    it.each<[string, ModOrderChange]>([
      ['adding a mod listed in another case', { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'HARDER VATS' } }],
      ['adding a separator listed in another case', { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'radfall - all-in-one survival overhaul' } }],
      ['dropping a mod not listed', { kind: 'dropMod', mod: 'No Such Mod' }],
      ['dropping a separator not listed', { kind: 'dropSeparator', separator: 'No Such Sep' }],
    ])('writes nothing for %s, and says so', async (_, already) => {
      const before = await text(root, DEFAULT_MODLIST);

      expect(await change([already])).toEqual({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    // Rival: the order read before the change queues behind one already in flight, so the second
    // decides from an order the first is about to replace.
    it('decides each change from the order the change before it left', async () => {
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

      // Rival: the line written before the folder moves, so a folder that cannot move leaves the
      // line renamed over a folder of the old name.
      it('leaves line and folder as they were when the folder cannot be renamed', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(join(separatorFolder('Core Mods'), 'occupied'), { recursive: true });

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow();

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
      });

      // Rival: no check for a folder already there, so on Linux a rename onto an empty one replaces
      // it in silence, where Windows refuses.
      it('refuses a rename onto a folder already there, listed or not, before anything moves', async () => {
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

      // Rival: a folder already there adopted as the new separator's own, and then taken away as
      // one it made if the line cannot be written.
      it('refuses adding a separator whose folder is already there', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(separatorFolder('Orphan'));
        await writeFile(join(separatorFolder('Orphan'), 'kept.txt'), '');

        await expect(change([{ kind: 'addSeparator', separator: 'Orphan', afterIndex: -1 }])).rejects.toThrow(/is in the way/);

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(join(separatorFolder('Orphan'), 'kept.txt'))).toBe(true);
      });

      // Rival: no undo, so a line that cannot be written leaves the folder renamed alone.
      it('puts the folder back when the renamed line cannot be written', async () => {
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

      // Rival: the undos run oldest first, so a separator added and then renamed in one change leaves
      // its first folder behind.
      it('puts every folder back newest first', async () => {
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

      // Rival: the undos stop at the first that fails, so an older move is never put back.
      it('tries every put-back when one fails, and names each failure', async () => {
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

      // Rival: the put-back run after the lock is let go, so a change queued behind this one reads
      // the folders while the moved one is still out of place.
      it('holds the lock until every folder is back', async () => {
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

      // A separator's name is the one MO2 gives its folder (mods.md, Add separator).
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

    // ADR-0012: a filename compares as the game compares it, ignoring case.
    it('finds each plugin a change names in any case, and writes it as plugin order lists it', async () => {
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

    // commands.md, Principles: doing nothing is not an error. Rival: rejecting it, which fails a
    // gesture that raced plugin sync to the same line.
    it('writes nothing to add a plugin plugin order already lists in another case', async () => {
      const before = await adapter.pluginOrder('Default');

      expect(await change([{ kind: 'add', plugin: 'TRACKED PATCH MOD.ESP' }])).toEqual({ wrote: false });
      expect(await adapter.pluginOrder('Default')).toEqual(before);
    });

    it('writes nothing when the changes are already true of plugin order', async () => {
      expect(await change([{ kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: true }])).toEqual({ wrote: false });
    });

    // Rival for each: a splice that finds no line to change and leaves the text as it was.
    it.each<[string, PluginOrderChange]>([
      ['enable', { kind: 'enable', plugin: 'No Such.esp', enabled: true }],
      ['move', { kind: 'move', plugins: ['No Such.esp'], toIndex: 0 }],
      ['drop', { kind: 'drop', plugin: 'No Such.esp' }],
    ])('rejects %s naming a plugin that is not there, and writes nothing', async (_, bad) => {
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

    // Rival: including writes its key whatever the file says, so a file at rest gains metadata.
    it('writes no metadata for a file already included', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Included')).toEqual({ gone: false, wrote: false });

      expect(await isThere(join(downloads(), 'manual.zip.meta'))).toBe(false);
    });

    // A metadata file beside no downloaded file is one MO2 never writes.
    it('marks nothing for a downloaded file that is gone', async () => {
      expect(await adapter.markDownloadedFile('gone.zip', 'Installed')).toEqual({ gone: true });

      expect(await isThere(join(downloads(), 'gone.zip.meta'))).toBe(false);
    });

    it('names the downloaded file at a path, and none for a path outside the downloads folder', async () => {
      expect(await adapter.downloadedFileAt(join(downloads(), 'manual.zip'))).toBe('manual.zip');
      expect(await adapter.downloadedFileAt(join(root, 'manual.zip'))).toBeUndefined();
    });

    // Rival: fall back to the default downloads folder. Off Windows, a D: folder cannot be resolved;
    // on Windows it is resolved, and elsewhere: either way the default folder's file is none.
    it('names no downloaded file where the settings name another downloads folder', async () => {
      await writeFile(join(root, INI), (await text(root, INI)).replace('language=en', 'language=en\ndownload_directory=D:\\Elsewhere'));

      expect(await adapter.downloadedFileAt(join(downloads(), 'manual.zip'))).toBeUndefined();
    });

    // Rival: sweep only when the metadata is there. A crash during a first write leaves its temp
    // beside no metadata at all.
    it('sweeps its own leftover temp write when it trashes metadata, even for a file with none', async () => {
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

  describe('staging', () => {
    it('stages a copy of a folder, leaving the folder as it was', async () => {
      const source = join(root, 'mods', 'Unofficial Fallout 4 Patch');
      const before = await snapshotTree(source);

      const staged = await adapter.stagingFolderOf(source);

      expect(staged.path.startsWith(join(root, 'mods'))).toBe(false);
      expect(await snapshotTree(staged.path)).toEqual(before);
      expect(await snapshotTree(source)).toEqual(before);
    });

    it('lists a staged folder\'s entries, each a folder or a file', async () => {
      const staged = await adapter.stagingFolder();
      await mkdir(join(staged.path, 'Data'));
      await writeFile(join(staged.path, 'readme.txt'), '');

      const entries = await adapter.stagedEntries(staged.path);

      expect([...entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'Data', kind: 'folder' }, { name: 'readme.txt', kind: 'file' },
      ]);
    });

    it('removes a staging folder and what is left in it', async () => {
      const staged = await adapter.stagingFolder();
      await mkdir(join(staged.path, 'Wrapper'));

      await staged.remove();

      expect(await isThere(staged.path)).toBe(false);
    });
  });

  describe('landing a mod', () => {
    const meta = (mod: string): Promise<string> => text(root, join('mods', mod, 'meta.ini'));

    it('stages beside the mod folders, outside every one of them', async () => {
      const staged = await adapter.stagingFolder();

      expect(await isThere(staged.path)).toBe(true);
      expect(staged.path.startsWith(join(root, 'mods'))).toBe(false);
    });

    it('lands a new mod whole, its meta holding only the keys it is given', async () => {
      const staged = (await adapter.stagingFolder()).path;
      await writeFile(join(staged, 'meta.ini'), 'shipped=true\n');
      await writeFile(join(staged, 'New.esp'), '');

      await adapter.landNewMod('New Mod', staged, { gameName: 'Fallout4', installationFile: 'Mod-1.7z' });

      expect(await meta('New Mod')).toBe('[General]\ngameName=Fallout4\ninstallationFile=Mod-1.7z\n');
      expect(await isThere(join(root, 'mods', 'New Mod', 'New.esp'))).toBe(true);
      expect(await isThere(staged)).toBe(false);
    });

    describe('an upgrade', () => {
      const mod = 'Unofficial Fallout 4 Patch';
      const folder = (): string => join(root, 'mods', mod);
      let staged: string;

      beforeEach(async () => {
        await mkdir(join(folder(), '.git'));
        await writeFile(join(folder(), '.gitignore'), 'mine');
        await writeFile(join(folder(), 'Old.esp'), '');
        await mkdir(join(folder(), 'source', 'kept'), { recursive: true });
        staged = (await adapter.stagingFolder()).path;
        await writeFile(join(staged, 'New.esp'), '');
      });

      it('replaces the contents around the mod\'s repository and plugin source', async () => {
        expect(await adapter.upgradeMod('unofficial fallout 4 patch', staged, { gameName: 'Fallout4' })).toEqual({ refused: false });

        expect(await isThere(join(folder(), '.git'))).toBe(true);
        expect(await text(root, join('mods', mod, '.gitignore'))).toBe('mine');
        expect(await isThere(join(folder(), 'source', 'kept'))).toBe(true);
        expect(await isThere(join(folder(), 'Old.esp'))).toBe(false);
        expect(await isThere(join(folder(), 'New.esp'))).toBe(true);
      });

      // Rival: a case-sensitive match. On Windows `Source` is the kept `source`, and the move onto
      // it fails part way; elsewhere it lands beside it and drops out of the mod's files.
      it.each(['.git', '.gitignore', 'source', 'Source', '.GITIGNORE'])(
        'refuses a release holding %s, naming it, before anything is removed',
        async (entry) => {
          await mkdir(join(staged, entry));

          expect(await adapter.upgradeMod(mod, staged, { gameName: 'Fallout4' })).toEqual({ refused: true, repositoryOrPluginSourceEntry: entry });

          expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
          expect(await isThere(join(folder(), 'source', 'kept'))).toBe(true);
        },
      );

      // Rival: refuse only an entry the folder already has, so a first upgrade plants one that
      // every later upgrade then refuses.
      it('refuses a release holding a repository or plugin source entry the folder has none of', async () => {
        await rm(join(folder(), 'source'), { recursive: true });
        await mkdir(join(staged, 'source'));

        expect(await adapter.upgradeMod(mod, staged, { gameName: 'Fallout4' })).toEqual({ refused: true, repositoryOrPluginSourceEntry: 'source' });

        expect(await isThere(join(folder(), 'Old.esp'))).toBe(true);
      });

      it('refuses a mod no folder holds', async () => {
        await expect(adapter.upgradeMod('No Such Mod', staged, { gameName: 'Fallout4' })).rejects.toThrow(/No folder holds/);
      });

      // Rival: the meta read after the release's entries land, so a release shipping its own meta
      // replaces the keys the mod had.
      it('sets the keys over the meta the mod had before its contents went', async () => {
        await writeFile(join(staged, 'meta.ini'), 'shipped=true\r\n');

        await adapter.upgradeMod(mod, staged, { gameName: 'Fallout4', version: '2.2' });

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

    // Rival: the profile written whatever the settings say, which rewrites an unwrapped value.
    it('writes nothing when the profile is already selected', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n');
      const before = await text(root, INI);

      expect(await adapter.selectProfile('Default')).toEqual({ wrote: false });

      expect(await text(root, INI)).toBe(before);
    });
  });
});
