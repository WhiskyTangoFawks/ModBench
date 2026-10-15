import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename as fsRename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../test/noDetectors';
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
import type { Mo2Context } from '../mo2Context';
import { readingSource, readInstance, type ReadingSource } from '../mo2Reads';
import { MetadataNotWritable, OVERWRITE_ORIGIN, type Subscription } from '../instanceAdapter';
import type {
  ArchiveReader, GameFolder, InstallTarget, InstanceAdapter, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange,
} from '../instanceAdapter';
import { tempWritePath } from '../layout';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';
import { contextOver } from '../../test/mo2/adapterOver';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS, snapshotTree,
} from '../../test/mo2/corpusFixture';

async function settleWaitArmed(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (vi.getTimerCount() === 0) {
    if (Date.now() >= deadline) throw new Error('no settle wait was armed on the fake clock');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const INI = 'ModOrganizer.ini';
const DOWNLOAD = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

const adapterAt = (
  instanceRoot: string, gameDirectory?: string, gameDirectoryChanged: (listener: () => void) => Subscription = () => ({ dispose: () => {} }),
  archives: ArchiveReader = fakeArchiveReader([]),
): InstanceAdapter => mo2InstanceAdapter({
  instanceRoot, gameDirectoryOverrides: () => ({ gameDirectory }), gameDirectoryChanged, detectors: NO_DETECTORS, archives,
});

const watchedOver = (context: Mo2Context): ReadingSource & Pick<InstanceAdapter, 'subscribe'> =>
  ({ ...readingSource(context), subscribe: (listener) => context.watch.subscribe(listener) });

const sourceAt = (instanceRoot: string, gameDirectory?: string): ReadingSource => readingSource(contextOver(instanceRoot, { gameDirectory }));

async function installHeld(root: string, target: InstallTarget): Promise<{ extraction: string; settle: () => Promise<void> }> {
  const release = fakeArchiveReader(['New.esp']);
  let extracted: (path: string) => void = () => {};
  const extraction = new Promise<string>((resolve) => { extracted = resolve; });
  let letGo: () => void = () => {};
  const held = new Promise<void>((resolve) => { letGo = resolve; });
  const archives: ArchiveReader = {
    ...release,
    extract: async (archivePath, destDir) => {
      await release.extract(archivePath, destDir);
      extracted(destDir);
      await held;
    },
  };
  const installing = adapterAt(root, undefined, undefined, archives).install({ kind: 'archive', path: '/elsewhere/New.7z' }, target, { gameName: 'Fallout4' });
  return {
    extraction: await extraction,
    settle: () => {
      letGo();
      return installing.then(() => undefined, () => undefined);
    },
  };
}

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
  let source: ReadingSource;

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = adapterAt(root);
    source = sourceAt(root);
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(stat).mockImplementation(actualStat);
    vi.mocked(readdir).mockImplementation(actualReaddir);
    await rm(root, { recursive: true, force: true });
  });

  describe('parsed reads', () => {
    it('answers the selected profile and the game from the settings', async () => {
      const settings = await source.settings();

      expect(settings.profile).toBe('Default');
      expect(settings.gameName).toBe('Fallout 4');
      expect(settings.gameRelease).toBe('Fallout4');
    });

    describe('the reading', () => {
      it('answers the profile, game, plugin order, downloads and the game folder with what it holds', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-reading-'));
        try {
          await mkdir(join(game, 'Data'));
          await writeFile(join(game, 'Data', 'Fallout4.esm'), '');
          await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\r\n');

          const reading = await adapterAt(root, game).reading();

          expect(reading).toMatchObject({
            profile: 'Default',
            gameName: 'Fallout 4',
            gameRelease: 'Fallout4',
            downloadedFiles: { kind: 'listed', downloadsDir: join(root, 'downloads') },
            gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') },
            dataFolderPlugins: { kind: 'listed', names: new Set(['Fallout4.esm']) },
            creationClubList: ['ccBGSFO4044-HellfirePowerArmor.esl'],
          });
          expect(reading.pluginOrder).toEqual([
            { name: 'NonAsciiRetexture.esp', enabled: true }, { name: 'Tracked Patch Mod.esp', enabled: true },
            { name: 'Unofficial Fallout 4 Patch.esp', enabled: true }, { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
          ]);
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the mod order with each mod\'s meta folded into its entry', async () => {
        const { mods } = await adapter.reading();

        expect(mods).toHaveLength(10);
        expect(mods.map((entry) => `${entry.kind}:${entry.name}`).slice(0, 4)).toEqual([
          'mod:Ñoño\'s Retexture', 'mod:Tracked Patch Mod', 'mod:SKK Fast Start new game (Fallout 4)', 'separator:Unassigned (Modlist Development)',
        ]);
        expect(mods[0]).toMatchObject({ version: '1.0.0', nexusId: '99001' });
        expect(mods[2]).toMatchObject({
          version: '21.0.0.0', nexusId: '29227', archiveFilename: 'SKKFastStartNewGame_021-29227-021-1745492845.zip',
        });
      });

      it('never carries meta fields on a separator entry, even when a same-named mod folder exists', async () => {
        const folder = join(root, 'mods', 'Unassigned (Modlist Development)');
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'meta.ini'), '[General]\r\nmodid=555\r\nversion=9.9.9\r\n');

        const { mods } = await adapter.reading();

        expect(mods.find((entry) => entry.name === 'Unassigned (Modlist Development)'))
          .toEqual({ kind: 'separator', name: 'Unassigned (Modlist Development)', enabled: false });
      });

      it('answers the profiles, the mod folders, the run-time output and each listed mod\'s own files', async () => {
        const reading = await adapter.reading();

        expect(reading.profiles).toEqual(['Default', 'Secondary']);
        expect(reading.modFolders?.all.map((folder) => folder.name)).toHaveLength(9);
        expect(reading.runtimeOutput.files.map((file) => file.relativePath)).toEqual(['F4SE/Plugins/SomePlugin.log']);
        expect([...reading.modFiles.keys()]).toEqual(reading.mods.filter((entry) => entry.kind === 'mod').map((entry) => entry.name));
        expect(reading.modFiles.get('Ñoño\'s Retexture')?.files).toHaveLength(2);
        expect(reading.modFiles.get('Tracked Patch Mod')?.files).toHaveLength(1);
        expect(reading.modFiles.get('Harder VATS')?.files).toEqual([]);
      });

      it('answers the meta of a mod folder the mod order does not list, beside the listed ones', async () => {
        const { folderMeta } = await adapter.reading();

        expect([...folderMeta.keys()]).toContain('DragIn Manual Extract');
        expect(folderMeta.get('Unofficial Fallout 4 Patch')).toEqual({
          version: '2.1.5.0', nexusId: '4598', archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
        });
      });

      it('answers the source mods and the archives the game folder holds', async () => {
        const reading = await adapter.reading();

        expect([...reading.sourceMods.folders]).toEqual([]);
        expect(reading.archiveList).toEqual([]);
        expect(reading.dataFolderArchives).toEqual({ kind: 'unresolved' });
      });

      it('reads the settings once, so one reading holds one generation of the ini', async () => {
        let reads = 0;
        const counting = { ...source, settings: () => { reads++; return source.settings(); } };

        await readInstance(counting);

        expect(reads).toBe(1);
      });

      it('answers every fact against the ini as it read it, even when the ini is rewritten mid-reading', async () => {
        const rewriting = {
          ...source,
          settings: async () => {
            const settings = await source.settings();
            await writeFile(join(root, INI), (await text(root, INI)).replace('gameName=Fallout 4', 'gameName=Rewritten'));
            return settings;
          },
        };

        const reading = await readInstance(rewriting);

        expect(reading.gameName).toBe('Fallout 4');
        expect((await adapter.reading()).gameName).toBe('Rewritten');
      });

      it('hands over a link in mods/ it cannot follow, by name', async () => {
        await symlink(join(root, 'nowhere'), join(root, 'mods', 'Dangling'));

        expect([...(await adapter.reading()).skippedLinks.keys()]).toEqual(['Dangling']);
      });

      it('reads each listed mod\'s meta once, so one reading holds one answer for it', async () => {
        const reads: string[] = [];
        const counting = { ...source, modMeta: (mod: string) => { reads.push(mod); return source.modMeta(mod); } };

        const reading = await readInstance(counting);

        const listed = reading.mods.filter((e) => e.kind === 'mod').map((e) => e.name);
        expect(reads.filter((mod) => listed.includes(mod)).sort()).toEqual([...listed].sort());
      });

      it('does not read the meta of a folder the mod order does not list while the downloads are unresolved, so an unreadable one does not fail the reading', async () => {
        await mkdir(join(root, 'mods', 'Unlisted'));
        const unreadable = {
          ...source,
          settings: async () => ({
            ...(await source.settings()),
            downloadedFiles: () => Promise.resolve({ kind: 'unresolved' as const, reason: 'no downloads' }),
          }),
          modMeta: (mod: string) => (mod === 'Unlisted' ? Promise.reject(new Error('EACCES')) : source.modMeta(mod)),
        };

        await expect(readInstance(unreadable)).resolves.toMatchObject({ downloadedFiles: { kind: 'unresolved' } });
      });

      it('answers the game folder as not found, with its Data folder unresolved, when no game folder is found', async () => {
        const reading = await adapter.reading();

        expect(reading.gameFolder.kind).toBe('notFound');
        expect(reading.dataFolderPlugins).toEqual({ kind: 'unresolved' });
        expect(reading.creationClubList).toEqual([]);
      });

      it('reads a mod order that parses to no entries again after a settle, believing the second read', async () => {
        const path = join(root, DEFAULT_MODLIST);
        const complete = await text(root, DEFAULT_MODLIST);
        await writeFile(path, '');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const reading = adapter.reading();
          await settleWaitArmed();
          await writeFile(path, complete);
          await vi.advanceTimersByTimeAsync(1000);

          const mods = (await reading).mods;
          expect(mods.length).toBeGreaterThan(0);
          expect(mods.map((e) => e.name)).toEqual((await source.modOrder('Default')).map((e) => e.name));
        } finally {
          vi.useRealTimers();
        }
      });

      it('believes a mod order that is still empty after the settle', async () => {
        await writeFile(join(root, DEFAULT_MODLIST), '');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const reading = adapter.reading();
          await settleWaitArmed();
          await vi.advanceTimersByTimeAsync(1000);

          expect((await reading).mods).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('names MO2 and the file it keeps mod order in', () => {
      expect(adapter.names).toEqual({ manager: 'MO2', modOrderFile: 'modlist.txt', downloadMetadataFile: '.meta' });
    });

    it('answers no release for a game the tables hold none for, not one guessed from the name, which has the backend answer about another game', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Morrowind\r\nselected_profile=@ByteArray(Default)\r\n');

      const settings = await source.settings();

      expect(settings.gameName).toBe('Morrowind');
      expect(settings.gameRelease).toBeUndefined();
    });

    it('rejects when the settings name no game', async () => {
      await writeFile(join(root, INI), '[General]\r\nselected_profile=@ByteArray(Default)\r\n');

      await expect(source.settings()).rejects.toThrow(/gameName/);
    });

    it('rejects when the settings name no selected profile', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\n');

      await expect(source.settings()).rejects.toThrow(/selected_profile/);
    });

    it('finds the game folder the setting names', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-game-'));
      try {
        await mkdir(join(game, 'Data'));

        const folder = await (await sourceAt(root, game).settings()).gameFolder();

        expect(folder).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('answers each place it looked when no game folder is found', async () => {
      const folder = await (await source.settings()).gameFolder();

      expect(folder.kind).toBe('notFound');
    });

    it('lists the downloaded files with their metadata parsed, and no metadata file as a file of its own', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await mkdir(join(root, 'downloads', 'a folder'));
      await writeFile(tempWritePath(join(root, 'downloads', 'manual.zip.meta')), 'half');

      const downloads = await (await source.settings()).downloadedFiles();

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

      const downloads = await (await source.settings()).downloadedFiles();

      if (downloads.kind !== 'listed') throw new Error(`expected listed, got ${downloads.reason}`);
      expect(downloads.files?.find((file) => file.name === 'manual.zip')?.meta).toMatchObject({ status: 'Downloaded' });
    });

    it('answers no files, rather than none, when the downloads folder is not there', async () => {
      await rm(join(root, 'downloads'), { recursive: true });

      expect(await (await source.settings()).downloadedFiles())
        .toEqual({ kind: 'listed', downloadsDir: join(root, 'downloads'), files: undefined });
    });

    it('answers where the downloads are from the same read the profile came from, so a rewrite between two answers does not land two generations in one value', async () => {
      const settings = await source.settings();
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n'
        + '[Settings]\r\ndownload_directory=@ByteArray(elsewhere)\r\n');

      const downloads = await settings.downloadedFiles();

      expect(downloads).toMatchObject({ kind: 'listed', downloadsDir: join(root, 'downloads') });
    });

    it('answers every profile, and no stray file beside them', async () => {
      await writeFile(join(root, 'profiles', 'stray.txt'), '');

      expect((await source.profiles()).sort()).toEqual(['Default', 'Secondary']);
    });

    it('answers no profiles when the instance has none', async () => {
      await rm(join(root, 'profiles'), { recursive: true });

      expect(await source.profiles()).toEqual([]);
    });

    it('answers the mods and separators in mod order, winning end first', async () => {
      const order = await source.modOrder('Default');

      expect(modNames(order).slice(0, 4)).toEqual([
        "mod:Ñoño's Retexture:true",
        'mod:Tracked Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
      ]);
    });

    it('rejects a profile with no mod order to read', async () => {
      await expect(source.modOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    it('answers a mod\'s meta', async () => {
      expect(await source.modMeta('Unofficial Fallout 4 Patch')).toMatchObject({
        version: '2.1.5.0',
        nexusId: '4598',
        archiveFilename: DOWNLOAD,
      });
    });

    it('answers an empty meta for a mod with none', async () => {
      expect(await source.modMeta('DragIn Manual Extract')).toEqual({});
    });

    it('rejects a meta that is there but cannot be read, not publishing an unreadable meta as an empty one', async () => {
      await mkdir(join(root, 'mods', 'DragIn Manual Extract', 'meta.ini'));

      await expect(source.modMeta('DragIn Manual Extract')).rejects.toThrow(/EISDIR/);
    });

    it('answers every mod folder as the entry it holds, with its path', async () => {
      const folders = (await source.modFolders())?.all;

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

      expect((await source.modFolders())?.all.map((f) => f.name)).not.toContain('Overwrite');
    });

    describe('a folder an install is extracting into', () => {
      const listed = async (): Promise<string[]> => present(await source.modFolders(), 'the mod folders').all.map((f) => f.name);

      it('is not listed while only its extraction is in it', async () => {
        const { settle } = await installHeld(root, { kind: 'new', name: 'New Mod' });

        expect(await listed()).not.toContain('New Mod');
        await settle();
      });

      it('is listed once the extraction is gone', async () => {
        const { extraction, settle } = await installHeld(root, { kind: 'new', name: 'New Mod' });
        await rm(extraction, { recursive: true });

        expect(await listed()).toContain('New Mod');
        await settle();
      });

      it('is not listed mid-settle, with some of its entries moved up and its extraction still there', async () => {
        const { settle } = await installHeld(root, { kind: 'new', name: 'New Mod' });
        await writeFile(join(root, 'mods', 'New Mod', 'readme.txt'), '');

        expect(await listed()).not.toContain('New Mod');
        await settle();
      });

      it('is listed when it is an installed mod being upgraded', async () => {
        const { settle } = await installHeld(root, { kind: 'upgrade', name: 'Harder VATS' });

        expect(await listed()).toContain('Harder VATS');
        await settle();
      });

      it('is listed when an upgrade has cleared the mod\'s old contents and holds only its extraction', async () => {
        const { extraction, settle } = await installHeld(root, { kind: 'upgrade', name: 'Harder VATS' });
        const folder = join(root, 'mods', 'Harder VATS');
        const outsideTheExtraction = (await readdir(folder)).filter((entry) => join(folder, entry) !== extraction);
        await Promise.all(outsideTheExtraction.map((entry) => rm(join(folder, entry), { recursive: true })));

        expect(await listed()).toContain('Harder VATS');
        await settle();
      });
    });

    it('rejects when a mod folder cannot be read, rather than treating it as gone', async () => {
      const folder = join(root, 'mods', 'Harder VATS');
      vi.mocked(readdir).mockImplementation(async (path, options) => {
        if (String(path) === folder) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return actualReaddir(path, options);
      });

      await expect(source.modFolders()).rejects.toThrow(/permission denied/);
    });

    it('answers which mod folder holds an entry, matched as MO2 matches names, from the one listing', async () => {
      const folders = present(await source.modFolders(), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'harder vats' })?.path).toBe(join(root, 'mods', 'Harder VATS'));
      expect(folders.holding({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers each of two folders whose names differ only in case for the entry spelled as its own', async () => {
      await mkdir(join(root, 'mods', 'ModA'));
      await mkdir(join(root, 'mods', 'moda'));
      const folders = present(await source.modFolders(), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'moda' })?.path).toBe(join(root, 'mods', 'moda'));
      expect(folders.holding({ kind: 'mod', name: 'ModA' })?.path).toBe(join(root, 'mods', 'ModA'));
          });

    it('hands over a link it cannot follow rather than answering it as a folder', async () => {
      await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));
      const skipped: string[] = [];

      const folders = await source.modFolders((name) => skipped.push(name));

      expect(folders?.all.map((f) => f.name)).not.toContain('Loop');
      expect(skipped).toEqual(['Loop']);
    });

    it('answers undefined when there is no folder for mods at all', async () => {
      await rm(join(root, 'mods'), { recursive: true });

      expect(await source.modFolders()).toBeUndefined();
    });

    it('rejects when mods/ is there but cannot be listed, only its absence meaning there is no folder for mods', async () => {
      await rm(join(root, 'mods'), { recursive: true });
      await writeFile(join(root, 'mods'), 'not a directory');

      await expect(source.modFolders()).rejects.toThrow();
    });

    it('answers the plugins in plugin order, with their enabled state', async () => {
      expect(await source.pluginOrder('Default')).toEqual([
        { name: 'NonAsciiRetexture.esp', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: true },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
      ]);
    });

    it('rejects a profile with no plugin order to read', async () => {
      await expect(source.pluginOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
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

        const plugins = await source.gameFolderPlugins(found(data));

        expect(plugins).toEqual({ kind: 'listed', names: new Set(['Fallout4.ESM', 'Patch.esp']) });
      });

      it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers both of two files whose names differ only in case', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(data, 'Foo.esp'), '');
        await writeFile(join(data, 'foo.esp'), '');

        expect(await source.gameFolderPlugins(found(data))).toEqual({ kind: 'listed', names: new Set(['Foo.esp', 'foo.esp']) });
      });

      it('answers unresolved when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await source.gameFolderPlugins(notFound)).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when the Data folder cannot be listed', async () => {
        const plugins = await source.gameFolderPlugins(found(join(game, 'Missing')));

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

        expect(await source.creationClubList(found(), 'Fallout4'))
          .toEqual(['ccBGSFO4044-HellfirePowerArmor.esl', 'ccBGSFO4001-PipBoy(Black).esl']);
      });

      it('answers none when the game folder holds no list', async () => {
        expect(await source.creationClubList(found(), 'Fallout4')).toEqual([]);
      });

      it('answers none for a release with no Creation Club', async () => {
        await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\n');

        expect(await source.creationClubList(found(), 'Oblivion')).toEqual([]);
      });

      it('answers none when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await source.creationClubList(notFound, 'Fallout4')).toEqual([]);
      });
    });

    describe('the archives the game\'s INIs list, where Mod Management takes the archives the game loads from', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-ini-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (): GameFolder => ({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
      const profileFile = (name: string): string => join(root, 'profiles', 'Default', name);
      const localSettings = (on: boolean): Promise<void> => writeFile(profileFile('settings.ini'), `[General]\nLocalSettings=${on}\n`);

      it('lists the default INI\'s archives key by key, in the order the release loads its keys, whatever the case of section, key or file', async () => {
        await writeFile(join(game, 'fallout4_default.ini'), [
          '[Display]', 'sResourceArchiveList=Not An Archive.ba2',
          '[archive]', 'SResourceArchiveList=Fallout4 - Voices.ba2, Fallout4 - Meshes.ba2',
          '; sResourceArchiveList2=Commented.ba2', 'sResourceStartUpArchiveList=Fallout4 - Startup.ba2,Fallout4 - Interface.ba2,',
        ].join('\r\n'));

        expect((await source.archiveList('Default', found(), 'Fallout4')).archives)
          .toEqual(['Fallout4 - Startup.ba2', 'Fallout4 - Interface.ba2', 'Fallout4 - Voices.ba2', 'Fallout4 - Meshes.ba2']);
      });

      it('lists the default INI\'s archives and notes the profile by name, when it keeps no game INIs and the My Games folder is nowhere', async () => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');
        await localSettings(false);

        const { archives, notes } = await source.archiveList('Default', found(), 'Fallout4');

        expect(archives).toEqual(['Default.ba2']);
        expect(notes).toEqual([expect.stringMatching(/^The profile Default keeps no game INIs of its own/)]);
      });

      describe('while the profile keeps no game INIs of its own', () => {
        let documents: string;
        let myGames: string;
        let myGamesSource: ReadingSource;

        beforeEach(async () => {
          const prefix = join(game, 'pfx');
          documents = join(prefix, 'drive_c', 'users', 'steamuser', 'Documents');
          myGames = join(documents, 'My Games', 'Fallout4');
          await mkdir(myGames, { recursive: true });
          myGamesSource = readingSource(contextOver(root, {
            detectors: { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix), documents: () => Promise.resolve(documents) },
          }));
          await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
          await localSettings(false);
        });

        it('takes a key the My Games INIs give over the default INI\'s, the custom INI\'s over the main one\'s, with no warning', async () => {
          await writeFile(join(myGames, 'Fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
          await writeFile(join(myGames, 'Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');

          expect(await myGamesSource.archiveList('Default', found(), 'Fallout4')).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
        });

        it('reads none of the profile\'s INIs', async () => {
          await writeFile(profileFile('Fallout4.ini'), '[Archive]\nsResourceArchiveList=Left Behind.ba2\n');

          expect((await myGamesSource.archiveList('Default', found(), 'Fallout4')).archives).toEqual(['Default.ba2', 'Default2.ba2']);
        });
      });

      it('takes a key the profile\'s own INIs give over the default INI\'s, the custom INI\'s over the main one\'s, when the profile keeps its own', async () => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
        await writeFile(profileFile('fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
        await writeFile(profileFile('Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');
        await localSettings(true);

        expect(await source.archiveList('Default', found(), 'Fallout4')).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
      });

      it('reads none of the profile\'s INIs while the profile keeps no game INIs of its own', async () => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');
        await writeFile(profileFile('Fallout4.ini'), '[Archive]\nsResourceArchiveList=Left Behind.ba2\n');
        await localSettings(false);

        expect((await source.archiveList('Default', found(), 'Fallout4')).archives).toEqual(['Default.ba2']);
      });

      it.each([
        ['the game folder was not found', (): GameFolder => ({ kind: 'notFound', looked: [], setting: 'setting' }), 'Fallout4'],
        ['the release has no row', found, undefined],
      ])('lists none when %s', async (_why, gameFolder, release) => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');

        expect((await source.archiveList('Default', gameFolder(), release)).archives).toEqual([]);
      });

      it('lists after the INIs\' archives the ones the release loads whatever they list', async () => {
        await writeFile(join(game, 'Fallout_default.ini'), '[Archive]\nSArchiveList=Fallout - Textures.bsa, Fallout - Meshes.bsa\n');

        expect((await source.archiveList('Default', found(), 'FalloutNV')).archives)
          .toEqual(['Fallout - Textures.bsa', 'Fallout - Meshes.bsa', 'Update.bsa']);
      });
    });

    describe('the game folder\'s archives and strings files', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-archives-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (): GameFolder => ({ kind: 'found', root: game, dataFolder: join(game, 'Data') });

      it('answers the release\'s archives at the Data folder\'s root and the strings files in its strings folder, by their paths in it', async () => {
        const data = join(game, 'Data');
        await mkdir(join(data, 'STRINGS'), { recursive: true });
        await mkdir(join(data, 'Nested.ba2'), { recursive: true });
        await writeFile(join(data, 'Fallout4 - Interface.BA2'), '');
        await writeFile(join(data, 'Skyrim - Interface.bsa'), '');
        await writeFile(join(data, 'STRINGS', 'Fallout4_en.STRINGS'), '');
        await writeFile(join(data, 'STRINGS', 'readme.txt'), '');

        expect(await source.gameFolderArchives(found(), 'Fallout4')).toEqual({
          kind: 'listed', archives: ['Fallout4 - Interface.BA2'], stringsFiles: ['STRINGS/Fallout4_en.STRINGS'],
        });
      });

      it('answers unresolved when the game folder was not found', async () => {
        expect(await source.gameFolderArchives({ kind: 'notFound', looked: [], setting: 'setting' }, 'Fallout4')).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when its Data folder cannot be listed', async () => {
        expect(await source.gameFolderArchives(found(), 'Fallout4'))
          .toEqual({ kind: 'unreadable', reason: expect.stringMatching(/ENOENT/) as unknown });
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

    it('hears a repository appear at, or vanish from, the instance root', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });
      const entry = live().find((w) => w.base === root && matchesGlob('.git', w.pattern));

      entry?.fireCreate(join(root, '.git'));
      entry?.fireDelete(join(root, '.git'));

      expect(signals).toBe(2);
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

    it('signals a change to every profile\'s two order files and its INIs, the settings, a mod\'s files, a mod\'s source and overwrite', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });

      const watchedPaths = [
        'profiles/Default/modlist.txt', 'profiles/Secondary/plugins.txt', 'ModOrganizer.ini',
        'mods/Harder VATS/Textures/a.dds', 'source/Harder VATS/plugin-source/Harder VATS.esp/a.json', 'overwrite/F4SE/Plugins/x.ini',
        'profiles/Default/settings.ini', 'profiles/Default/fallout4.INI',
      ];
      const pathsHeardByNoWatcher = watchedPaths.filter((relative) => !fire(root, relative));
      expect(pathsHeardByNoWatcher).toEqual([]);
      expect(fire(root, 'profiles/Default/other.txt')).toBe(false);
      expect(signals).toBe(8);
    });

    it.each(['HEAD', 'refs/heads/main', 'packed-refs', ''])(
      'hears .git/%s in a mod\'s repository', (inside) => {
        let signals = 0;
        adapterAt(root).subscribe(() => { signals++; });

        expect(fire(root, join('source/Harder VATS/.git', inside), join('source/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(1);
      });

    it('tells a ref from git\'s bookkeeping in a Windows path', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });
      const source = live().find((w) => w.base === root && matchesGlob('source/A/x.json', w.pattern));

      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\index');
      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\refs\\heads\\main');

      expect(signals).toBe(1);
    });

    it.each(['index', 'objects/ab/cdef', 'logs/HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'HEAD.lock'])(
      'hears nothing of .git/%s in a mod\'s repository, git\'s own bookkeeping not reading as a change', (inside) => {
        let signals = 0;
        adapterAt(root).subscribe(() => { signals++; });

        expect(fire(root, join('source/Harder VATS/.git', inside), join('source/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(0);
      });

    it('hears git\'s bookkeeping in a .git a mod\'s folder holds, which is the mod\'s content', () => {
      let signals = 0;
      adapterAt(root).subscribe(() => { signals++; });

      expect(fire(root, 'mods/Harder VATS/.git/index', 'mods/Harder VATS/git/index')).toBe(true);
      expect(signals).toBe(1);
    });

    it('follows the downloads folder the last read of the settings resolved, signalling once when it moves, not the one where the instance began, so a download landing in the folder the settings name now is heard', async () => {
      let signals = 0;
      const watched = watchedOver(contextOver(root));
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
        const watched = watchedOver(contextOver(root, { gameDirectory: game }));
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
        const watched = watchedOver(contextOver(root, { gameDirectory: game }));
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        expect(fire(game, 'Fallout4.ccc')).toBe(true);
        expect(fire(game, 'Fallout4.ini')).toBe(false);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('follows the release\'s default INI, and the archives and strings files of the Data folder, in any case, once read', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-archives-'));
      try {
        const found: GameFolder = { kind: 'found', root: game, dataFolder: join(game, 'Data') };
        const watched = watchedOver(contextOver(root));
        watched.subscribe(() => undefined);

        await watched.archiveList('Default', found, 'Fallout4');
        await watched.gameFolderArchives(found, 'Fallout4');

        expect(fire(game, 'fallout4_default.INI')).toBe(true);
        expect(fire(game, 'Fallout4Prefs.ini')).toBe(false);
        const heardByNoWatcher = ['Fallout4 - Interface.BA2', 'Strings/Fallout4_en.STRINGS'].filter((name) => !fire(join(game, 'Data'), name));
        expect(heardByNoWatcher).toEqual([]);
        expect(fire(join(game, 'Data'), 'Skyrim - Interface.bsa')).toBe(false);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('follows the game\'s INIs in the My Games folder, in any case, while the profile keeps none of its own', async () => {
      const prefix = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-my-games-'));
      try {
        const documents = join(prefix, 'drive_c', 'users', 'steamuser', 'Documents');
        const myGames = join(documents, 'My Games', 'Fallout4');
        await mkdir(myGames, { recursive: true });
        const found: GameFolder = { kind: 'found', root: prefix, dataFolder: join(prefix, 'Data') };
        const watched = watchedOver(contextOver(root, {
          detectors: { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix), documents: () => Promise.resolve(documents) },
        }));
        watched.subscribe(() => undefined);

        await watched.archiveList('Default', found, 'Fallout4');

        expect(fire(myGames, 'FALLOUT4CUSTOM.ini')).toBe(true);
        expect(fire(myGames, 'Fallout4Prefs.ini')).toBe(false);
      } finally {
        await rm(prefix, { recursive: true, force: true });
      }
    });

    it('follows no game folder when none is found', async () => {
      const watched = watchedOver(contextOver(root));
      watched.subscribe(() => undefined);
      const before = live().length;

      await (await watched.settings()).gameFolder();

      expect(live()).toHaveLength(before);
    });
  });

  describe('get in mods/', () => {
    it('answers the folder that holds an entry, matched as MO2 matches names, or none', async () => {
      const harderVats = { kind: 'mod', name: 'Harder VATS', path: join(root, 'mods', 'Harder VATS') };
      const folders = present((await adapter.reading()).modFolders, 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'Harder VATS' })).toEqual(harderVats);
      expect(folders.holding({ kind: 'mod', name: 'harder vats' })).toEqual(harderVats);
      expect(folders.holding({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
      expect(folders.holding({ kind: 'separator', name: 'Harder VATS' })).toBeUndefined();
    });

    it('answers the folder a mod builds into: the one that holds it, matched as MO2 matches names, else the one its name gives it', async () => {
      expect(await adapter.modFolderPath('harder vats')).toBe(join(root, 'mods', 'Harder VATS'));
      expect(await adapter.modFolderPath('Cloned Mod')).toBe(join(root, 'mods', 'Cloned Mod'));
      expect(await adapter.modFolderPath('Mods/Cloned Mod')).toBeUndefined();
    });

    it('answers a mod named as a separator\'s folder with that separator\'s folder, MO2 knowing a mod by its folder\'s name and a folder named for a separator holding that separator', async () => {
      expect((await adapter.reading()).modFolders?.holding({ kind: 'mod', name: 'unassigned (modlist development)_SEPARATOR' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    it('finds a separator\'s folder by the name MO2 would give it, so a name asked for loosely finds it too', async () => {
      expect((await adapter.reading()).modFolders?.holding({ kind: 'separator', name: '  unassigned  (Modlist Development)..' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    describe('an origin\'s files', () => {
      const mod = (name: string) => ({ kind: 'mod' as const, name });
      const relativePaths = (files: readonly { relativePath: string }[]): string[] => files.map((f) => f.relativePath).sort();

      it('walks a mod\'s folder, leaving out its metadata and writes in flight', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Textures', 'Source'), { recursive: true });
        await writeFile(join(folder, 'Textures', 'a.dds'), '');
        await writeFile(join(folder, 'Textures', 'Source', 'kept.psc'), '');
        await writeFile(tempWritePath(join(folder, 'Textures', 'b.dds')), '');

        const files = await source.originFiles(mod('Harder VATS'));

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

        const files = await source.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'Linked.esp'))
          .toEqual({ relativePath: 'Linked.esp', path: join(folder, 'Linked.esp'), sourcePath: await realpath(target), excluded: false, excludedByName: false });
        expect(relativePaths(files.files)).not.toContain('Broken.esp');
        expect(files.notes.join('\n')).toMatch(/Broken\.esp/);
      });

      it('walks a dot entry, a .git and a root plugin-source folder as any other content, as MO2 deploys them', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, '.git'), { recursive: true });
        await writeFile(join(folder, '.git', 'HEAD'), '');
        await writeFile(join(folder, '.gitignore'), '*\n');
        await mkdir(join(folder, 'plugin-source'), { recursive: true });
        await writeFile(join(folder, 'plugin-source', 'shipped.json'), '');

        const paths = relativePaths((await source.originFiles(mod('Harder VATS'))).files);

        expect(paths).toEqual(expect.arrayContaining(['.git/HEAD', '.gitignore', 'plugin-source/shipped.json']));
      });

      it.each([
        ['an upgrade', { kind: 'upgrade', name: 'Harder VATS' }],
        ['a new mod', { kind: 'new', name: 'New Mod' }],
      ] as const)('leaves out the extraction of %s in flight', async (_, target) => {
        const { settle } = await installHeld(root, target);

        const paths = relativePaths((await source.originFiles(mod(target.name))).files);

        expect(paths.filter((path) => path.endsWith('New.esp'))).toEqual([]);
        await settle();
      });

      it.each([
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
        ['Overwrite', { kind: 'runtimeOutput' as const }, 'overwrite'],
      ])('says which files and folders of %s are excluded: a name with the suffix in any case, and everything in such a folder', async (_, origin, folder) => {
        await mkdir(join(root, folder, 'Textures.mohidden', 'Armour'), { recursive: true });
        await writeFile(join(root, folder, 'Textures.mohidden', 'Armour', 'a.dds'), '');
        await writeFile(join(root, folder, 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, folder, 'Kept.esp'), '');

        const files = await source.originFiles(origin);
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

        const { files } = await source.originFiles(mod('Harder VATS'));
        const byNameOf = (relativePath: string) => files.find((file) => file.relativePath === relativePath)?.excludedByName;

        expect(['Textures.mohidden/a.dds', 'Textures.mohidden/b.dds.mohidden', 'Hidden.esp.MOHIDDEN', 'Kept.esp'].map(byNameOf))
          .toEqual([false, true, true, false]);
      });

      it('follows a linked folder, its files keyed beneath the link\'s own name', async () => {
        const shared = join(root, 'shared-textures');
        await mkdir(shared);
        await writeFile(join(shared, 'foo.dds'), '');
        await symlink(shared, join(root, 'mods', 'Harder VATS', 'linked'));

        const files = await source.originFiles(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'linked/foo.dds')?.path).toBe(join(root, 'mods', 'Harder VATS', 'linked', 'foo.dds'));
        expect(files.folders).toContainEqual({ relativePath: 'linked', path: join(root, 'mods', 'Harder VATS', 'linked'), excluded: false });
      });

      it('notes a link cycle and walks each file once', async () => {
        const folder = join(root, 'mods', 'Cycle');
        await mkdir(folder);
        await writeFile(join(folder, 'sibling.dds'), '');
        await symlink(folder, join(folder, 'loop'));

        const files = await source.originFiles(mod('Cycle'));

        expect(relativePaths(files.files)).toEqual(['sibling.dds']);
        expect(files.notes.join('\n')).toMatch(/cycle.*loop/);
      });

      it('rejects when a folder below an origin cannot be read, rather than listing fewer files', async () => {
        const nested = join(root, 'overwrite', 'SKSE');
        await mkdir(nested, { recursive: true });
        vi.mocked(readdir).mockImplementation(async (path, options) => {
          if (String(path) === nested) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualReaddir(path, options);
        });

        await expect(source.originFiles({ kind: 'runtimeOutput' })).rejects.toThrow(/permission denied/);
      });

      it('rejects when a link\'s target cannot be checked for a reason other than its absence, simulated through a mocked stat as chmod denies nothing when the runner is root', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await symlink(join(root, 'whatever.dds'), join(folder, 'restricted.dds'));
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('restricted.dds')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualStat(path, ...rest);
        });

        await expect(source.originFiles(mod('Harder VATS'))).rejects.toThrow(/permission denied/);
      });

      it.skipIf(process.platform === 'win32')('notes a FIFO and a link to one, and answers neither as a file, built with the POSIX mkfifo that Windows lacks', async () => {
        const folder = join(root, 'mods', 'Pipes');
        await mkdir(folder);
        execFileSync('mkfifo', [join(folder, 'pipe')]);
        execFileSync('mkfifo', [join(root, 'real-pipe')]);
        await symlink(join(root, 'real-pipe'), join(folder, 'linked-pipe'));

        const files = await source.originFiles(mod('Pipes'));

        expect(files.files).toEqual([]);
        expect(files.notes.join('\n')).toMatch(/pipe/);
        expect(files.notes.join('\n')).toMatch(/linked-pipe/);
        expect(files.notes).toHaveLength(2);
      });

      it('answers no files for a mod with no folder, or a name that gives it none', async () => {
        expect((await source.originFiles(mod('No Such Mod'))).files).toEqual([]);
        expect(await source.originFiles(mod('../profiles'))).toEqual({ origin: '../profiles', folder: undefined, files: [], folders: [], notes: [] });
      });

      it('lists everything the game wrote at run time, under the reserved origin, without writes in flight', async () => {
        const folder = join(root, 'overwrite');
        await writeFile(join(folder, 'Stray.esp'), '');
        await writeFile(tempWritePath(join(folder, 'Stray.esp')), '');

        const files = await source.originFiles({ kind: 'runtimeOutput' });

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

        const files = await source.originFiles(origin);

        expect(relativePaths(files.files)).toContain(kept);
        expect(relativePaths(files.files)).not.toContain('Gone/Lost.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Gone/)]);
      });

      it('notes a link in the overwrite folder, which it does not follow, rather than skipping it with no word and dropping its file from the picture', async () => {
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(root, 'overwrite', 'Linked.esp'));

        const files = await source.originFiles({ kind: 'runtimeOutput' });

        expect(relativePaths(files.files)).not.toContain('Linked.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Linked\.esp/)]);
      });

      it('answers no files when there is no overwrite folder', async () => {
        await rm(join(root, 'overwrite'), { recursive: true });

        expect((await source.originFiles({ kind: 'runtimeOutput' })).files).toEqual([]);
      });
    });

    describe('a mod\'s repository', () => {
      const repository = async (folder: string, buildConfiguration: string | undefined): Promise<void> => {
        await mkdir(join(root, 'source', folder, '.git'), { recursive: true });
        if (buildConfiguration !== undefined) await writeFile(join(root, 'source', folder, 'build.json'), buildConfiguration);
      };

      it('answers a mod\'s source folder beside mods/, whether or not it is there, and none for a name that reaches outside it', () => {
        expect(adapter.sourceFolder('Harder VATS')).toBe(join(root, 'source', 'Harder VATS'));
        expect(adapter.sourceFolder('No Such Mod')).toBe(join(root, 'source', 'No Such Mod'));
        expect(adapter.sourceFolder('../Harder VATS')).toBeUndefined();
      });

      it('lists every repository under the source folder by the mod its build configuration names as its output, with its folder, and no folder without a `.git`', async () => {
        await repository('Harder VATS', '{ "output": "Harder VATS" }');
        await repository('Renamed From', '{ "output": "Renamed To" }');
        await mkdir(join(root, 'source', 'No Repository'), { recursive: true });
        await writeFile(join(root, 'source', 'No Repository', 'build.json'), '{ "output": "No Repository" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Harder VATS', join(root, 'source', 'Harder VATS')], ['Renamed To', join(root, 'source', 'Renamed From')]]));
        expect(notes).toEqual([]);
      });

      it('answers the source folder that builds a mod, its name matched without case', async () => {
        await repository('Renamed From', '{ "output": "Renamed To" }');

        const sourceMods = await source.sourceMods();

        expect([sourceMods.folderOf('renamed to'), sourceMods.folderOf('Renamed From')]).toEqual([join(root, 'source', 'Renamed From'), undefined]);
      });

      it.each([
        ['no build configuration', undefined],
        ['a build configuration that is not JSON', '{ "output": '],
        ['a build configuration that names no output', '{ "exclude": [] }'],
        ['an output that is not a folder name', '{ "output": "../Elsewhere" }'],
      ])('leaves out a repository with %s, and says so', async (_, configuration) => {
        await repository('Unnamed', configuration);

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map());
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Unnamed'))]);
      });

      it('leaves out a repository whose build configuration cannot be read, says so, and lists the rest', async () => {
        await repository('Unreadable', undefined);
        await mkdir(join(root, 'source', 'Unreadable', 'build.json'));
        await repository('Readable', '{ "output": "Readable" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Readable', join(root, 'source', 'Readable')]]));
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Unreadable'))]);
      });

      it('gives an output two repositories name, matched without case, to the first by folder name, and says so', async () => {
        await repository('Second', '{ "output": "SHARED" }');
        await repository('First', '{ "output": "Shared" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Shared', join(root, 'source', 'First')]]));
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Second'))]);
      });

      it('lists none when the instance has no source folder', async () => {
        const { folders, notes } = await source.sourceMods();

        expect([folders, notes]).toEqual([new Map(), []]);
      });

      it('answers no installation file for a mod whose meta records none, and its meta as the mod manager\'s own file', async () => {
        expect(await adapter.installationFiles('DragIn Manual Extract')).toEqual({ kind: 'read', answer: [] });
        expect(adapter.managerFilesInModFolder).toEqual(['meta.ini']);
      });
    });

    describe('a mod\'s installation files', () => {
      const ENTRY = 'textures/a.dds';

      it('answers the downloaded file its meta names, in the downloads folder, with its size and hash and each entry\'s', async () => {
        const answer = await adapterAt(root, undefined, undefined, fakeArchiveReader([ENTRY])).installationFiles('Unofficial Fallout 4 Patch');

        expect(answer).toEqual({
          kind: 'read',
          answer: [{ path: join(root, 'downloads', DOWNLOAD), source: 'nexus:fallout4:4598', size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: ENTRY, hash: 'q7ZLRnu1+Os=' }] }],
        });
      });

      describe('where the metadata says the file comes from', () => {
        const FILES = '\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\n2\\modid=9\r\n2\\fileid=78\r\nsize=2\r\n';
        const sourceOf = async (general: string, installedFiles = ''): Promise<string | undefined> => {
          await writeFile(
            join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), `[General]\r\n${general}installationFile=${DOWNLOAD}\r\n${installedFiles}`,
          );
          const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');
          return answer.kind === 'read' ? answer.answer[0]?.source : undefined;
        };

        it('names no source for a game the registry has no Nexus domain for, and says which game', async () => {
          await writeFile(
            join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), `[General]\r\ngameName=EnderalSE\r\nmodid=4598\r\ninstallationFile=${DOWNLOAD}\r\n`,
          );

          const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');

          const file = answer.kind === 'read' ? answer.answer[0] : undefined;
          expect([file?.source, file?.unsourcedGame]).toEqual([undefined, 'EnderalSE']);
        });

        it.each([
          ['names the Nexus domain of MO2\'s short name for the game, the mod and each file installed', 'gameName=SkyrimSE\r\nmodid=4598\r\n', FILES, 'nexus:skyrimspecialedition:4598;4598:77;9:78'],
          ['keeps the mod id when files are recorded', 'gameName=Fallout4\r\nmodid=4598\r\n', FILES, 'nexus:fallout4:4598;4598:77;9:78'],
          ['keeps the files of a mod whose id is blank', 'gameName=Fallout4\r\n', FILES, 'nexus:fallout4:;4598:77;9:78'],
          ['names the mod when no file is recorded', 'gameName=Fallout4\r\nmodid=4598\r\n', '', 'nexus:fallout4:4598'],
          ['takes the instance\'s game for a mod with none, as MO2 does', 'modid=4598\r\n', '', 'nexus:fallout4:4598'],
          ['reads the game as the instance\'s settings spell it', 'gameName=Fallout 4\r\nmodid=4598\r\n', '', 'nexus:fallout4:4598'],
          ['names nothing for a mod with no Nexus id', 'gameName=Fallout4\r\n', '', undefined],
          ['names nothing for MO2\'s default id', 'gameName=Fallout4\r\nmodid=-1\r\n', '', undefined],
        ])('%s', async (_name, general, installedFiles, expected) => {
          expect(await sourceOf(general, installedFiles)).toBe(expected);
        });
      });

      describe('its metadata as facts', () => {
        const metadataOf = async (mod: string): Promise<unknown> => {
          const answer = await adapter.modMetadata(mod);
          return answer.kind === 'read' ? answer.answer : answer;
        };
        const metaOf = (mod: string): string => join(root, 'mods', mod, 'meta.ini');
        const NEXUS = 'nexus:fallout4:4598;4598:77';
        const patchMeta = (general: string): Promise<void> => writeFile(
          metaOf('Unofficial Fallout 4 Patch'),
          `[General]\r\ngameName=Fallout4\r\nmodid=4598\r\nversion=2.1.5.0\r\ncomments=mine\r\ncolor=@Variant(\\0\\0\\0\\x43\\x1\\xff\\xff\\0\\0\\0\\0\\0\\0\\0\\0)\r\n${general}`,
        );

        it('answers the version, and each installation file by its name with where it comes from', async () => {
          await patchMeta(`installationFile=${DOWNLOAD}\r\n\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\nsize=1\r\n`);

          expect(await metadataOf('Unofficial Fallout 4 Patch'))
            .toEqual({ version: '2.1.5.0', installationFiles: [{ name: DOWNLOAD, source: NEXUS }] });
        });

        it('names an installation file recorded by its whole path by its name', async () => {
          await patchMeta('installationFile=/elsewhere/Patch.7z\r\n');

          expect(await metadataOf('Unofficial Fallout 4 Patch')).toMatchObject({ installationFiles: [{ name: 'Patch.7z' }] });
        });

        it('answers none for a mod with no metadata, and no version when it says none', async () => {
          expect(await metadataOf('A mod with no folder')).toEqual({ installationFiles: [] });
          expect(await metadataOf('ENBoost - 12k')).toMatchObject({ version: undefined });
        });

        it('answers unreadable, naming why, for metadata that cannot be read', async () => {
          await rm(metaOf('Unofficial Fallout 4 Patch'));
          await mkdir(metaOf('Unofficial Fallout 4 Patch'));

          const answer = await adapter.modMetadata('Unofficial Fallout 4 Patch');
          expect(answer.kind === 'unreadable' && answer.reason).toContain('EISDIR');
        });

        it('writes the version, the installation file and where it comes from, and keeps every other key', async () => {
          await patchMeta('');

          await adapter.writeModMetadata('Unofficial Fallout 4 Patch', {
            version: '3.0', installationFiles: [{ name: 'Patch-3.7z', source: 'nexus:skyrimspecialedition:12;12:99' }],
          });

          const text = await readFile(metaOf('Unofficial Fallout 4 Patch'), 'utf8');
          expect(text).toContain('version=3.0');
          expect(text).toContain('installationFile=Patch-3.7z');
          expect(text).toContain('gameName=SkyrimSE');
          expect(text).toContain('modid=12');
          expect(text).toContain('1\\fileid=99');
          expect(text).toContain('comments=mine');
          expect(text).toContain('color=@Variant');
        });

        it('keeps the values the manifest lacks', async () => {
          await patchMeta(`installationFile=${DOWNLOAD}\r\n`);

          await adapter.writeModMetadata('Unofficial Fallout 4 Patch', { version: '3.0', installationFiles: [] });
          await adapter.writeModMetadata('Unofficial Fallout 4 Patch', { installationFiles: [{ name: 'Patch-3.7z' }] });

          expect(await metadataOf('Unofficial Fallout 4 Patch'))
            .toEqual({ version: '3.0', installationFiles: [{ name: 'Patch-3.7z', source: 'nexus:fallout4:4598' }] });
        });

        it('writes the instance\'s own spelling of its game for a domain the instance\'s game has', async () => {
          await writeFile(join(root, INI), (await readFile(join(root, INI), 'utf8')).replace(/gameName=.*/, 'gameName=Fallout 4 VR'));
          await patchMeta('');

          await adapter.writeModMetadata('Unofficial Fallout 4 Patch', { installationFiles: [{ name: 'P.7z', source: 'nexus:fallout4:1' }] });

          expect(await readFile(metaOf('Unofficial Fallout 4 Patch'), 'utf8')).toContain('gameName=Fallout 4 VR');
        });

        it('writes nothing for metadata that says nothing', async () => {
          await adapter.writeModMetadata('Brand New', { installationFiles: [] });

          await expect(access(metaOf('Brand New'))).rejects.toThrow();
        });

        it('makes the metadata of a mod with none, in its folder', async () => {
          await adapter.writeModMetadata('Brand New', { version: '1.0', installationFiles: [] });

          expect(await readFile(metaOf('Brand New'), 'utf8')).toContain('version=1.0');
        });

        it('rejects, writing nothing, a source naming a Nexus domain with no game', async () => {
          await patchMeta('');
          const before = await readFile(metaOf('Unofficial Fallout 4 Patch'), 'utf8');

          await expect(adapter.writeModMetadata('Unofficial Fallout 4 Patch', {
            version: '9', installationFiles: [{ name: 'P.7z', source: 'nexus:nowhere:1' }],
          })).rejects.toBeInstanceOf(MetadataNotWritable);

          expect(await readFile(metaOf('Unofficial Fallout 4 Patch'), 'utf8')).toBe(before);
        });

        it('reads back as what it was handed', async () => {
          const written = { version: '3.0', installationFiles: [{ name: 'Patch-3.7z', source: 'nexus:newvegas:5;5:6;7:8' }] };

          await adapter.writeModMetadata('Brand New', written);

          expect(await metadataOf('Brand New')).toEqual(written);
        });
      });

      describe('installed from a file outside the downloads folder, which MO2 records by its whole path', () => {
        const recordingInstalledFrom = (path: string): Promise<void> =>
          writeFile(join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), `[General]\r\ninstallationFile=${path}\r\n`);

        it('answers that file while it is there', async () => {
          const elsewhere = join(root, 'elsewhere', 'Patch.7z');
          await mkdir(join(root, 'elsewhere'));
          await writeFile(elsewhere, 'hello');
          await recordingInstalledFrom(elsewhere);

          const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');

          expect(answer).toEqual({ kind: 'read', answer: [{ path: elsewhere, size: 5, hash: 'o22fiH2CxyY=', entries: [] }] });
        });

        it('answers the file of its name in the downloads folder once it is gone, as MO2 reinstalls it', async () => {
          await recordingInstalledFrom(join(root, 'elsewhere', DOWNLOAD));

          const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');

          expect(answer).toEqual({ kind: 'read', answer: [{ path: join(root, 'downloads', DOWNLOAD), size: 28, hash: 'yMPjZVarjmw=', entries: [] }] });
        });
      });

      it('answers unreadable, naming the downloaded file and why, when it is gone', async () => {
        await rm(join(root, 'downloads', DOWNLOAD));

        const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');

        expect(answer.kind === 'unreadable' && answer.reason).toContain('ENOENT');
        expect(answer.kind === 'unreadable' && answer.reason).toContain(DOWNLOAD);
      });

      it('answers unreadable, naming the downloaded file and why, when the downloads folder cannot be resolved', async () => {
        await rm(join(root, INI));

        const answer = await adapter.installationFiles('Unofficial Fallout 4 Patch');

        expect(answer.kind === 'unreadable' && answer.reason).toContain(DOWNLOAD);
        expect(answer.kind === 'unreadable' && answer.reason).toContain(INI);
      });
    });

    describe('a downloaded file by its name', () => {
      it('answers the file of that name in the downloads folder, with its size and hash and each entry\'s', async () => {
        const answer = await adapterAt(root, undefined, undefined, fakeArchiveReader(['textures/a.dds'])).downloadedFile(DOWNLOAD);

        expect(answer).toEqual({
          kind: 'read', answer: { path: join(root, 'downloads', DOWNLOAD), size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: 'textures/a.dds', hash: 'q7ZLRnu1+Os=' }] },
        });
      });

      it('answers none when the downloads folder holds no file of that name', async () => {
        expect(await adapter.downloadedFile('Gone.7z')).toEqual({ kind: 'read', answer: undefined });
      });

      it.each(['../Outside.7z', '..'])('answers none for %s, which is no bare file name, reading nothing outside the downloads folder', async (name) => {
        await writeFile(join(root, 'Outside.7z'), 'hello');

        expect(await adapter.downloadedFile(name)).toEqual({ kind: 'read', answer: undefined });
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

    it.each(['mod', 'separator'] as const)('trashes no folder outside mods/ for a %s line another tool wrote with a / in its name', async (kind) => {
      await mkdir(join(root, 'Escaped'));
      const trashed: string[] = [];

      expect(await adapter.trashEntryFolder({ kind, name: '../Escaped' }, (path) => {
        trashed.push(path);
        return Promise.resolve();
      })).toBe(false);

      expect(trashed).toEqual([]);
    });
  });

  it('moves to the trash the repository whose build configuration names the mod, and answers false when none does', async () => {
    const trashed: string[] = [];
    const trash = (path: string): Promise<void> => {
      trashed.push(path);
      return Promise.resolve();
    };
    await mkdir(join(root, 'source', 'Renamed From', '.git'), { recursive: true });
    await writeFile(join(root, 'source', 'Renamed From', 'build.json'), '{ "output": "Harder VATS" }');
    await mkdir(join(root, 'source', 'Unofficial Fallout 4 Patch'), { recursive: true });

    expect(await adapter.trashSourceFolder('Harder VATS', trash)).toBe(true);
    expect(await adapter.trashSourceFolder('Unofficial Fallout 4 Patch', trash)).toBe(false);

    expect(trashed).toEqual([join(root, 'source', 'Renamed From')]);
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
    ])('renames %s file with the suffix it answers for an excluded name, and back', async (_, origin, folder) => {
      await put(join(root, folder, 'Textures', 'a.dds'), 'pixels');

      expect(await adapter.markOriginFile(origin, 'Textures/a.dds', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'Textures/a.dds.mohidden' });
      expect(adapter.excludedSuffix).toBe('.mohidden');
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

    it.each([
      ['a.dds', 'a.dds'],
      ['Textures/a.dds.mohidden', 'Textures/a.dds'],
      ['Textures.mohidden/a.dds.MOHIDDEN', 'Textures/a.dds'],
      ['Textures.mohidden', 'Textures'],
    ])('answers the path %s has when nothing excludes it: %s', (relativePath, included) => {
      expect(adapter.includedPath(relativePath)).toBe(included);
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

    it('moves a mod\'s file to the trash', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds'));
      const trashed: string[] = [];

      await adapter.trashModFile('Harder VATS', 'Textures/a.dds', (file) => {
        trashed.push(file);
        return Promise.resolve();
      });

      expect(trashed).toEqual([join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds')]);
    });

    it('takes a file already gone as trashed', async () => {
      const trashed: string[] = [];

      await adapter.trashModFile('Harder VATS', 'Textures/gone.dds', (file) => {
        trashed.push(file);
        return Promise.resolve();
      });

      expect(trashed).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) refuses to trash a file a link in the mod\'s folder resolves outside it, trashing nothing', async () => {
      await put(join(root, 'outside', 'a.txt'));
      await symlink(join(root, 'outside'), join(root, 'mods', 'Harder VATS', 'linked'));
      const trashed: string[] = [];

      await expect(adapter.trashModFile('Harder VATS', 'linked/a.txt', (file) => {
        trashed.push(file);
        return Promise.resolve();
      })).rejects.toThrow(/Not a file of/);

      expect(trashed).toEqual([]);
    });

    it('refuses to trash a path that leaves the mod\'s folder, trashing nothing', async () => {
      const trashed: string[] = [];

      await expect(adapter.trashModFile('Harder VATS', '../outside.txt', (file) => {
        trashed.push(file);
        return Promise.resolve();
      })).rejects.toThrow(/Not a file of/);

      expect(trashed).toEqual([]);
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

      expect(seen).toEqual([modNames(await source.modOrder('Default'))]);
      expect(folders).toEqual((await source.modFolders())?.all);
      expect(holding?.path).toBe(join(root, 'mods', 'Harder VATS'));
    });

    it('rejects without deciding or writing when mods/ is there but cannot be listed', async () => {
      await rm(join(root, 'mods'), { recursive: true });
      await writeFile(join(root, 'mods'), 'not a directory');
      const before = await snapshotTree(root);
      const decide = vi.fn(() => []);

      await expect(adapter.changeModOrder('Default', decide)).rejects.toThrow(/ENOTDIR/);

      expect(decide).not.toHaveBeenCalled();
      expect(await snapshotTree(root)).toEqual(before);
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

      expect(written).toMatchObject({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_MODLIST]));
      expect(modNames(await source.modOrder('Default'))).toEqual([
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

    it('moves a separator to a place in mod order', async () => {
      await change([{
        kind: 'moveSeparators',
        separators: ['Radfall - All-In-One Survival Overhaul'],
        place: { kind: 'modOrder' },
        end: 'winning',
      }]);

      expect(modNames(await source.modOrder('Default')).slice(0, 3)).toEqual([
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'separator:Radfall - All-In-One Survival Overhaul:false',
      ]);
    });

    it('adds a separator with its folder', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', afterIndex: -1 }]);

      expect(modNames(await source.modOrder('Default'))[0]).toBe('separator:New Separator:true');
      expect(await isThere(separatorFolder('New Separator'))).toBe(true);
    });

    it('renames a separator\'s line and its folder as one change', async () => {
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames(await source.modOrder('Default'))).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(false);
    });

    it('renames a mod\'s line in place, keeping its state, and nothing else', async () => {
      const before = await snapshotTree(root);
      const order = modNames(await source.modOrder('Default'));

      expect(await change([{ kind: 'renameMod', from: 'harder vats', to: 'Harder VATS 2' }])).toMatchObject({ wrote: true });

      expect(modNames(await source.modOrder('Default'))).toEqual(order.map((n) => n.replace('mod:Harder VATS:', 'mod:Harder VATS 2:')));
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_MODLIST]));
    });

    it('writes nothing for a rename of a mod the profile does not list', async () => {
      expect(await change([{ kind: 'renameMod', from: 'No Such Mod', to: 'Anything' }])).toMatchObject({ wrote: false });
    });

    it('refuses a rename onto a name another listed mod has, in any case', async () => {
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'renameMod', from: 'Harder VATS', to: 'unofficial fallout 4 patch' }])).rejects.toThrow();

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    it('writes nothing when the changes are already true of mod order', async () => {
      const before = await text(root, DEFAULT_MODLIST);
      const mtime = (await stat(join(root, DEFAULT_MODLIST))).mtimeMs;

      expect(await change([{ kind: 'enable', mod: 'Tracked Patch Mod', enabled: true }])).toMatchObject({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect((await stat(join(root, DEFAULT_MODLIST))).mtimeMs).toBe(mtime);
    });

    it.each<[string, ModOrderChange]>([
      ['enable', { kind: 'enable', mod: 'No Such Mod', enabled: true }],
      ['moveMods', { kind: 'moveMods', mods: ['No Such Mod'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['moveSeparators', { kind: 'moveSeparators', separators: ['No Such Sep'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['moveMods to a separator that is not there', {
        kind: 'moveMods', mods: ['Harder VATS'], place: { kind: 'separator', name: 'Gone Separator' }, end: 'losing',
      }],
      ['moveMods beside a mod that is not there', {
        kind: 'moveMods', mods: ['Harder VATS'], place: { kind: 'mod', name: 'Gone Mod' }, end: 'losing',
      }],
      ['moveSeparators to a separator that is not there', {
        kind: 'moveSeparators', separators: ['Unassigned (Modlist Development)'], place: { kind: 'separator', name: 'Gone Separator' }, end: 'losing',
      }],
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

      expect(await change([already])).toMatchObject({ wrote: false });

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

        const order = modNames(await source.modOrder('Default'));
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

        expect(modNames(await source.modOrder('Default'))[0]).toBe('separator:Core Mods:true');
        expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
        await expect(change([{ kind: 'addSeparator', separator: 'CON', afterIndex: -1 }])).rejects.toThrow(/Not a valid separator name/);
      });

      it('drops path separators from a separator\'s name, so its folder stays inside mods/, on adding and on renaming', async () => {
        await change([{ kind: 'addSeparator', separator: '../Escape', afterIndex: -1 }]);
        await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'A/B' }]);

        const names = modNames(await source.modOrder('Default'));
        expect(names).toContain('separator:..Escape:true');
        expect(names).toContain('separator:AB:false');
        expect(await isThere(separatorFolder('..Escape'))).toBe(true);
        expect(await isThere(separatorFolder('AB'))).toBe(true);
        expect(await isThere(join(root, 'Escape_separator'))).toBe(false);
      });

      it('takes a separator\'s name a mod has, on adding and on renaming: a mod is no clash', async () => {
        await change([{ kind: 'addSeparator', separator: 'Harder VATS', afterIndex: -1 }]);
        await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'ENBoost - 12k' }]);

        const names = modNames(await source.modOrder('Default'));
        expect(names).toContain('separator:Harder VATS:true');
        expect(names).toContain('separator:ENBoost - 12k:false');
      });

      it('writes nothing for a rename of a separator to its own name as MO2 names its folder', async () => {
        const before = await text(root, DEFAULT_MODLIST);

        expect(await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: ' Unassigned (Modlist Development). ' }]))
          .toMatchObject({ wrote: false });

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      });

      it('keys an entry as MO2 keys it: a separator by the name of its folder, trimmed and without trailing dots, and without case', () => {
        expect(adapter.entryKey({ kind: 'separator', name: ' Unassigned (Modlist Development). ' }))
          .toBe(adapter.entryKey({ kind: 'separator', name: 'unassigned (modlist development)' }));
        expect(adapter.entryKey({ kind: 'mod', name: 'Group A_separator' })).toBe(adapter.entryKey({ kind: 'separator', name: 'GROUP A' }));
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
      expect(await source.pluginOrder('Default')).toEqual([
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

      expect(seen).toEqual([(await source.pluginOrder('Default')).map((p) => p.name)]);
    });

    it('finds each plugin a change names in any case, and writes it as plugin order lists it, a filename comparing as the game compares it, ignoring case', async () => {
      await change([
        { kind: 'enable', plugin: 'tracked patch mod.esp', enabled: false },
        { kind: 'move', plugins: ['CCSBJFO4003-GRENADE.ESL'], toIndex: 0 },
        { kind: 'drop', plugin: 'nonasciiretexture.ESP' },
      ]);

      expect(await source.pluginOrder('Default')).toEqual([
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: false },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
      ]);
    });

    it('writes nothing to add a plugin plugin order already lists in another case, doing nothing not being an error so a gesture that raced plugin sync to the same line does not fail', async () => {
      const before = await source.pluginOrder('Default');

      expect(await change([{ kind: 'add', plugin: 'TRACKED PATCH MOD.ESP' }])).toEqual({ wrote: false });
      expect(await source.pluginOrder('Default')).toEqual(before);
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

      const listed = await (await source.settings()).downloadedFiles();
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

    it('rewrites nothing for a mark already set, whether excluded or included over a removed=false key', async () => {
      await adapter.markDownloadedFile(DOWNLOAD, 'Excluded');
      expect(await adapter.markDownloadedFile(DOWNLOAD, 'Excluded')).toEqual({ gone: false, wrote: false });

      await adapter.markDownloadedFile(DOWNLOAD, 'Included');
      expect(await adapter.markDownloadedFile(DOWNLOAD, 'Included')).toEqual({ gone: false, wrote: false });
    });

    it('keeps both marks of two writes racing, rather than the second writer dropping the first key', async () => {
      await Promise.all([adapter.markDownloadedFile('manual.zip', 'Excluded'), adapter.markDownloadedFile('manual.zip', 'Installed')]);

      expect(await metaOf('manual.zip')).toMatch(/removed=true/);
      expect(await metaOf('manual.zip')).toMatch(/installed=true/);
    });

    it('writes no metadata for a file already included, so a file at rest does not gain metadata', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Included')).toEqual({ gone: false, wrote: false });

      expect(await isThere(join(downloads(), 'manual.zip.meta'))).toBe(false);
    });

    it('marks nothing for a downloaded file that is gone, as MO2 never writes a metadata file beside no downloaded file', async () => {
      expect(await adapter.markDownloadedFile('gone.zip', 'Installed')).toEqual({ gone: true });

      expect(await isThere(join(downloads(), 'gone.zip.meta'))).toBe(false);
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

  describe('the selected profile', () => {
    it('selects a profile, touching the settings alone', async () => {
      const before = await snapshotTree(root);

      expect(await adapter.selectProfile('Secondary')).toEqual({ wrote: true });

      assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
      expect((await source.settings()).profile).toBe('Secondary');
    });

    it('serializes concurrent selections, so the last one issued is the selected one', async () => {
      const [first, second] = await Promise.all([adapter.selectProfile('Secondary'), adapter.selectProfile('Default')]);

      expect([first, second]).toEqual([{ wrote: true }, { wrote: true }]);
      expect((await source.settings()).profile).toBe('Default');
    });

    it('rejects when the settings cannot be read', async () => {
      await rm(join(root, INI));

      await expect(adapter.selectProfile('Secondary')).rejects.toThrow(/ENOENT/);
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
