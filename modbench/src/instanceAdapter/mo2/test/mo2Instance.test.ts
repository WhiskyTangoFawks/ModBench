import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MoveToTrash } from '../../../ports/trash';
import type { NexusFileInfo } from '../../../ports/nexusFileInfo';
import { ignoreSkippedLink } from '../../files';
import { ignoreLink } from '../../gameFolder/ownEntries';
import {
  access, chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename as fsRename, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { eventually, writtenAndHeard } from '../../../test/eventually';
import { present } from '../../../ports/present';
import { expectKind } from '../../../test/expectKind';

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
import { Readable } from 'node:stream';
import { dirname, join, matchesGlob, sep } from 'node:path';
import { isMo2Instance, mo2InstanceAdapter } from '../mo2Instance';
import { fixedGameFolderSetting } from '../../../test/gameFolderSetting';
import type { GameDetectors } from '../../gameFolder/gameFolderResolver';
import { FOMOD_ENGINE } from '../../../test/fomodEngine';
import type { ManagerAdapter } from '../../publisher';
import type { Mo2Context } from '../mo2Context';
import type { ReadingSource } from '../../instanceReading';
import { readingSource } from '../mo2Reads';
import { OVERWRITE_ORIGIN } from '../../../wire/pluginAddress';
import type {
  EntryRef, GameFolder, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange, PluginsProvided,
} from '../../instanceAdapter';
import { setIniValue } from '../codecs/qSettingsIni';
import { ownTempPrefix } from '../../files';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { runningProgram } from '../../../test/runningProgram';
import { adapterOver, contextOver, managerOver, sourceOver } from '../../../test/mo2/adapterOver';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_LOAD_ORDER, DEFAULT_MODLIST, DEFAULT_PLUGINS, snapshotTree,
} from '../../../test/mo2/corpusFixture';

const INI = 'ModOrganizer.ini';
const DOWNLOADED_FILE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

const watchedOver = (context: Mo2Context): ReadingSource & Pick<ManagerAdapter, 'subscribe'> =>
  ({ ...readingSource(context, undefined), subscribe: (listener) => context.watch.subscribe(listener) });

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
  let adapter: ManagerAdapter;
  let source: ReadingSource;

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
    source = sourceOver(root);
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(stat).mockImplementation(actualStat);
    vi.mocked(readdir).mockImplementation(actualReaddir);
    await rm(root, { recursive: true, force: true });
  });

  describe('parsed reads', () => {
    describe('the reads beside the reading', () => {
      it('answers the release of the game the settings name', async () => {
        expect(await adapter.gameRelease()).toBe('Fallout4');
      });

      it('answers the profile the settings select now, not the one a read before did', async () => {
        const before = await adapter.activeProfile();
        await writeFile(join(root, INI), (await text(root, INI)).replace('selected_profile=@ByteArray(Default)', 'selected_profile=@ByteArray(Other)'));

        expect([before, await adapter.activeProfile()]).toEqual(['Default', 'Other']);
      });

      it('answers the game folder the game folder setting names, with its Data folder', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-gamefolder-'));
        try {
          await mkdir(join(game, 'Data'));

          expect(await managerOver(root, { gameFolderSettingValue: game }).gameFolder()).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the Steam install apart from the game folder the setting names', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-gamefolder-'));
        try {
          await mkdir(join(game, 'Data'));
          const detectors: GameDetectors = { ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }) };
          const adapter = managerOver(root, { gameFolderSettingValue: game, detectors });

          expect(await adapter.steamInstall()).toEqual({ kind: 'found', root: '/steam/Fallout 4', dataFolder: '/steam/Fallout 4/Data' });
          expect(await adapter.gameFolder()).toMatchObject({ root: game });
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the active profile\'s mod order, and the folders the mods are in with the separators\'', async () => {
        const { mods, modFolders } = await adapter.modOrder();

        expect(mods).toContainEqual({ kind: 'separator', name: 'Unassigned (Modlist Development)', enabled: false });
        expect(mods).toContainEqual(expect.objectContaining({ kind: 'mod', name: 'Harder VATS', enabled: false }));
        expect(mods).toHaveLength(10);
        expect(modFolders?.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual([
          'mod:Cracked and Smudged Pip-Boy Screen', 'mod:DragIn Manual Extract', 'mod:ENBoost - 12k', 'mod:Harder VATS', 'mod:Patch Mod',
          'mod:SKK Fast Start new game (Fallout 4)', 'mod:Unofficial Fallout 4 Patch', 'mod:Ñoño\'s Retexture',
          'separator:Unassigned (Modlist Development)',
        ].sort());
      });

      it('answers the mod order of the profile the settings select now', async () => {
        await writeFile(join(root, INI), (await text(root, INI)).replace('selected_profile=@ByteArray(Default)', 'selected_profile=@ByteArray(Secondary)'));
        await writeFile(join(root, 'profiles', 'Secondary', 'modlist.txt'), '+Only Here\n');

        expect((await adapter.modOrder()).mods).toEqual([{ kind: 'mod', name: 'Only Here', enabled: true }]);
      });

      describe('the downloaded file a path names', () => {
        const listed = join('downloads', DOWNLOADED_FILE);
        const nameAt = async (path: string, over: ManagerAdapter = adapter): Promise<string | undefined> => {
          const at = await over.downloadedFileAt(path);
          return expectKind(at, 'read').answer?.name;
        };

        it('answers the file for the path it is listed at', async () => {
          expect(await nameAt(join(root, listed))).toBe(DOWNLOADED_FILE);
        });

        it('answers the file through a symlink to it', async () => {
          await symlink(join(root, listed), join(root, 'link.7z'));

          expect(await nameAt(join(root, 'link.7z'))).toBe(DOWNLOADED_FILE);
        });

        it('answers the file for a path that reaches it through a folder link', async () => {
          await symlink(join(root, 'downloads'), join(root, 'dl'));

          expect(await nameAt(join(root, 'dl', DOWNLOADED_FILE))).toBe(DOWNLOADED_FILE);
        });

        it('answers nothing for a file that is not listed', async () => {
          await writeFile(join(root, 'Other.7z'), 'other');

          expect(await nameAt(join(root, 'Other.7z'))).toBeUndefined();
        });

        it('answers nothing for a path where nothing is', async () => {
          expect(await nameAt(join(root, 'nowhere.7z'))).toBeUndefined();
        });

        it('answers nothing for a file whose file system reports no inode, rather than the first listed file', async () => {
          await writeFile(join(root, 'Other.7z'), 'other');
          vi.mocked(stat).mockImplementation(async (path, ...rest) => {
            const facts = await actualStat(path, ...rest);
            return Object.assign(facts, { ino: 0n });
          });

          expect(await nameAt(join(root, 'Other.7z'))).toBeUndefined();
        });

        it('answers why the downloaded files could not be read when the downloads folder is unresolved', async () => {
          const unresolved = adapterOver(root, { downloadsFolder: { kind: 'unresolved', reason: 'no such variable' } });

          expect(await unresolved.downloadedFileAt(join(root, listed))).toEqual({ kind: 'unreadable', reason: 'no such variable' });
        });
      });
    });

    describe('the plugins provided, as a change to the plugin order over them reads them', () => {
      let game: string;
      let withGame: ManagerAdapter;
      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-provided-'));
        await mkdir(join(game, 'Data'));
        withGame = managerOver(root, { gameFolderSettingValue: game });
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const providedOver = async (over: ManagerAdapter, profile = 'Default'): Promise<PluginsProvided> => {
        let answer: PluginsProvided | undefined;
        await over.changePluginOrderOverProvided(profile, (_order, provided) => {
          answer = provided;
          return [];
        });
        return present(answer, 'the plugins provided');
      };
      const pluginsOver = async (over: ManagerAdapter, profile?: string): Promise<ReadonlyMap<string, string>> => {
        const provided = await providedOver(over, profile);
        return expectKind(provided, 'listed').plugins;
      };

      it('answers by the mod order of the profile it changes', async () => {
        await writeFile(join(root, 'mods', 'Unofficial Fallout 4 Patch', 'Unofficial Fallout 4 Patch.esp'), '');

        const plugins = await pluginsOver(withGame, 'Secondary');

        expect(['unofficial fallout 4 patch.esp', 'patch mod.esp'].map((key) => plugins.has(key))).toEqual([true, false]);
      });

      it('answers no plugins while the game folder is not found', async () => {
        expect(await providedOver(adapter)).toEqual({ kind: 'unresolved' });
      });
    });

    describe('the reading', () => {
      it('answers the profile, game, plugin order, downloads, source mods and the game folder with what it holds', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-reading-'));
        try {
          await mkdir(join(game, 'Data'));
          await writeFile(join(game, 'Data', 'Fallout4.esm'), '');
          await writeFile(join(game, 'Data', 'Fallout4 - Textures1.ba2'), '');
          await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\r\n');
          await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\r\nsResourceIndexFileList=Fallout4 - Textures1.ba2\r\n');
          await mkdir(join(root, 'source', 'Harder VATS', '.git'), { recursive: true });
          await writeFile(join(root, 'source', 'Harder VATS', 'Harder VATS.manifest.json'), '{ "output": "Harder VATS" }');

          const reading = await managerOver(root, { gameFolderSettingValue: game }).reading();

          expect(reading).toMatchObject({
            profile: 'Default',
            gameName: 'Fallout 4',
            gameRelease: 'Fallout4',
            downloadedFiles: { kind: 'listed', downloadsDir: join(root, 'downloads') },
            gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') },
            dataFolderPlugins: { kind: 'listed', names: new Set(['Fallout4.esm']) },
            creationClubList: ['ccBGSFO4044-HellfirePowerArmor.esl'],
            archiveList: ['Fallout4 - Textures1.ba2'],
            dataFolderArchives: { kind: 'listed', archives: ['Fallout4 - Textures1.ba2'], stringsFiles: [] },
          });
          expect([...reading.sourceMods.folders]).toEqual([['Harder VATS', join(root, 'source', 'Harder VATS')]]);
          expect(reading.pluginOrder).toEqual([
            { name: 'NonAsciiRetexture.esp', enabled: true }, { name: 'Patch Mod.esp', enabled: true },
            { name: 'Unofficial Fallout 4 Patch.esp', enabled: true }, { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
          ]);
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the versions of the game\'s program and its script extender\'s loader, read from the game folder', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-versions-'));
        try {
          await mkdir(join(game, 'Data'));
          await writeFile(join(game, 'Fallout4.exe'), windowsProgram({ version: versionInfo([1, 10, 163, 0]) }));

          const { programVersions } = await managerOver(root, { gameFolderSettingValue: game }).reading();

          expect(programVersions).toEqual({
            kind: 'found', game: { kind: 'read', version: '1.10.163.0' }, extender: { kind: 'notFound', program: 'f4se_loader.exe' },
          });
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the mod order with each mod\'s meta folded into its entry', async () => {
        const { mods } = await adapter.reading();

        expect(mods).toHaveLength(10);
        expect(mods.map((entry) => `${entry.kind}:${entry.name}`).slice(0, 4)).toEqual([
          'mod:Ñoño\'s Retexture', 'mod:Patch Mod', 'mod:SKK Fast Start new game (Fallout 4)', 'separator:Unassigned (Modlist Development)',
        ]);
        expect(mods[0]).toMatchObject({ version: '1.0.0', nexusId: '99001' });
        expect(mods[2]).toMatchObject({
          version: '21.0.0.0', nexusId: '29227', installationFileName: 'SKKFastStartNewGame_021-29227-021-1745492845.zip',
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
        expect([...reading.modFiles.keys()]).toEqual([
          'Ñoño\'s Retexture', 'Patch Mod', 'SKK Fast Start new game (Fallout 4)', '[NODELETE] Radfall', 'Unofficial Fallout 4 Patch', 'ENBoost - 12k',
          'Harder VATS', 'Cracked and Smudged Pip-Boy Screen',
        ]);
        expect(reading.modFiles.get('Ñoño\'s Retexture')?.files).toHaveLength(2);
        expect(reading.modFiles.get('Patch Mod')?.files).toHaveLength(1);
        expect(reading.modFiles.get('Harder VATS')?.files).toEqual([]);
      });

      it('answers MO2 running while any process runs ModOrganizer.exe, whichever instance it has open', async () => {
        const onThisMachine = mo2InstanceAdapter({
          instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(), installationFileReader: fakeInstallationFileReader([]), fomodEngine: FOMOD_ENGINE,
        }, undefined);
        const mo2 = await runningProgram('ModOrganizer.exe');
        try {
          expect((await onThisMachine.reading()).managerRunning).toEqual({ kind: 'running' });
        } finally {
          await mo2.stop();
        }
      });

      it('answers whether MO2 is running, or why Modbench cannot tell', async () => {
        const runningOf = async (mo2Running: () => Promise<boolean>) => (await adapterOver(root, { mo2Running }).reading()).managerRunning;

        expect([
          await runningOf(() => Promise.resolve(false)),
          await runningOf(() => Promise.reject(new Error('tasklist exited with code 1'))),
        ]).toEqual([{ kind: 'notRunning' }, { kind: 'unknown', reason: 'tasklist exited with code 1' }]);
      });

      it('answers the meta of a mod folder the mod order does not list, beside the listed ones', async () => {
        const { folderMeta } = await adapter.reading();

        expect([...folderMeta.keys()]).toContain('DragIn Manual Extract');
        expect(folderMeta.get('Unofficial Fallout 4 Patch')).toEqual({
          version: '2.1.5.0', nexusId: '4598', installationFileName: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
        });
      });

      it('hands over a link it cannot follow, by path', async () => {
        await symlink(join(root, 'nowhere'), join(root, 'mods', 'Dangling'));

        expect((await adapter.reading()).linkNotes).toEqual([expect.stringContaining(join(root, 'mods', 'Dangling'))]);
      });

      it('hands over, with the mods\' link, a link in profiles/ or downloads/ it cannot follow', async () => {
        await symlink(join(root, 'nowhere'), join(root, 'profiles', 'Gone'));
        await symlink(join(root, 'nowhere.7z'), join(root, 'downloads', 'Gone-1-0.7z'));

        const { linkNotes } = await adapter.reading();

        expect(linkNotes).toHaveLength(2);
        expect(linkNotes.join('\n')).toContain(join(root, 'downloads', 'Gone-1-0.7z'));
        expect(linkNotes.join('\n')).toContain(join(root, 'profiles', 'Gone'));
      });

      it('answers the game folder as not found, with its Data folder unresolved, when no game folder is found', async () => {
        const reading = await adapter.reading();

        expect(reading.gameFolder.kind).toBe('notFound');
        expect(reading.programVersions).toEqual({ kind: 'unresolved' });
        expect(reading.dataFolderPlugins).toEqual({ kind: 'unresolved' });
        expect(reading.creationClubList).toEqual([]);
      });

    });

    it('names MO2 and the file it keeps mod order in', () => {
      expect(adapter.names).toEqual({ manager: 'MO2', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' });
    });

    it.each(['Morrowind', 'Oblivion', 'Skyrim'])('refuses an instance of %s, which Modbench does not support, naming it', async (game) => {
      await writeFile(join(root, INI), `[General]\r\ngameName=${game}\r\nselected_profile=@ByteArray(Default)\r\n`);

      await expect(source.settings()).rejects.toThrow(`Modbench does not support ${game}`);
    });

    it('writes no file of an instance it refuses', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Oblivion\r\nselected_profile=@ByteArray(Default)\r\n');
      const held = async (): Promise<string[]> => Promise.all(['modlist.txt', 'plugins.txt', 'loadorder.txt'].map((name) => text(join(root, 'profiles', 'Default'), name).catch(() => '')));
      const before = [await text(root, INI), ...await held()];

      await expect(adapter.reading()).rejects.toThrow('Modbench does not support Oblivion');

      expect([await text(root, INI), ...await held()]).toEqual(before);
    });

    it("answers the settings' own gamePath as a place it looked, not set, when the settings hold none", async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n');

      const folder = await (await source.settings()).gameFolder();

      expect(folder).toMatchObject({
        kind: 'notFound',
        looked: expect.arrayContaining([{ place: "ModOrganizer.ini's gamePath", answer: 'not set' }]) as unknown,
      });
    });

    it('lists only the files install can take, with their metadata parsed: no folder, no partial downloaded file, no lone metadata', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await mkdir(join(root, 'downloads', 'a folder'));
      await mkdir(join(root, 'downloads', 'a folder.zip'));
      await writeFile(join(root, 'downloads', 'readme.txt'), 'text');
      await writeFile(join(root, 'downloads', 'big.rar.unfinished'), 'half');
      await writeFile(join(root, 'downloads', 'gone.zip.meta'), '[General]\r\n');

      const downloadedFiles = await (await source.settings()).downloadedFiles(ignoreSkippedLink);

      const { downloadsDir, files } = expectKind(downloadedFiles, 'listed');
      expect(downloadsDir).toBe(join(root, 'downloads'));
      const byName = new Map((files ?? []).map((file) => [file.name, file]));
      expect([...byName.keys()].sort()).toEqual([DOWNLOADED_FILE, 'manual.zip']);
      expect(byName.get(DOWNLOADED_FILE)?.meta).toMatchObject({ status: 'Installed', modID: '4598' });
      expect(byName.get(DOWNLOADED_FILE)?.excluded).toBe(false);
      expect(byName.get('manual.zip')?.meta).toBeUndefined();
      expect(byName.get('manual.zip')?.size).toBe(3);
      expect(byName.get('manual.zip')?.path).toBe(join(root, 'downloads', 'manual.zip'));
      expect(byName.get('manual.zip')?.metadataPath).toBe(join(root, 'downloads', 'manual.zip.meta'));
    });

    it('gives each file the Nexus mod ID install gives its mod, beside the metadata\'s own', async () => {
      await writeFile(join(root, 'downloads', 'Named Mod-4321-1-0-1700000000.7z'), '7z');
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');

      const downloadedFiles = await (await source.settings()).downloadedFiles(ignoreSkippedLink);

      const idsByName = new Map((expectKind(downloadedFiles, 'listed').files ?? []).map((file) => [file.name, file.modID]));
      expect(idsByName.get('Named Mod-4321-1-0-1700000000.7z')).toBe('4321');
      expect(idsByName.get('manual.zip')).toBeUndefined();
    });

    it('answers metadata that is there but empty as metadata, so a file whose metadata is there to open does not show none', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await writeFile(join(root, 'downloads', 'manual.zip.meta'), '');

      const downloadedFiles = await (await source.settings()).downloadedFiles(ignoreSkippedLink);

      expect(expectKind(downloadedFiles, 'listed').files?.find((file) => file.name === 'manual.zip')?.meta).toMatchObject({ status: 'Downloaded' });
    });

    it('answers no files, rather than none, when the downloads folder is not there', async () => {
      await rm(join(root, 'downloads'), { recursive: true });

      expect(await (await source.settings()).downloadedFiles(ignoreSkippedLink))
        .toEqual({ kind: 'listed', downloadsDir: join(root, 'downloads'), files: undefined });
    });

    it('answers where the downloads are from the same read the profile came from, so a rewrite between two answers does not land two generations in one value', async () => {
      const settings = await source.settings();
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n'
        + '[Settings]\r\ndownload_directory=@ByteArray(elsewhere)\r\n');

      const downloadedFiles = await settings.downloadedFiles(ignoreSkippedLink);

      expect(downloadedFiles).toMatchObject({ kind: 'listed', downloadsDir: join(root, 'downloads') });
    });

    it('answers every profile, and no stray file beside them', async () => {
      await writeFile(join(root, 'profiles', 'stray.txt'), '');

      expect((await source.profiles(ignoreSkippedLink)).sort()).toEqual(['Default', 'Secondary']);
    });

    it('answers a profile folder that is a link to a folder, and no link to a file or to nothing', async () => {
      await mkdir(join(root, 'elsewhere', 'Linked'), { recursive: true });
      await symlink(join(root, 'elsewhere', 'Linked'), join(root, 'profiles', 'Linked'));
      await writeFile(join(root, 'elsewhere', 'file'), '');
      await symlink(join(root, 'elsewhere', 'file'), join(root, 'profiles', 'FileLink'));
      await symlink(join(root, 'nowhere'), join(root, 'profiles', 'Broken'));

      const skipped: string[] = [];

      expect((await source.profiles((link) => skipped.push(link))).sort()).toEqual(['Default', 'Linked', 'Secondary']);
      expect(skipped).toEqual([join(root, 'profiles', 'Broken')]);
    });

    it('answers a downloaded file that is a link to a file, and hands over one that links to nothing', async () => {
      await writeFile(join(root, 'elsewhere.7z'), '');
      await symlink(join(root, 'elsewhere.7z'), join(root, 'downloads', 'Linked-1-0.7z'));
      await symlink(join(root, 'nowhere.7z'), join(root, 'downloads', 'Broken-1-0.7z'));
      const skipped: string[] = [];

      const downloadedFiles = await (await source.settings()).downloadedFiles((link) => skipped.push(link));

      expect(expectKind(downloadedFiles, 'listed').files?.map(({ name }) => name)).toContain('Linked-1-0.7z');
      expect(skipped).toEqual([join(root, 'downloads', 'Broken-1-0.7z')]);
    });

    it('answers no profiles when the instance has none', async () => {
      await rm(join(root, 'profiles'), { recursive: true });

      expect(await source.profiles(ignoreSkippedLink)).toEqual([]);
    });

    it('rejects a profile with no mod order to read', async () => {
      await expect(source.modOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    it('answers the meta and the files of a mod whose folder differs from its name only in case', async () => {
      await mkdir(join(root, 'mods', 'FOO'));
      await writeFile(join(root, 'mods', 'FOO', 'meta.ini'), '[General]\r\nversion=3.0\r\n');
      await writeFile(join(root, 'mods', 'FOO', 'Foo.esp'), '');

      expect(await source.modMeta('foo', 'list')).toMatchObject({ version: '3.0' });
      expect((await source.originFiles({ kind: 'mod', name: 'foo' }, 'list')).files.map((f) => f.relativePath)).toEqual(['Foo.esp']);
    });

    it('answers an empty meta for a mod with none', async () => {
      expect(await source.modMeta('DragIn Manual Extract', 'list')).toEqual({ updateAvailable: false });
    });

    it('rejects a meta that is there but cannot be read, not publishing an unreadable meta as an empty one', async () => {
      await mkdir(join(root, 'mods', 'DragIn Manual Extract', 'meta.ini'));

      await expect(source.modMeta('DragIn Manual Extract', 'list')).rejects.toThrow(/EISDIR/);
    });

    it('answers every mod folder as the entry it holds, with its path and the name MO2 knows its mod by', async () => {
      const folders = (await source.modFolders(ignoreSkippedLink))?.all;

      expect(folders).toContainEqual({
        kind: 'mod', name: 'Unofficial Fallout 4 Patch', path: join(root, 'mods', 'Unofficial Fallout 4 Patch'), modName: 'Unofficial Fallout 4 Patch',
      });
      expect(folders).toContainEqual({
        kind: 'separator',
        name: 'Unassigned (Modlist Development)',
        path: join(root, 'mods', 'Unassigned (Modlist Development)_separator'),
        modName: 'Unassigned (Modlist Development)_separator',
      });
    });

    it('answers no entry for a folder named as the reserved overwrite folder, which mod sync would otherwise list as a mod', async () => {
      await mkdir(join(root, 'mods', 'Overwrite'));

      expect((await source.modFolders(ignoreSkippedLink))?.all.map((f) => f.name)).not.toContain('Overwrite');
    });

    describe('a folder an install is extracting into', () => {
      const listed = async (): Promise<string[]> => present(await source.modFolders(ignoreSkippedLink), 'the mod folders').all.map((f) => f.name);

      it('is listed when an interrupted install left only its extraction', async () => {
        await mkdir(join(root, 'mods', 'Left Over', '.medit_tmp_2147483646_new-abc123'), { recursive: true });

        expect(await listed()).toContain('Left Over');
      });
    });

    it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers each of two folders whose names differ only in case for the entry spelled as its own', async () => {
      await mkdir(join(root, 'mods', 'ModA'));
      await mkdir(join(root, 'mods', 'moda'));
      const folders = present(await source.modFolders(ignoreSkippedLink), 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'moda' })?.path).toBe(join(root, 'mods', 'moda'));
      expect(folders.holding({ kind: 'mod', name: 'ModA' })?.path).toBe(join(root, 'mods', 'ModA'));
          });

    it('hands over a link it cannot follow rather than answering it as a folder', async () => {
      await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));
      const skipped: string[] = [];

      const folders = await source.modFolders((name) => skipped.push(name));

      expect(folders?.all.map((f) => f.name)).not.toContain('Loop');
      expect(skipped).toEqual([join(root, 'mods', 'Loop')]);
    });

    it('answers undefined when there is no folder for mods at all', async () => {
      await rm(join(root, 'mods'), { recursive: true });

      expect(await source.modFolders(ignoreSkippedLink)).toBeUndefined();
    });

    it('rejects when mods/ is there but cannot be listed, only its absence meaning there is no folder for mods', async () => {
      await rm(join(root, 'mods'), { recursive: true });
      await writeFile(join(root, 'mods'), 'not a directory');

      await expect(source.modFolders(ignoreSkippedLink)).rejects.toThrow();
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

        const plugins = await source.gameFolderPlugins(found(data), ignoreLink);

        expect(plugins).toEqual({ kind: 'listed', names: new Set(['Fallout4.ESM', 'Patch.esp']) });
      });

      it.skipIf(process.platform === 'win32')('(Windows cannot hold two names that differ only in case) answers both of two files whose names differ only in case', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(data, 'Foo.esp'), '');
        await writeFile(join(data, 'foo.esp'), '');

        expect(await source.gameFolderPlugins(found(data), ignoreLink)).toEqual({ kind: 'listed', names: new Set(['Foo.esp', 'foo.esp']) });
      });

      it('answers no plugin that is a hard link, and hands over the link, a link being a deployed file', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(game, 'Real.esp'), '');
        await writeFile(join(data, 'Own.esp'), '');
        await link(join(game, 'Real.esp'), join(data, 'Hard.esp'));
        const ignored: string[] = [];

        expect(await source.gameFolderPlugins(found(data), (path) => ignored.push(path))).toEqual({ kind: 'listed', names: new Set(['Own.esp']) });
        expect(ignored).toEqual([join(data, 'Hard.esp')]);
      });

      it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) answers no plugin that is a symlink, broken or not, and hands over each', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(game, 'Real.esp'), '');
        await symlink(join(game, 'Real.esp'), join(data, 'Soft.esp'));
        await symlink(join(game, 'nowhere.esp'), join(data, 'Broken.esp'));
        const ignored: string[] = [];

        expect(await source.gameFolderPlugins(found(data), (path) => ignored.push(path))).toEqual({ kind: 'listed', names: new Set() });
        expect(ignored.sort()).toEqual([join(data, 'Broken.esp'), join(data, 'Soft.esp')]);
      });

      it('answers unresolved when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await source.gameFolderPlugins(notFound, ignoreLink)).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when the Data folder cannot be listed', async () => {
        const plugins = await source.gameFolderPlugins(found(join(game, 'Missing')), ignoreLink);

        expect(expectKind(plugins, 'unreadable').reason).toMatch(/ENOENT/);
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

        expect((await source.archiveList('Default', found(), 'Fallout4', ignoreLink)).archives)
          .toEqual(['Fallout4 - Startup.ba2', 'Fallout4 - Interface.ba2', 'Fallout4 - Voices.ba2', 'Fallout4 - Meshes.ba2']);
      });

      it('reads no default INI that is a link, and hands the link over, a link being a deployed file', async () => {
        await writeFile(join(root, 'Deployed.ini'), '[Archive]\nsResourceArchiveList=Deployed.ba2\n');
        await link(join(root, 'Deployed.ini'), join(game, 'Fallout4_Default.ini'));
        const ignored: string[] = [];

        expect((await source.archiveList('Default', found(), 'Fallout4', (path) => ignored.push(path))).archives).toEqual([]);
        expect(ignored).toEqual([join(game, 'Fallout4_Default.ini')]);
      });

      it('lists the default INI\'s archives and notes the profile by name, when it keeps no game INIs and the My Games folder is nowhere', async () => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');
        await localSettings(false);

        const { archives, notes } = await source.archiveList('Default', found(), 'Fallout4', ignoreLink);

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
          }), undefined);
          await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
          await localSettings(false);
        });

        it('takes a key the My Games INIs give over the default INI\'s, the custom INI\'s over the main one\'s, with no warning', async () => {
          await writeFile(join(myGames, 'Fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
          await writeFile(join(myGames, 'Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');

          expect(await myGamesSource.archiveList('Default', found(), 'Fallout4', ignoreLink)).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
        });

        it('reads a My Games INI that is a link, which is the user\'s own file and not the game folder\'s', async () => {
          await writeFile(join(root, 'Shared.ini'), '[Archive]\nsResourceArchiveList=Shared.ba2\n');
          await link(join(root, 'Shared.ini'), join(myGames, 'Fallout4.ini'));
          const ignored: string[] = [];

          expect((await myGamesSource.archiveList('Default', found(), 'Fallout4', (path) => ignored.push(path))).archives).toEqual(['Shared.ba2', 'Default2.ba2']);
          expect(ignored).toEqual([]);
        });

        it('reads none of the profile\'s INIs', async () => {
          await writeFile(profileFile('Fallout4.ini'), '[Archive]\nsResourceArchiveList=Left Behind.ba2\n');

          expect((await myGamesSource.archiveList('Default', found(), 'Fallout4', ignoreLink)).archives).toEqual(['Default.ba2', 'Default2.ba2']);
        });
      });

      it('takes a key the profile\'s own INIs give over the default INI\'s, the custom INI\'s over the main one\'s, when the profile keeps its own', async () => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
        await writeFile(profileFile('fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
        await writeFile(profileFile('Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');
        await localSettings(true);

        expect(await source.archiveList('Default', found(), 'Fallout4', ignoreLink)).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
      });

      it.each([
        ['the game folder was not found', (): GameFolder => ({ kind: 'notFound', looked: [], setting: 'setting' }), 'Fallout4'],
        ['the release has no row', found, undefined],
      ])('lists none when %s', async (_why, gameFolder, release) => {
        await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');

        expect((await source.archiveList('Default', gameFolder(), release, ignoreLink)).archives).toEqual([]);
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

        expect(await source.gameFolderArchives(found(), 'Fallout4', ignoreLink)).toEqual({
          kind: 'listed', archives: ['Fallout4 - Interface.BA2'], stringsFiles: ['STRINGS/Fallout4_en.STRINGS'],
        });
      });

      it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) answers no archive that is a symlink, and hands it over', async () => {
        const data = join(game, 'Data');
        await mkdir(data, { recursive: true });
        await writeFile(join(game, 'Real.ba2'), '');
        await symlink(join(game, 'Real.ba2'), join(data, 'Fallout4 - Soft.ba2'));
        const ignored: string[] = [];

        expect(await source.gameFolderArchives(found(), 'Fallout4', (path) => ignored.push(path))).toEqual({ kind: 'listed', archives: [], stringsFiles: [] });
        expect(ignored).toEqual([join(data, 'Fallout4 - Soft.ba2')]);
      });

      it('answers no archive or strings file that is a hard link, and hands over each link, a link being a deployed file', async () => {
        const data = join(game, 'Data');
        await mkdir(join(data, 'Strings'), { recursive: true });
        await mkdir(join(game, 'Real', 'strings'), { recursive: true });
        await writeFile(join(game, 'Real.ba2'), '');
        await writeFile(join(data, 'Fallout4 - Own.ba2'), '');
        await writeFile(join(data, 'Strings', 'Fallout4_en.STRINGS'), '');
        await writeFile(join(game, 'Real', 'strings', 'Fallout4_fr.STRINGS'), '');
        await link(join(game, 'Real.ba2'), join(data, 'Fallout4 - Hard.ba2'));
        await link(join(game, 'Real', 'strings', 'Fallout4_fr.STRINGS'), join(data, 'Strings', 'Fallout4_fr.STRINGS'));
        const ignored: string[] = [];

        expect(await source.gameFolderArchives(found(), 'Fallout4', (path) => ignored.push(path))).toEqual({
          kind: 'listed', archives: ['Fallout4 - Own.ba2'], stringsFiles: ['Strings/Fallout4_en.STRINGS'],
        });
        expect(ignored.sort()).toEqual([
          join(data, 'Fallout4 - Hard.ba2'), join(data, 'Strings', 'Fallout4_fr.STRINGS'),
        ]);
      });

      it('answers unresolved when the game folder was not found', async () => {
        expect(await source.gameFolderArchives({ kind: 'notFound', looked: [], setting: 'setting' }, 'Fallout4', ignoreLink)).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when its Data folder cannot be listed', async () => {
        expect(await source.gameFolderArchives(found(), 'Fallout4', ignoreLink))
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
      managerOver(root).subscribe(() => { signals++; });
      const mods = live().find((w) => w.base === root && matchesGlob('mods/A/x.esp', w.pattern));

      mods?.fireCreate(join(root, 'mods', 'A', 'x.esp'));
      mods?.fireChange(join(root, 'mods', 'A', 'x.esp'));
      mods?.fireDelete(join(root, 'mods', 'A'));

      expect(signals).toBe(3);
    });

    it('hears a repository appear at, or vanish from, the instance root', () => {
      let signals = 0;
      managerOver(root).subscribe(() => { signals++; });
      const entry = live().find((w) => w.base === root && matchesGlob('.git', w.pattern));

      entry?.fireCreate(join(root, '.git'));
      entry?.fireDelete(join(root, '.git'));

      expect(signals).toBe(2);
    });

    it.each(['.git/config', '.git/hooks/pre-push'])('hears a change to %s, where git init writes the path filter and the push check', (inside) => {
      let signals = 0;
      managerOver(root).subscribe(() => { signals++; });
      const entry = live().find((w) => w.base === root && matchesGlob(inside, w.pattern));

      entry?.fireChange(join(root, inside));

      expect(signals).toBe(1);
    });

    it('arms nothing until someone listens, and disarms when the last listener leaves', () => {
      const watched = managerOver(root);
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
      const adapter = managerOver(root, { gameFolderSettingChanged: (listener) => {
        setting = listener;
        return { dispose: () => { setting = undefined; } };
      } });
      expect(setting).toBeUndefined();
      let signals = 0;
      const subscription = adapter.subscribe(() => { signals++; });

      setting?.();
      expect(signals).toBe(1);

      subscription.dispose();
      expect(setting).toBeUndefined();
    });

    it.each([
      ['a profile\'s mod order', 'profiles/Default/modlist.txt', 1],
      ['another profile\'s plugin order', 'profiles/Secondary/plugins.txt', 1],
      ['the settings', 'ModOrganizer.ini', 1],
      ['a mod\'s file', 'mods/Harder VATS/Textures/a.dds', 1],
      ['a mod\'s source', 'source/Harder VATS/plugin-source/Harder VATS.esp/a.json', 1],
      ['a file in overwrite', 'overwrite/F4SE/Plugins/x.ini', 1],
      ['a profile\'s settings', 'profiles/Default/settings.ini', 1],
      ['a profile\'s INI, in any case', 'profiles/Default/fallout4.INI', 1],
      ['no other file of a profile', 'profiles/Default/other.txt', 0],
    ])('signals a change to %s', (_what, relative, signalled) => {
      let signals = 0;
      managerOver(root).subscribe(() => { signals++; });

      fire(root, relative);

      expect(signals).toBe(signalled);
    });

    it.each(['HEAD', 'refs/heads/main', 'packed-refs', ''])(
      'hears .git/%s in a mod\'s repository', (inside) => {
        let signals = 0;
        managerOver(root).subscribe(() => { signals++; });

        expect(fire(root, join('source/Harder VATS/.git', inside), join('source/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(1);
      });

    it('tells a ref from git\'s bookkeeping in a Windows path', () => {
      let signals = 0;
      managerOver(root).subscribe(() => { signals++; });
      const source = live().find((w) => w.base === root && matchesGlob('source/A/x.json', w.pattern));

      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\index');
      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\refs\\heads\\main');

      expect(signals).toBe(1);
    });

    it.each(['index', 'objects/ab/cdef', 'logs/HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'HEAD.lock'])(
      'hears nothing of .git/%s in a mod\'s repository, git\'s own bookkeeping not reading as a change', (inside) => {
        let signals = 0;
        managerOver(root).subscribe(() => { signals++; });

        expect(fire(root, join('source/Harder VATS/.git', inside), join('source/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(0);
      });

    it('hears git\'s bookkeeping in a .git a mod\'s folder holds, which is the mod\'s content', () => {
      let signals = 0;
      managerOver(root).subscribe(() => { signals++; });

      expect(fire(root, 'mods/Harder VATS/.git/index', 'mods/Harder VATS/git/index')).toBe(true);
      expect(signals).toBe(1);
    });

    describe.runIf(process.platform === 'linux')('(VS Code\'s recursive watcher misses them only on Linux) the folders a folder heard created already held', () => {
      const mod = (): string => join(root, 'source', 'Harder VATS');
      const watchOf = (top: string): FakeWatcher | undefined => live().find((w) => w.base === root && matchesGlob(`${top}/A/x.json`, w.pattern));
      const fireCreated = (path: string): void => {
        const [top = ''] = path.slice(root.length + 1).split(sep);
        watchOf(top)?.fireCreate(path);
      };

      it('signals a change inside one', async () => {
        let signals = 0;
        const subscription = managerOver(root).subscribe(() => { signals++; });
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Weapons', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        fireCreated(join(root, 'source'));
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        subscription.dispose();

        expect(signalled).toBe(true);
      });

      it('signals a change inside a folder heard changed, as VS Code reports one deleted and made again in one burst', async () => {
        let signals = 0;
        const subscription = managerOver(root).subscribe(() => { signals++; });
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        watchOf('source')?.fireChange(join(root, 'source'));
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        subscription.dispose();

        expect(signalled).toBe(true);
      });

      it('signals a change inside one once armed again after a disarm', async () => {
        const watched = managerOver(root);
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        let signals = 0;
        const first = watched.subscribe(() => { signals++; });
        fireCreated(join(root, 'source'));
        signals = 0;
        const heardBeforeTheDisarm = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        first.dispose();

        signals = 0;
        const again = watched.subscribe(() => { signals++; });
        const heardAfter = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        again.dispose();

        expect(heardBeforeTheDisarm).toBe(true);
        expect(heardAfter).toBe(true);
      });

      it('forgets a folder heard deleted, so armed again it watches nothing that folder held', async () => {
        const watched = managerOver(root);
        const kept = join(root, 'source', 'Kept Mod');
        const gone = join(root, 'source', 'Gone Mod');
        const inKept = join(kept, 'plugin-source');
        const inGone = join(gone, 'plugin-source');
        await mkdir(inKept, { recursive: true });
        await mkdir(inGone, { recursive: true });
        let signals = 0;
        const first = watched.subscribe(() => { signals++; });
        fireCreated(kept);
        fireCreated(gone);
        signals = 0;
        const goneHeard = await eventually(() => signals > 0, () => writeFile(join(inGone, 'Gun.json'), `${Date.now()}`));
        await rm(gone, { recursive: true });
        watchOf('source')?.fireDelete(gone);
        first.dispose();
        await mkdir(inGone, { recursive: true });

        const again = watched.subscribe(() => { signals++; });
        signals = 0;
        const keptHeard = await eventually(() => signals > 0, () => writeFile(join(inKept, 'Gun.json'), `${Date.now()}`));
        signals = 0;
        await writtenAndHeard(inGone);
        again.dispose();

        expect(goneHeard).toBe(true);
        expect(keptHeard).toBe(true);
        expect(signals).toBe(0);
      });

      it.each(['source', 'mods'])('signals a change to the refs of a repository in %s/, and none to git\'s object store', async (top) => {
        const repository = join(root, top, 'Repository Mod');
        const refs = join(repository, '.git', 'refs', 'heads');
        const objects = join(repository, '.git', 'objects', 'ab');
        await mkdir(refs, { recursive: true });
        await mkdir(objects, { recursive: true });
        let signals = 0;
        const subscription = managerOver(root).subscribe(() => { signals++; });
        fireCreated(repository);
        signals = 0;

        const refsSignalled = await eventually(() => signals > 0, () => writeFile(join(refs, 'main'), `${Date.now()}`));
        signals = 0;
        await writtenAndHeard(objects);
        subscription.dispose();

        expect(refsSignalled).toBe(true);
        expect(signals).toBe(0);
      });

      it('holds nothing for a submodule\'s gitlink .git, a file, and signals a change inside the repository\'s folders', async () => {
        const repository = join(root, 'source', 'Submodule Mod');
        const folder = join(repository, 'plugin-source');
        await mkdir(folder, { recursive: true });
        await writeFile(join(repository, '.git'), 'gitdir: ../../.git/modules/Submodule Mod\n');
        let signals = 0;
        const watched = managerOver(root);
        const subscription = watched.subscribe(() => { signals++; });
        fireCreated(repository);
        fireCreated(join(repository, '.git'));
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(join(folder, 'Gun.json'), `${Date.now()}`));
        const { watchNotes } = await watched.reading();
        subscription.dispose();

        expect(signalled).toBe(true);
        expect(watchNotes).toEqual([]);
      });

      it('signals no write to git\'s own bookkeeping in a source repository\'s .git', async () => {
        const repository = join(root, 'source', 'Repository Mod');
        const refs = join(repository, '.git', 'refs', 'heads');
        await mkdir(refs, { recursive: true });
        let signals = 0;
        const subscription = managerOver(root).subscribe(() => { signals++; });
        fireCreated(repository);
        signals = 0;

        const refsSignalled = await eventually(() => signals > 0, () => writeFile(join(refs, 'main'), `${Date.now()}`));
        signals = 0;
        await writtenAndHeard(join(repository, '.git'));
        subscription.dispose();

        expect(refsSignalled).toBe(true);
        expect(signals).toBe(0);
      });

      it.skipIf(process.getuid?.() === 0)('(root reads every folder) signals a folder whose watch failed, and the next reading notes why', async () => {
        const unreadable = join(mod(), 'Unreadable');
        await mkdir(unreadable, { recursive: true });
        await chmod(unreadable, 0o000);
        const watched = managerOver(root);
        let signals = 0;
        const subscription = watched.subscribe(() => { signals++; });

        fireCreated(join(root, 'source'));
        signals = 0;
        const signalled = await eventually(() => signals > 0);
        const { watchNotes } = await watched.reading();
        await chmod(unreadable, 0o755);
        subscription.dispose();

        expect(signalled).toBe(true);
        expect(watchNotes).toEqual(['Modbench hears no change inside a folder whose watch failed: EACCES: permission denied']);
      });
    });

    it('follows the downloads folder the last read of the settings resolved, signalling once when it moves, not the one where the instance began, so a downloaded file landing in the folder the settings name now is heard', async () => {
      let signals = 0;
      const watched = watchedOver(contextOver(root));
      watched.subscribe(() => { signals++; });
      await (await watched.settings()).downloadedFiles(ignoreSkippedLink);
      expect(fire(join(root, 'downloads'), 'new.7z')).toBe(true);
      signals = 0;

      await writeFile(join(root, INI), `${await text(root, INI)}download_directory=@ByteArray(Elsewhere)\r\n`);
      await (await watched.settings()).downloadedFiles(ignoreSkippedLink);
      expect(signals).toBe(1);
      await (await watched.settings()).downloadedFiles(ignoreSkippedLink);
      expect(signals).toBe(1);

      expect(fire(join(root, 'downloads'), 'old.7z')).toBe(false);
      expect(fire(join(root, 'Elsewhere'), 'new.7z')).toBe(true);
    });

    it.each([
      ['Fallout4.esm', true],
      ['Patch.ESP', true],
      ['cc.Esl', true],
      ['readme.txt', false],
    ])('follows the plugins at the root of the game folder\'s Data folder, in any case, as another tool may write a plugin\'s extension in capitals: %s heard %s', async (name, heard) => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-game-'));
      try {
        await mkdir(join(game, 'Data'));
        const watched = watchedOver(contextOver(root, { gameFolderSettingValue: game }));
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        expect(fire(join(game, 'Data'), name)).toBe(heard);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('follows the release\'s Creation Club list at the game folder\'s root, so a changed list does not wait for the next focus', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-ccc-'));
      try {
        await mkdir(join(game, 'Data'));
        const watched = watchedOver(contextOver(root, { gameFolderSettingValue: game }));
        watched.subscribe(() => undefined);

        await (await watched.settings()).gameFolder();

        expect(fire(game, 'Fallout4.ccc')).toBe(true);
        expect(fire(game, 'Fallout4.ini')).toBe(false);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it.each([
      ['', 'fallout4_default.INI', true],
      ['', 'Fallout4Prefs.ini', false],
      ['Data', 'Fallout4 - Interface.BA2', true],
      ['Data', 'Strings/Fallout4_en.STRINGS', true],
      ['Data', 'Skyrim - Interface.bsa', false],
    ])('follows the release\'s default INI, and the archives and strings files of the Data folder, in any case, once read: %s/%s heard %s', async (folder, name, heard) => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-archives-'));
      try {
        const found: GameFolder = { kind: 'found', root: game, dataFolder: join(game, 'Data') };
        const watched = watchedOver(contextOver(root));
        watched.subscribe(() => undefined);

        await watched.archiveList('Default', found, 'Fallout4', ignoreLink);
        await watched.gameFolderArchives(found, 'Fallout4', ignoreLink);

        expect(fire(join(game, folder), name)).toBe(heard);
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

        await watched.archiveList('Default', found, 'Fallout4', ignoreLink);

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
      const harderVats = { kind: 'mod', name: 'Harder VATS', path: join(root, 'mods', 'Harder VATS'), modName: 'Harder VATS' };
      const folders = present((await adapter.reading()).modFolders, 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'Harder VATS' })).toEqual(harderVats);
      expect(folders.holding({ kind: 'mod', name: 'harder vats' })).toEqual(harderVats);
      expect(folders.holding({ kind: 'mod', name: 'No Such Mod' })).toBeUndefined();
      expect(folders.holding({ kind: 'separator', name: 'Harder VATS' })).toBeUndefined();
    });

    it('answers the folder a mod builds into as the one that holds it, matched without case', async () => {
      expect(await adapter.modFolderPath('harder vats')).toBe(join(root, 'mods', 'Harder VATS'));
    });

    it('answers a mod named as a separator\'s folder with that separator\'s folder, MO2 knowing a mod by its folder\'s name and a folder named for a separator holding that separator', async () => {
      expect((await adapter.reading()).modFolders?.holding({ kind: 'mod', name: 'unassigned (modlist development)_SEPARATOR' })).toMatchObject({
        kind: 'separator', name: 'Unassigned (Modlist Development)',
      });
    });

    describe('a separator, which has no metadata', () => {
      const SEPARATOR = 'Held_separator';

      beforeEach(async () => {
        await mkdir(join(root, 'mods', SEPARATOR));
        await writeFile(join(root, 'mods', SEPARATOR, 'meta.ini'), '[General]\nversion=9\ninstallationFile=Held.7z\n');
      });

      it('answers no version and no installation file, whatever its meta.ini holds, so its manifest names nothing', async () => {
        expect(await adapter.modMetadata(SEPARATOR)).toEqual({ kind: 'read', answer: { version: undefined } });
        expect(await adapter.installationFile(SEPARATOR)).toEqual({ kind: 'read', answer: undefined });
      });

      it('writes none, so a restore leaves its meta.ini as it was', async () => {
        await adapter.writeModMetadata(SEPARATOR, { version: '1', installationFile: { name: 'Other.7z' } });

        expect(await readFile(join(root, 'mods', SEPARATOR, 'meta.ini'), 'utf8')).toBe('[General]\nversion=9\ninstallationFile=Held.7z\n');
      });

      it('writes no meta.ini it has none of', async () => {
        await mkdir(join(root, 'mods', 'Bare_separator'));

        await adapter.writeModMetadata('Bare_separator', { version: undefined });

        expect(await readdir(join(root, 'mods', 'Bare_separator'))).toEqual([]);
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
        await writeFile(`${ownTempPrefix(join(folder, 'Textures'), '')}b.tmp`, '');

        const files = await source.originFiles(mod('Harder VATS'), 'list');

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

      it('leaves out the mod\'s own manifest at its root, and keeps a file below the root that bears the name', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'docs'), { recursive: true });
        await writeFile(join(folder, 'Harder VATS.manifest.json'), '{}');
        await writeFile(join(folder, 'Other.manifest.json'), '{}');
        await writeFile(join(folder, 'docs', 'Harder VATS.manifest.json'), '{}');

        const files = await source.originFiles(mod('Harder VATS'), 'list');

        expect(relativePaths(files.files)).toEqual(['Other.manifest.json', 'docs/Harder VATS.manifest.json']);
      });

      it.each([
        ['.medit_tmp_12_ab.tmp'], ['.medit_tmp_12_ab'],
      ])('leaves out %s, a temp left by a dead writer, at any depth', async (temp) => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Meshes', temp), { recursive: true });
        await writeFile(join(folder, 'Meshes', temp, 'inside.nif'), '');
        await writeFile(join(folder, 'Meshes', 'kept.nif'), '');
        await writeFile(join(folder, temp), '');

        const { files, folders } = await source.originFiles(mod('Harder VATS'), 'list');

        expect([...relativePaths(files), ...folders.map((f) => f.relativePath)].filter((path) => path.includes(temp))).toEqual([]);
        expect(relativePaths(files)).toContain('Meshes/kept.nif');
      });

      it.each([
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
        ['Overwrite', { kind: 'runtimeOutput' as const }, 'overwrite'],
      ])('lists the files at the root of %s alone when asked for its root', async (_, origin, folder) => {
        await mkdir(join(root, folder, 'Optional'), { recursive: true });
        await writeFile(join(root, folder, 'Optional', 'Nested.esp'), '');
        await symlink(join(root, folder, 'Optional'), join(root, folder, 'Linked'));
        await writeFile(join(root, folder, 'Root.esp'), '');

        const { files, folders } = await source.originRootFiles(origin, 'list');

        expect([relativePaths(files), folders]).toEqual([['Root.esp'], []]);
      });

      it('reads a linked file from where the link points, and places it where the link sits, and notes a broken link rather than failing', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(folder, 'Linked.esp'));
        await symlink(join(root, 'nowhere.esp'), join(folder, 'Broken.esp'));

        const files = await source.originFiles(mod('Harder VATS'), 'list');

        expect(files.files.find((f) => f.relativePath === 'Linked.esp'))
          .toEqual({ relativePath: 'Linked.esp', path: join(folder, 'Linked.esp'), sourcePath: await realpath(target), excluded: false, markedExcluded: false, includedPath: 'Linked.esp' });
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

        const paths = relativePaths((await source.originFiles(mod('Harder VATS'), 'list')).files);

        expect(paths).toEqual(expect.arrayContaining(['.git/HEAD', '.gitignore', 'plugin-source/shipped.json']));
      });

      it.each([
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
        ['Overwrite', { kind: 'runtimeOutput' as const }, 'overwrite'],
      ])('says which files and folders of %s are excluded: a name with the suffix in any case, and everything in such a folder', async (_, origin, folder) => {
        await mkdir(join(root, folder, 'Textures.mohidden', 'Armour'), { recursive: true });
        await writeFile(join(root, folder, 'Textures.mohidden', 'Armour', 'a.dds'), '');
        await writeFile(join(root, folder, 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, folder, 'Kept.esp'), '');

        const files = await source.originFiles(origin, 'list');
        const excludedOf = (entries: readonly { relativePath: string; excluded: boolean }[], relativePath: string) =>
          entries.find((entry) => entry.relativePath === relativePath)?.excluded;

        expect(['Textures.mohidden/Armour/a.dds', 'Hidden.esp.MOHIDDEN', 'Kept.esp'].map((path) => excludedOf(files.files, path)))
          .toEqual([true, true, false]);
        expect(['Textures.mohidden', 'Textures.mohidden/Armour'].map((path) => excludedOf(files.folders, path))).toEqual([true, true]);
      });

      it('says which files their own mark excludes, apart from their folder, and the path each has unmarked', async () => {
        await mkdir(join(root, 'mods', 'Harder VATS', 'Textures.mohidden'), { recursive: true });
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'b.dds.mohidden'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Kept.esp'), '');

        const { files } = await source.originFiles(mod('Harder VATS'), 'list');
        const named = (relativePath: string) => files.find((file) => file.relativePath === relativePath);
        const paths = ['Textures.mohidden/a.dds', 'Textures.mohidden/b.dds.mohidden', 'Hidden.esp.MOHIDDEN', 'Kept.esp'];

        expect(paths.map((path) => named(path)?.markedExcluded)).toEqual([false, true, true, false]);
        expect(paths.map((path) => named(path)?.includedPath)).toEqual(['Textures/a.dds', 'Textures/b.dds', 'Hidden.esp', 'Kept.esp']);
      });

      it('follows a linked folder, its files keyed beneath the link\'s own name', async () => {
        const shared = join(root, 'shared-textures');
        await mkdir(shared);
        await writeFile(join(shared, 'foo.dds'), '');
        await symlink(shared, join(root, 'mods', 'Harder VATS', 'linked'));

        const files = await source.originFiles(mod('Harder VATS'), 'list');

        expect(files.files.find((f) => f.relativePath === 'linked/foo.dds')?.path).toBe(join(root, 'mods', 'Harder VATS', 'linked', 'foo.dds'));
        expect(files.folders).toContainEqual({ relativePath: 'linked', path: join(root, 'mods', 'Harder VATS', 'linked'), excluded: false });
      });

      it('notes a link cycle and walks each file once', async () => {
        const folder = join(root, 'mods', 'Cycle');
        await mkdir(folder);
        await writeFile(join(folder, 'sibling.dds'), '');
        await symlink(folder, join(folder, 'loop'));

        const files = await source.originFiles(mod('Cycle'), 'list');

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

        await expect(source.originFiles({ kind: 'runtimeOutput' }, 'list')).rejects.toThrow(/permission denied/);
      });

      it('rejects when a link\'s target cannot be checked for a reason other than its absence, simulated through a mocked stat as chmod denies nothing when the runner is root', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await symlink(join(root, 'whatever.dds'), join(folder, 'restricted.dds'));
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('restricted.dds')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualStat(path, ...rest);
        });

        await expect(source.originFiles(mod('Harder VATS'), 'list')).rejects.toThrow(/permission denied/);
      });

      it.skipIf(process.platform === 'win32')('notes a FIFO and a link to one, and answers neither as a file, built with the POSIX mkfifo that Windows lacks', async () => {
        const folder = join(root, 'mods', 'Pipes');
        await mkdir(folder);
        execFileSync('mkfifo', [join(folder, 'pipe')]);
        execFileSync('mkfifo', [join(root, 'real-pipe')]);
        await symlink(join(root, 'real-pipe'), join(folder, 'linked-pipe'));

        const files = await source.originFiles(mod('Pipes'), 'list');

        expect(files.files).toEqual([]);
        expect(files.notes.join('\n')).toMatch(/pipe/);
        expect(files.notes.join('\n')).toMatch(/linked-pipe/);
        expect(files.notes).toHaveLength(2);
      });

      it('answers no files for a mod with no folder, or a name that gives it none', async () => {
        expect((await source.originFiles(mod('No Such Mod'), 'list')).files).toEqual([]);
        expect(await source.originFiles(mod('../profiles'), 'list')).toEqual({ origin: '../profiles', folder: undefined, files: [], folders: [], notes: [] });
      });

      it('lists everything the game wrote at run time, under the reserved origin, without writes in flight', async () => {
        const folder = join(root, 'overwrite');
        await writeFile(join(folder, 'Stray.esp'), '');
        await writeFile(`${ownTempPrefix(folder, '')}stray.tmp`, '');

        const files = await source.originFiles({ kind: 'runtimeOutput' }, 'list');

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

        const files = await source.originFiles(origin, 'list');

        expect(relativePaths(files.files)).toContain(kept);
        expect(relativePaths(files.files)).not.toContain('Gone/Lost.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Gone/)]);
      });

      it('notes a link in the overwrite folder, which it does not follow, rather than skipping it with no word and dropping its file from the picture', async () => {
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(root, 'overwrite', 'Linked.esp'));

        const files = await source.originFiles({ kind: 'runtimeOutput' }, 'list');

        expect(relativePaths(files.files)).not.toContain('Linked.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Linked\.esp/)]);
      });

      it('answers no files when there is no overwrite folder', async () => {
        await rm(join(root, 'overwrite'), { recursive: true });

        expect((await source.originFiles({ kind: 'runtimeOutput' }, 'list')).files).toEqual([]);
      });
    });

    describe('a mod\'s repository', () => {
      const repository = async (folder: string, manifest: string | undefined, named = folder): Promise<void> => {
        await mkdir(join(root, 'source', folder, '.git'), { recursive: true });
        if (manifest !== undefined) await writeFile(join(root, 'source', folder, `${named}.manifest.json`), manifest);
      };

      it('answers a mod\'s source folder beside mods/, whether or not it is there, and none for a name that reaches outside it', () => {
        expect(adapter.sourceFolder('Harder VATS')).toBe(join(root, 'source', 'Harder VATS'));
        expect(adapter.sourceFolder('No Such Mod')).toBe(join(root, 'source', 'No Such Mod'));
        expect(adapter.sourceFolder('../Harder VATS')).toBeUndefined();
      });

      it('lists every repository under the source folder by the mod its manifest names as its output, with its folder, and no folder without a `.git`', async () => {
        await repository('Harder VATS', '{ "output": "Harder VATS" }');
        await repository('Renamed From', '{ "output": "Renamed To" }', 'Renamed To');
        await mkdir(join(root, 'source', 'No Repository'), { recursive: true });
        await writeFile(join(root, 'source', 'No Repository', 'No Repository.manifest.json'), '{ "output": "No Repository" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Harder VATS', join(root, 'source', 'Harder VATS')], ['Renamed To', join(root, 'source', 'Renamed From')]]));
        expect(notes).toEqual([]);
      });

      it('answers the source folder that builds a mod, its name matched without case', async () => {
        await repository('Renamed From', '{ "output": "Renamed To" }', 'Renamed To');

        const sourceMods = await source.sourceMods();

        expect([sourceMods.folderOf('renamed to'), sourceMods.folderOf('Renamed From')]).toEqual([join(root, 'source', 'Renamed From'), undefined]);
      });

      it.each([
        ['no manifest', undefined],
        ['a manifest that is not JSON', '{ "output": '],
        ['a manifest that names no output', '{ "exclude": [] }'],
        ['an output that is not a folder name', '{ "output": "../Elsewhere" }'],
        ['a manifest not named for its output', '{ "output": "Elsewhere" }'],
      ])('leaves out a repository with %s, and says so', async (_, configuration) => {
        await repository('Unnamed', configuration);

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map());
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Unnamed'))]);
      });

      it('reads a folder named as a manifest as no manifest, as mEdit does', async () => {
        await repository('Foldered', undefined);
        await mkdir(join(root, 'source', 'Foldered', 'Foldered.manifest.json'));

        const { folders, notes } = await source.sourceMods();

        expect([folders, notes]).toEqual([new Map(), [`${join(root, 'source', 'Foldered')} is not a source mod: it has no manifest.`]]);
      });

      it('leaves out a repository that holds two manifests, and says so naming both', async () => {
        await repository('Twice', '{ "output": "A" }', 'A');
        await writeFile(join(root, 'source', 'Twice', 'B.manifest.json'), '{ "output": "B" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map());
        expect(notes).toEqual([`${join(root, 'source', 'Twice')} is not a source mod: it holds two manifests, A.manifest.json and B.manifest.json.`]);
      });

      it('leaves out a repository whose manifest cannot be read, says so, and lists the rest', async () => {
        await repository('Unreadable', undefined);
        await mkdir(join(root, 'source', 'Unreadable', 'Unreadable.manifest.json'));
        await repository('Readable', '{ "output": "Readable" }');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Readable', join(root, 'source', 'Readable')]]));
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Unreadable'))]);
      });

      it('gives an output two repositories name, matched without case, to the first by folder name, and says so', async () => {
        await repository('Second', '{ "output": "SHARED" }', 'SHARED');
        await repository('First', '{ "output": "Shared" }', 'Shared');

        const { folders, notes } = await source.sourceMods();

        expect(folders).toEqual(new Map([['Shared', join(root, 'source', 'First')]]));
        expect(notes).toEqual([expect.stringContaining(join(root, 'source', 'Second'))]);
      });

      it('lists none when the instance has no source folder', async () => {
        const { folders, notes } = await source.sourceMods();

        expect([folders, notes]).toEqual([new Map(), []]);
      });

      it('answers no installation file for a mod whose meta records none, and its meta as the mod manager\'s own file', async () => {
        expect(await adapter.installationFile('DragIn Manual Extract')).toEqual({ kind: 'read', answer: undefined });
        expect(adapter.metadataFilesInModFolder).toEqual(['meta.ini']);
      });
    });

    describe('a mod\'s installation files', () => {
      const ENTRY = 'textures/a.dds';

      it('answers the downloaded file its meta names, in the downloads folder, with its size and hash and each entry\'s', async () => {
        const answer = await managerOver(root, { installationFileReader: fakeInstallationFileReader([ENTRY]) }).installationFile('Unofficial Fallout 4 Patch');

        expect(answer).toEqual({
          kind: 'read',
          answer: { path: join(root, 'downloads', DOWNLOADED_FILE), page: 'https://www.nexusmods.com/fallout4/mods/4598', size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: ENTRY, hash: 'q7ZLRnu1+Os=' }] },
        });
      });

      describe('its page on its host', () => {
        const NEXUS = 'https://www.nexusmods.com/';
        const FALLOUT_FILE = NEXUS + 'fallout4/mods/4598?tab=files&file_id=77';
        const SKYRIM_FILE = NEXUS + 'skyrimspecialedition/mods/4598?tab=files&file_id=77';
        const FILES = '\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\n2\\modid=9\r\n2\\fileid=78\r\nsize=2\r\n';
        const sourceOf = async (general: string, installedFiles = ''): Promise<string | undefined> => {
          await writeFile(
            join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), `[General]\r\n${general}installationFile=${DOWNLOADED_FILE}\r\n${installedFiles}`,
          );
          const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');
          return expectKind(answer, 'read').answer?.page;
        };

        it('answers, for a meta read through the reading, the page of the file whose mod id is not the meta\'s own', async () => {
          await writeFile(
            join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'),
            `[General]\r\ngameName=Fallout4\r\nmodid=4598\r\ninstallationFile=${DOWNLOADED_FILE}\r\n\r\n[installedFiles]\r\n1\\modid=9\r\n1\\fileid=78\r\nsize=1\r\n`,
          );
          const entry = (await adapter.reading()).mods.find((e) => e.name === 'Unofficial Fallout 4 Patch');

          const metadata = await adapter.metadataOf(expectKind(present(entry, 'the mod'), 'mod'));

          expect(metadata.installationFile?.page).toBe(NEXUS + 'fallout4/mods/9?tab=files&file_id=78');
        });

        it('names no page for a game the registry has no Nexus domain for, and says which game', async () => {
          await writeFile(
            join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), `[General]\r\ngameName=EnderalSE\r\nmodid=4598\r\ninstallationFile=${DOWNLOADED_FILE}\r\n`,
          );

          const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

          const file = expectKind(answer, 'read').answer;
          expect([file?.page, file?.unpagedGame]).toEqual([undefined, 'EnderalSE']);
        });

        it.each([
          ['names the file of the mod installed, on the Nexus domain of MO2\'s short name for the game', 'gameName=SkyrimSE\r\nmodid=4598\r\n', FILES, SKYRIM_FILE],
          ['names the first file installed from the mod when others are recorded', 'gameName=Fallout4\r\nmodid=4598\r\n', FILES, FALLOUT_FILE],
          ['names the first file installed when none is from the mod', 'gameName=Fallout4\r\nmodid=3\r\n', FILES, FALLOUT_FILE],
          ['takes the mod of the file for a mod whose id is blank', 'gameName=Fallout4\r\n', FILES, FALLOUT_FILE],
          ['names the mod when no file is recorded', 'gameName=Fallout4\r\nmodid=4598\r\n', '', NEXUS + 'fallout4/mods/4598'],
          ['takes the instance\'s game for a mod with none, as MO2 does', 'modid=4598\r\n', '', NEXUS + 'fallout4/mods/4598'],
          ['reads the game as the instance\'s settings spell it', 'gameName=Fallout 4\r\nmodid=4598\r\n', '', NEXUS + 'fallout4/mods/4598'],
          ['names nothing for a mod with no Nexus id', 'gameName=Fallout4\r\n', '', undefined],
          ['names nothing for MO2\'s default id', 'gameName=Fallout4\r\nmodid=-1\r\n', '', undefined],
        ])('%s', async (_name, general, installedFiles, expected) => {
          expect(await sourceOf(general, installedFiles)).toBe(expected);
        });
      });

      describe('its metadata as facts', () => {
        const read = (answer: unknown): unknown => ({ kind: 'read', answer });
        const PATCH = 'Unofficial Fallout 4 Patch';
        const metaOf = (mod: string): string => join(root, 'mods', mod, 'meta.ini');
        const PAGE = 'https://www.nexusmods.com/fallout4/mods/4598?tab=files&file_id=77';
        const CHROME = 'comments=mine\r\ncolor=@Variant(\\0\\0\\0\\x43\\x1\\xff\\xff\\0\\0\\0\\0\\0\\0\\0\\0)\r\n';
        const patchMeta = (general: string): Promise<void> => writeFile(metaOf(PATCH), `[General]\r\ngameName=Fallout4\r\nmodid=4598\r\nversion=2.1.5.0\r\n${CHROME}${general}`);
        const mo2Written = (version: string): string =>
          `[General]\r\ngameName=Fallout4\r\nmodid=0\r\nversion=${version}\r\nnewestVersion=\r\ncategory="-1,"\r\ninstallationFile=${DOWNLOADED_FILE}\r\n${CHROME}\r\n[installedFiles]\r\nsize=0\r\n`;
        const holding = async (text: string): Promise<string> => {
          await writeFile(metaOf(PATCH), text);
          return text;
        };

        const metaWith = (general: string, pairs: readonly (readonly [string, string])[]): string =>
          `[General]\r\n${general}installationFile=${DOWNLOADED_FILE}\r\n\r\n[installedFiles]\r\n${pairs.map(([modid, fileid], i) => `${i + 1}\\modid=${modid}\r\n${i + 1}\\fileid=${fileid}\r\n`).join('')}size=${pairs.length}\r\n`;
        const pageOf = (mod: string, file?: string): string => `https://www.nexusmods.com/fallout4/mods/${mod}${file === undefined ? '' : `?tab=files&file_id=${file}`}`;
        const generalModId = (text: string): string | undefined => /^modid=(.*)\r$/m.exec(text)?.[1];

        it('answers the version, and each installation file by its name with where it comes from', async () => {
          await patchMeta(`installationFile=${DOWNLOADED_FILE}\r\n\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\nsize=1\r\n`);

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: DOWNLOADED_FILE, page: PAGE } }));
        });

        it('names an installation file recorded by its whole path by its name', async () => {
          await patchMeta('installationFile=/elsewhere/Patch.7z\r\n');

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: 'Patch.7z', page: 'https://www.nexusmods.com/fallout4/mods/4598' } }));
        });

        it('answers none for a mod with no metadata', async () => {
          expect(await adapter.modMetadata('A mod with no folder')).toEqual(read({}));
        });

        it('answers unreadable, naming why, for metadata that cannot be read', async () => {
          await rm(metaOf(PATCH));
          await mkdir(metaOf(PATCH));

          expect(await adapter.modMetadata(PATCH)).toEqual({ kind: 'unreadable', reason: 'EISDIR: illegal operation on a directory, read' });
        });

        it('writes the version, the installation file and where it comes from, and keeps every other key', async () => {
          await patchMeta('');

          await adapter.writeModMetadata(PATCH, {
            version: '3.0', installationFile: { name: 'Patch-3.7z', page: 'https://www.nexusmods.com/skyrimspecialedition/mods/12?tab=files&file_id=99' },
          });

          const text = await readFile(metaOf(PATCH), 'utf8');
          expect(text).toContain('version=3.0');
          expect(text).toContain('installationFile=Patch-3.7z');
          expect(text).toContain('gameName=SkyrimSE');
          expect(generalModId(text)).toBe('12');
          expect(text).toContain('1\\modid=12');
          expect(text).toContain('1\\fileid=99');
          expect(text).toContain(CHROME);
        });

        it.each([
          ['no version and the installation file it holds', { installationFile: { name: DOWNLOADED_FILE } }],
          ['a page it holds no id for', { installationFile: { name: DOWNLOADED_FILE, page: 'https://www.nexusmods.com/fallout4/mods/0' } }],
        ])('leaves metadata MO2 wrote byte for byte when the manifest says %s', async (_name, metadata) => {
          const held = await holding(mo2Written(''));

          await adapter.writeModMetadata(PATCH, metadata);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        it('leaves metadata byte for byte when the manifest says the version it holds', async () => {
          const held = await holding(mo2Written('2.0'));

          await adapter.writeModMetadata(PATCH, { version: '2.0', installationFile: { name: DOWNLOADED_FILE } });

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        const LEFT_ALONE = [
          ['the file it names among several', metaWith('gameName=Fallout4\r\nmodid=4598\r\n', [['4598', '77'], ['4598', '78']]), pageOf('4598', '77')],
          ['the pair its modid disagrees with', metaWith('gameName=Fallout4\r\nmodid=601\r\n', [['600', '901']]), pageOf('600', '901')],
          ['the pair its modid agrees with', metaWith('gameName=Fallout4\r\nmodid=600\r\n', [['600', '901']]), pageOf('600', '901')],
          ['the instance game it names no game of its own', metaWith('modid=600\r\n', [['600', '901']]), pageOf('600', '901')],
        ] as const;
        const WRITTEN = [
          ['a fresh clone with no modid and no pair', metaWith('gameName=Fallout4\r\n', []), pageOf('600', '901'), '600', 1],
          ['a fresh clone and a page with no file', metaWith('gameName=Fallout4\r\n', []), pageOf('1'), '1', 0],
          ['the modid MO2 writes by default', metaWith('gameName=Fallout4\r\nmodid=0\r\n', []), pageOf('600', '901'), '600', 1],
          ['a modid beside a pair the page does not name', metaWith('gameName=Fallout4\r\nmodid=601\r\n', [['600', '901']]), pageOf('700', '950'), '700', 1],
          ['several pairs with the page naming the one the modid does not', metaWith('gameName=Fallout4\r\nmodid=4598\r\n', [['4598', '77'], ['9', '78']]), pageOf('9', '78'), '9', 1],
          ['a page with no file beside a pair', metaWith('gameName=Fallout4\r\nmodid=601\r\n', [['600', '901']]), pageOf('600'), '600', 0],
          ['a page with no file and a modid of another mod', metaWith('gameName=Fallout4\r\nmodid=601\r\n', []), pageOf('600'), '600', 0],
        ] as const;

        it.each(WRITTEN)('writes the modid the manifest page names over %s', async (_name, text, page, modId, pairs) => {
          await holding(text);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE, page } });

          const written = await readFile(metaOf(PATCH), 'utf8');
          expect(generalModId(written)).toBe(modId);
          expect(written.match(/^\d+\\modid=/gm) ?? []).toHaveLength(pairs);
        });

        it.each([...LEFT_ALONE.map(([name, text, page]) => [name, text, page, false] as const), ...WRITTEN.map(([name, text, page]) => [name, text, page, true] as const)])(
          'reads the manifest page as held after restore, and writes only what it read as differing: %s', async (_name, text, page, differed) => {
            const pageHeld = async (): Promise<boolean> => {
              const read = await adapter.modMetadata(PATCH);
              return expectKind(read, 'read').answer.installationFile?.page === page;
            };
            const held = await holding(text);
            expect(await pageHeld()).toBe(!differed);

            await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE, page } });

            expect(await pageHeld()).toBe(true);
            expect((await readFile(metaOf(PATCH), 'utf8')) === held).toBe(!differed);
          },
        );

        it('changes only the value that differs', async () => {
          const held = await holding(mo2Written('1.0'));

          await adapter.writeModMetadata(PATCH, { version: '2.0', installationFile: { name: DOWNLOADED_FILE } });

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held.replace('version=1.0', 'version=2.0'));
        });

        it('keeps the version the manifest lacks', async () => {
          await patchMeta(`installationFile=${DOWNLOADED_FILE}\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE } });

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: DOWNLOADED_FILE, page: 'https://www.nexusmods.com/fallout4/mods/4598' } }));
        });

        it('gives a file the manifest names another name no page of the file it replaces, and keeps every other key', async () => {
          await patchMeta(`installationFile=${DOWNLOADED_FILE}\r\n\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\nsize=1\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: 'Patch-3.7z' } });

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: 'Patch-3.7z' } }));
          expect(await readFile(metaOf(PATCH), 'utf8')).toContain(CHROME);
        });

        it('writes the instance\'s own spelling of its game for a domain the instance\'s game has', async () => {
          await writeFile(join(root, INI), (await readFile(join(root, INI), 'utf8')).replace(/gameName=.*/, 'gameName=Fallout 4 VR'));
          await holding(`[General]\r\ngameName=SkyrimSE\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: 'P.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } });

          expect(await readFile(metaOf(PATCH), 'utf8')).toContain('gameName=Fallout 4 VR');
        });

        it('writes nothing for metadata that says nothing', async () => {
          await adapter.writeModMetadata('Brand New', {});

          await expect(access(metaOf('Brand New'))).rejects.toThrow();
        });

        it('makes the metadata of a mod with none, in its folder', async () => {
          await adapter.writeModMetadata('Brand New', { version: '1.0' });

          expect(await readFile(metaOf('Brand New'), 'utf8')).toContain('version=1.0');
        });

        it.each([
          ['a Nexus domain with no game', 'https://www.nexusmods.com/nowhere/mods/1', 'nowhere'],
          ['a page that is not a Nexus one', 'https://gitlab.com/a/b', 'https://gitlab.com/a/b'],
        ])('cannot write a page naming %s, says why, and writes nothing', async (_name, page, mentioned) => {
          const held = await holding(mo2Written('1.0'));
          const metadata = { version: '9', installationFile: { name: 'P.7z', page } };

          expect(await adapter.unwritableMetadata(PATCH, metadata)).toContain(mentioned);
          await expect(adapter.writeModMetadata(PATCH, metadata)).rejects.toThrow(mentioned);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        it('can write a page naming a game the tables hold', async () => {
          expect(await adapter.unwritableMetadata(PATCH, { installationFile: { name: 'P.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } })).toBeUndefined();
        });

        it('reads back as what it was handed', async () => {
          const written = { version: '3.0', installationFile: { name: 'Patch-3.7z', page: 'https://www.nexusmods.com/starfield/mods/5?tab=files&file_id=6' } };

          await adapter.writeModMetadata('Brand New', written);

          expect(await adapter.modMetadata('Brand New')).toEqual(read(written));
        });
      });

      describe('its place on Nexus and its newest version', () => {
        const PATCH = 'Unofficial Fallout 4 Patch';
        const metaOf = (mod: string): string => join(root, 'mods', mod, 'meta.ini');
        const holding = async (text: string): Promise<string> => {
          await writeFile(metaOf(PATCH), text);
          return text;
        };
        const general = (keys: string): string => `[General]\r\n${keys}comments=mine\r\n`;

        it('names the mod, the file installed and the installation file, on the Nexus domain of the mod\'s game', async () => {
          await holding(`${general(`gameName=SkyrimSE\r\nmodid=4598\r\nnexusFileStatus=3\r\ninstallationFile=${DOWNLOADED_FILE}\r\n`)}\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\nsize=1\r\n`);

          expect(await adapter.nexusFile(PATCH)).toEqual({ kind: 'read', answer: { game: 'skyrimspecialedition', modId: '4598', fileId: '77', fileName: DOWNLOADED_FILE, fileStatus: 3 } });
        });

        it('names no file ID for a mod no file is recorded for', async () => {
          await holding(general('gameName=Fallout4\r\nmodid=4598\r\n'));

          expect(await adapter.nexusFile(PATCH)).toEqual({ kind: 'read', answer: { game: 'fallout4', modId: '4598', fileId: undefined, fileName: undefined, fileStatus: undefined } });
        });

        it('answers none for a mod with no Nexus mod ID', async () => {
          await holding(general('gameName=Fallout4\r\n'));

          expect(await adapter.nexusFile(PATCH)).toEqual({ kind: 'read', answer: undefined });
        });

        it('answers unreadable, naming the game, when Nexus has no domain for the mod\'s game', async () => {
          await holding(general('gameName=Nowhere\r\nmodid=4598\r\n'));

          expect(await adapter.nexusFile(PATCH)).toEqual({ kind: 'unreadable', reason: expect.stringContaining('Nowhere') as unknown });
        });

        it('writes the newest version where MO2 reads it, keeping every other key, and says an update is available', async () => {
          await holding(general('gameName=Fallout4\r\nmodid=4598\r\nversion=2.1.5.0\r\n'));

          const outcome = await adapter.writeNewestVersion(PATCH, '3.0');

          expect(outcome).toEqual({ updateAvailable: true });
          expect(await readFile(metaOf(PATCH), 'utf8')).toBe('[General]\r\nnewestVersion=3.0\r\ngameName=Fallout4\r\nmodid=4598\r\nversion=2.1.5.0\r\ncomments=mine\r\n');
        });

        it('says no update is available when the mod holds the newest version', async () => {
          await holding(general('gameName=Fallout4\r\nmodid=4598\r\nversion=3.0\r\n'));

          expect(await adapter.writeNewestVersion(PATCH, '3.0')).toEqual({ updateAvailable: false });
        });

        it('replaces the newest version it holds', async () => {
          await holding(general('gameName=Fallout4\r\nversion=1.0\r\nnewestVersion=2.0\r\n'));

          await adapter.writeNewestVersion(PATCH, '3.0');

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(general('gameName=Fallout4\r\nversion=1.0\r\nnewestVersion=3.0\r\n'));
        });

        it('leaves metadata byte for byte when it already says the newest version', async () => {
          const held = await holding(general('gameName=Fallout4\r\nversion=1.0\r\nnewestVersion=3.0\r\n'));
          const longAgo = new Date(2001, 1, 1);
          await utimes(metaOf(PATCH), longAgo, longAgo);

          await adapter.writeNewestVersion(PATCH, '3.0');

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
          expect((await stat(metaOf(PATCH))).mtime).toEqual(longAgo);
        });
      });

      describe('installed from a file outside the downloads folder, which MO2 records by its whole path', () => {
        const recordingInstalledFrom = (path: string): Promise<void> =>
          writeFile(join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), setIniValue('[General]\r\n', 'General', 'installationFile', path));

        it('answers that file while it is there', async () => {
          const elsewhere = join(root, 'elsewhere', 'Patch.7z');
          await mkdir(join(root, 'elsewhere'));
          await writeFile(elsewhere, 'hello');
          await recordingInstalledFrom(elsewhere);

          const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

          expect(answer).toEqual({ kind: 'read', answer: { path: elsewhere, size: 5, hash: 'o22fiH2CxyY=', entries: [] } });
        });

        it('answers the file of its name in the downloads folder once it is gone, as MO2 reinstalls it', async () => {
          await recordingInstalledFrom(join(root, 'elsewhere', DOWNLOADED_FILE));

          const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

          expect(answer).toEqual({ kind: 'read', answer: { path: join(root, 'downloads', DOWNLOADED_FILE), size: 28, hash: 'yMPjZVarjmw=', entries: [] } });
        });
      });

      it('answers unreadable, naming the downloaded file and why, when it is gone', async () => {
        await rm(join(root, 'downloads', DOWNLOADED_FILE));

        const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

        const { reason } = expectKind(answer, 'unreadable');
        expect(reason).toContain('ENOENT');
        expect(reason).toContain(DOWNLOADED_FILE);
      });

      it('answers unreadable, naming the downloaded file and why, when the downloads folder cannot be resolved', async () => {
        await rm(join(root, INI));

        const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

        const { reason } = expectKind(answer, 'unreadable');
        expect(reason).toContain(DOWNLOADED_FILE);
        expect(reason).toContain(INI);
      });
    });

    describe('a downloaded file by its name', () => {
      it('answers the file of that name in the downloads folder, with its size and hash and each entry\'s', async () => {
        const answer = await managerOver(root, { installationFileReader: fakeInstallationFileReader(['textures/a.dds']) }).downloadedFile(DOWNLOADED_FILE);

        expect(answer).toEqual({
          kind: 'read', answer: { path: join(root, 'downloads', DOWNLOADED_FILE), size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: 'textures/a.dds', hash: 'q7ZLRnu1+Os=' }] },
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

    it.each([
      ['a file\'s page', 'https://www.nexusmods.com/fallout4/mods/7?tab=files&file_id=78', { game: 'fallout4', modId: '7', fileId: '78' }],
      ['a mod\'s page, which names no file', 'https://www.nexusmods.com/fallout4/mods/7', { game: 'fallout4', modId: '7', fileId: undefined }],
      ['a page on another host', 'https://example.com/fallout4/mods/7', undefined],
    ])('reads the file on Nexus of %s', (_name, page, file) => {
      expect(adapter.nexusFileAt(page)).toEqual(file);
    });
  });

  describe('put and rename in mods/', () => {
    it('creates a mod\'s folder in mods/', async () => {
      await adapter.createModFolder('Brand New');

      expect(await isThere(join(root, 'mods', 'Brand New'))).toBe(true);
    });

    it('refuses a folder already there as a separator\'s, whose name it decodes to, naming it, never adopting a separator\'s in silence', async () => {
      const before = await snapshotTree(root);

      await expect(adapter.createModFolder('unassigned (modlist development)_SEPARATOR'))
        .rejects.toThrow(`The folder "${join(root, 'mods', 'Unassigned (Modlist Development)_separator')}" is in the way`);

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('renames a mod\'s folder, keeping what is in it, and takes a case-only rename', async () => {
      await adapter.renameModFolder('harder vats', 'Harder VATS 2');
      await adapter.renameModFolder('Harder VATS 2', 'HARDER VATS 2');

      expect(await isThere(join(root, 'mods', 'Harder VATS'))).toBe(false);
      expect(await isThere(join(root, 'mods', 'HARDER VATS 2', 'meta.ini'))).toBe(true);
    });

    it('renames the manifest in a mod\'s folder to the new name in the same rename, leaving no manifest of the old name', async () => {
      await writeFile(join(root, 'mods', 'Harder VATS', 'Harder VATS.manifest.json'), '');

      await adapter.renameModFolder('harder vats', 'Harder VATS 2');

      expect(await isThere(join(root, 'mods', 'Harder VATS 2', 'Harder VATS 2.manifest.json'))).toBe(true);
      expect(await isThere(join(root, 'mods', 'Harder VATS 2', 'Harder VATS.manifest.json'))).toBe(false);
    });

    it('puts the folder back when its manifest cannot be renamed, so no rename lands in part', async () => {
      await writeFile(join(root, 'mods', 'Harder VATS', 'Harder VATS.manifest.json'), '');
      await mkdir(join(root, 'mods', 'Harder VATS', 'Harder VATS 2.manifest.json'));

      await expect(adapter.renameModFolder('Harder VATS', 'Harder VATS 2')).rejects.toThrow();

      expect(await isThere(join(root, 'mods', 'Harder VATS', 'Harder VATS.manifest.json'))).toBe(true);
      expect(await isThere(join(root, 'mods', 'Harder VATS 2'))).toBe(false);
    });

    it('moves the folder that holds a separator to the trash', async () => {
      const trashed: string[] = [];

      expect(await adapter.trashEntryFolder({ kind: 'separator', name: 'Unassigned (Modlist Development)' }, (path) => {
        trashed.push(path);
        return Promise.resolve();
      })).toBe(true);

      expect(trashed).toEqual([join(root, 'mods', 'Unassigned (Modlist Development)_separator')]);
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

  it('moves to the trash the repository whose manifest names the mod, and answers false when none does', async () => {
    const trashed: string[] = [];
    const trash = (path: string): Promise<void> => {
      trashed.push(path);
      return Promise.resolve();
    };
    await mkdir(join(root, 'source', 'Renamed From', '.git'), { recursive: true });
    await writeFile(join(root, 'source', 'Renamed From', 'Harder VATS.manifest.json'), '{ "output": "Harder VATS" }');
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
      expect(adapter.exclusionMark).toBe('.mohidden');
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

    it('reads a file as the listing holds it, with the path it has unmarked', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds.mohidden'));

      expect(await adapter.originFile(modOrigin, 'Textures.mohidden/a.dds.mohidden')).toEqual({
        relativePath: 'Textures.mohidden/a.dds.mohidden', path: join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds.mohidden'),
        sourcePath: await realpath(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds.mohidden')),
        excluded: true, markedExcluded: true, includedPath: 'Textures/a.dds',
      });
    });

    it('reads no file for a folder', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds'));

      expect(await adapter.originFile(modOrigin, 'Textures')).toBeUndefined();
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
      expect(folders).toEqual((await source.modFolders(ignoreSkippedLink))?.all);
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
        'mod:Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'mod:Harder VATS:true',
        'mod:Cracked and Smudged Pip-Boy Screen:true',
      ]);
    });

    it('adds a separator with its folder', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);

      expect(modNames(await source.modOrder('Default'))[0]).toBe('separator:New Separator:true');
      expect(await isThere(separatorFolder('New Separator'))).toBe(true);
    });

    it('adds a separator beside an anchor named in another case', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', anchor: { kind: 'mod', name: 'skk fast start NEW GAME (fallout 4)' } }]);

      expect(modNames(await source.modOrder('Default'))[3]).toBe('separator:New Separator:true');
    });

    it('renames a separator\'s line and its folder as one change', async () => {
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames(await source.modOrder('Default'))).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(false);
    });

    it('renames the manifest in a separator\'s folder to the new name with the folder', async () => {
      const folder = separatorFolder('Unassigned (Modlist Development)');
      await writeFile(join(folder, 'Unassigned (Modlist Development)_separator.manifest.json'), '');

      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(await isThere(join(separatorFolder('Core Mods'), 'Core Mods_separator.manifest.json'))).toBe(true);
      expect(await isThere(join(separatorFolder('Core Mods'), 'Unassigned (Modlist Development)_separator.manifest.json'))).toBe(false);
    });

    it('leaves a separator\'s line and folder as they were when its manifest cannot be renamed', async () => {
      const folder = separatorFolder('Unassigned (Modlist Development)');
      await writeFile(join(folder, 'Unassigned (Modlist Development)_separator.manifest.json'), '');
      await mkdir(join(folder, 'Core Mods_separator.manifest.json'));
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }])).rejects.toThrow();

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect(await isThere(join(folder, 'Unassigned (Modlist Development)_separator.manifest.json'))).toBe(true);
      expect(await isThere(separatorFolder('Core Mods'))).toBe(false);
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

    it('writes nothing when the changes are already true of mod order', async () => {
      const before = await text(root, DEFAULT_MODLIST);
      const mtime = (await stat(join(root, DEFAULT_MODLIST))).mtimeMs;

      expect(await change([{ kind: 'enable', mod: 'Patch Mod', enabled: true }])).toMatchObject({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect((await stat(join(root, DEFAULT_MODLIST))).mtimeMs).toBe(mtime);
    });

    it.each<[string, ModOrderChange]>([
      ['adding a separator listed in another case', { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'radfall - all-in-one survival overhaul' } }],
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

        await expect(change([{ kind: 'addSeparator', separator: 'Orphan', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }])).rejects.toThrow(/is in the way/);

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
          await expect(change([{ kind: 'addSeparator', separator: 'New Separator', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }])).rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await isThere(separatorFolder('New Separator'))).toBe(false);
      });

      it('puts every folder back newest first, so a separator added and then renamed in one change leaves no first folder behind', async () => {
        await chmod(modlist(), 0o444);
        try {
          await expect(change([
            { kind: 'addSeparator', separator: 'Brief', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } },
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
      it('names a separator as MO2 names its folder, and refuses a name with nothing of it left', async () => {
        await change([{ kind: 'addSeparator', separator: '  Core:  Mods.  ', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);

        expect(modNames(await source.modOrder('Default'))[0]).toBe('separator:Core Mods:true');
        expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
        await expect(change([{ kind: 'addSeparator', separator: 'CON', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }])).rejects.toThrow(/Not a valid separator name/);
      });

      it('drops path separators from a separator\'s name, so its folder stays inside mods/, on adding and on renaming', async () => {
        await change([{ kind: 'addSeparator', separator: '../Escape', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);
        await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'A/B' }]);

        const names = modNames(await source.modOrder('Default'));
        expect(names).toContain('separator:..Escape:true');
        expect(names).toContain('separator:AB:false');
        expect(await isThere(separatorFolder('..Escape'))).toBe(true);
        expect(await isThere(separatorFolder('AB'))).toBe(true);
        expect(await isThere(join(root, 'Escape_separator'))).toBe(false);
      });

      it('takes a separator\'s name a mod has, on adding and on renaming: a mod is no clash', async () => {
        await change([{ kind: 'addSeparator', separator: 'Harder VATS', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);
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

      it.each<[string, EntryRef, EntryRef, boolean]>([
        ['a separator by the name of its folder, trimmed and without trailing dots', { kind: 'separator', name: ' Unassigned (Modlist Development). ' }, { kind: 'separator', name: 'unassigned (modlist development)' }, true],
        ['a mod named as a separator\'s folder as that separator', { kind: 'mod', name: 'Group A_separator' }, { kind: 'separator', name: 'GROUP A' }, true],
        ['a mod without case', { kind: 'mod', name: 'harder vats' }, { kind: 'mod', name: 'Harder VATS' }, true],
        ['two separators of other names apart', { kind: 'separator', name: 'Group A' }, { kind: 'separator', name: 'Group B' }, false],
        ['a mod apart from the separator of its name', { kind: 'mod', name: 'Group A' }, { kind: 'separator', name: 'Group A' }, false],
      ])('keys an entry as MO2 keys it: %s', (_case, a, b, same) => {
        expect(adapter.entryKey(a) === adapter.entryKey(b)).toBe(same);
      });
    });
  });

  describe('changes to plugin order', () => {
    const change = (changes: readonly PluginOrderChange[]) =>
      adapter.changePluginOrder('Default', () => changes);

    it('lands every change in one write of plugin order alone, keeping its byte-order mark', async () => {
      const before = await snapshotTree(root);

      const written = await change([
        { kind: 'enable', plugin: 'Patch Mod.esp', enabled: false },
        { kind: 'drop', plugin: 'NonAsciiRetexture.esp' },
        { kind: 'add', plugin: 'New.esp' },
        { kind: 'move', plugins: ['ccSBJFO4003-Grenade.esl'], toIndex: 0 },
      ]);

      expect(written).toEqual({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));
      expect(await source.pluginOrder('Default')).toEqual([
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
        { name: 'Patch Mod.esp', enabled: false },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'New.esp', enabled: false },
      ]);
      expect(await text(root, DEFAULT_LOAD_ORDER))
        .toBe('ccSBJFO4003-Grenade.esl\r\nPatch Mod.esp\r\nUnofficial Fallout 4 Patch.esp\r\nNew.esp\r\n');
      expect((await text(root, DEFAULT_PLUGINS)).startsWith('﻿')).toBe(true);
    });

    it('refuses a plugins.txt holding a name that is not UTF-8, as MO2 writes one in the system\'s code page, and writes neither file', async () => {
      await writeFile(join(root, DEFAULT_PLUGINS), Buffer.concat([await readFile(join(root, DEFAULT_PLUGINS)), Buffer.from([0x2a, 0x43, 0xe9, 0x2e, 0x65, 0x73, 0x70])]));
      const before = await snapshotTree(root);

      await expect(change([{ kind: 'enable', plugin: 'Patch Mod.esp', enabled: false }])).rejects.toThrow(/plugins\.txt line 6 is not UTF-8/);

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('writes no loadorder.txt when plugin order is unchanged', async () => {
      await change([{ kind: 'enable', plugin: 'Patch Mod.esp', enabled: true }]);

      await expect(text(root, DEFAULT_LOAD_ORDER)).rejects.toThrow(/ENOENT/);
    });

    it('hands the decision the order as it stands', async () => {
      const seen: string[][] = [];

      await adapter.changePluginOrder('Default', (order) => {
        seen.push(order.map((p) => p.name));
        return [];
      });

      expect(seen).toEqual([(await source.pluginOrder('Default')).map((p) => p.name)]);
    });
  });

  describe('a downloaded file\'s metadata', () => {
    const downloadsFolder = (): string => join(root, 'downloads');
    const metaOf = (name: string): Promise<string> => text(root, join('downloads', `${name}.meta`));

    beforeEach(() => writeFile(join(downloadsFolder(), 'manual.zip'), 'zip'));

    it('marks a downloaded file installed, creating its metadata when it has none', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Installed')).toEqual({ gone: false, wrote: true });

      const listed = await (await source.settings()).downloadedFiles(ignoreSkippedLink);
      expect(expectKind(listed, 'listed').files?.find((file) => file.name === 'manual.zip')?.meta?.status).toBe('Installed');
    });

    it('marks a downloaded file uninstalled beside its installed mark', async () => {
      await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Uninstalled');

      expect(await metaOf(DOWNLOADED_FILE)).toMatch(/^uninstalled=true\r$/m);
      expect(await metaOf(DOWNLOADED_FILE)).toMatch(/^installed=true\r$/m);
    });

    it('marks a downloaded file excluded, and then included again, writing its metadata and nothing else', async () => {
      const metadata = new Set([`downloads/${DOWNLOADED_FILE}.meta`]);
      const before = await snapshotTree(root);

      await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Excluded');
      const excluded = await snapshotTree(root);
      expect(await metaOf(DOWNLOADED_FILE)).toMatch(/removed=true/);

      await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Included');
      expect(await metaOf(DOWNLOADED_FILE)).toMatch(/removed=false/);
      assertOnlyChanged(before, excluded, metadata);
      assertOnlyChanged(excluded, await snapshotTree(root), metadata);
    });

    it('rewrites nothing for a mark already set, whether excluded or included over a removed=false key', async () => {
      await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Excluded');
      expect(await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Excluded')).toEqual({ gone: false, wrote: false });

      await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Included');
      expect(await adapter.markDownloadedFile(DOWNLOADED_FILE, 'Included')).toEqual({ gone: false, wrote: false });
    });

    it('writes no metadata for a file already included, so a file at rest does not gain metadata', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Included')).toEqual({ gone: false, wrote: false });

      expect(await isThere(join(downloadsFolder(), 'manual.zip.meta'))).toBe(false);
    });

    it('marks nothing for a downloaded file that is gone, as MO2 never writes a metadata file beside no downloaded file', async () => {
      expect(await adapter.markDownloadedFile('gone.zip', 'Installed')).toEqual({ gone: true });

      expect(await isThere(join(downloadsFolder(), 'gone.zip.meta'))).toBe(false);
    });

    it('sweeps the leftover temp of a dead writer when it trashes a file, even one with no metadata, as a crash during a first write leaves its temp beside no metadata at all', async () => {
      const leftover = join(downloadsFolder(), '.medit_tmp_2147483646_0123456789ab.tmp');
      await writeFile(leftover, 'half written');

      expect(await adapter.trashDownloadedFile('manual.zip', () => Promise.resolve())).toEqual({ gone: false });

      expect(await isThere(leftover)).toBe(false);
    });

    describe('what Nexus knows of it', () => {
      const info: NexusFileInfo = {
        game: 'fallout4', modID: '4598', fileID: '78', name: 'Main', version: '2.1.5', fileCategory: 1, modName: 'Unofficial Fallout 4 Patch',
        category: 12, author: 'Unofficial Patch Team', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1', description: '[b]Fixes[/b]',
      };

      it('answers the MD5 of a downloaded file with the Nexus domains of the instance\'s game', async () => {
        expect(await adapter.downloadedFileQuery('manual.zip')).toEqual({ kind: 'read', answer: { games: ['fallout4'], md5: 'adcdbd79a8d84175c229b192aadc02f2' } });
      });

      it.each([
        ['the metadata\'s IDs', 'manual.zip', '[General]\r\nmodID=4598\r\nfileID=78\r\n', { modID: '4598', fileID: '78' }],
        ['the mod ID in the file\'s name when the metadata has none', 'Release-1234-1-0.7z', '[General]\r\nfileID=78\r\n', { modID: '1234', fileID: '78' }],
      ])('answers %s', async (_name, file, meta, ids) => {
        await writeFile(join(downloadsFolder(), file), 'zip');
        await writeFile(join(downloadsFolder(), `${file}.meta`), meta);

        expect(await adapter.downloadedFileQuery(file)).toMatchObject({ kind: 'read', answer: ids });
      });

      it.each(['gone.zip', '../manual.zip'])('answers no MD5 for %s, which the downloads folder does not hold', async (name) => {
        expect(await adapter.downloadedFileQuery(name)).toEqual({ kind: 'read', answer: undefined });
      });

      it('writes what Nexus names into a metadata made for the file, which the downloaded file then reads', async () => {
        expect(await adapter.writeNexusFileInfo('manual.zip', info)).toEqual({ gone: false, wrote: true });

        const listed = await (await source.settings()).downloadedFiles(ignoreSkippedLink);
        expect(expectKind(listed, 'listed').files?.find((file) => file.name === 'manual.zip')?.meta).toMatchObject({
          modID: '4598', fileID: '78', gameName: 'Fallout4', name: 'Main', version: '2.1.5.0', modName: 'Unofficial Fallout 4 Patch', fileCategory: 1, author: 'Unofficial Patch Team',
        });
      });

      it('writes the mod\'s version when the file has none', async () => {
        await adapter.writeNexusFileInfo('manual.zip', { game: 'fallout4', modID: '1', fileID: '2', modVersion: '3.1' });

        expect(await metaOf('manual.zip')).toMatch(/^version=3\.1\.0\.0\r$/m);
      });

      it('writes when the file was uploaded as a stored date and time, between the version and the file category', async () => {
        await adapter.writeNexusFileInfo('manual.zip', { game: 'fallout4', modID: '1', fileID: '2', version: '1.0', fileTime: 1_455_072_761, fileCategory: 1 });

        expect(await metaOf('manual.zip')).toMatch(/version=1\.0\.0\.0\r\nfileTime="@DateTime\(.*\)"\r\nfileCategory=1\r\n/);
      });

      it('keeps a value Nexus does not name, and replaces one it does', async () => {
        await writeFile(join(downloadsFolder(), 'manual.zip.meta'), '[General]\r\nauthor=Hand Written\r\nversion=0.1\r\ninstalled=true\r\n');

        await adapter.writeNexusFileInfo('manual.zip', { game: 'fallout4', modID: '4598', fileID: '78', version: '2.1.5' });

        const meta = await metaOf('manual.zip');
        expect(meta).toMatch(/^author=Hand Written\r$/m);
        expect(meta).toMatch(/^installed=true\r$/m);
        expect(meta).toMatch(/^version=2\.1\.5\.0\r$/m);
        expect(meta).not.toMatch(/version=0\.1/);
      });

      it('rewrites nothing for what the metadata already says', async () => {
        await adapter.writeNexusFileInfo('manual.zip', info);

        expect(await adapter.writeNexusFileInfo('manual.zip', info)).toEqual({ gone: false, wrote: false });
      });

      it('writes no metadata beside a downloaded file that is gone', async () => {
        expect(await adapter.writeNexusFileInfo('gone.zip', info)).toEqual({ gone: true });

        expect(await isThere(join(downloadsFolder(), 'gone.zip.meta'))).toBe(false);
      });

      it('asks the domains of the game and of its valid short names, in order', async () => {
        await writeFile(join(root, INI), '[General]\r\ngameName=Skyrim Special Edition\r\nselected_profile=@ByteArray(Default)\r\n');

        expect(await adapter.downloadedFileQuery('manual.zip')).toMatchObject({ kind: 'read', answer: { games: ['skyrimspecialedition', 'skyrim'] } });
      });

      it('refuses to query an instance whose game Nexus has no domain for', async () => {
        await writeFile(join(root, INI), '[General]\r\ngameName=Morrowind\r\nselected_profile=@ByteArray(Default)\r\n');

        expect(await adapter.downloadedFileQuery('manual.zip')).toEqual({ kind: 'unreadable', reason: "Nexus has no game for 'Morrowind'" });
      });

      it('names a game Modbench only knows by its short name as that name', async () => {
        await adapter.writeNexusFileInfo('manual.zip', { game: 'skyrim', modID: '1', fileID: '2' });

        expect(await metaOf('manual.zip')).toMatch(/^gameName=Skyrim\r$/m);
      });

      it('writes nothing for a Nexus game Modbench has no game for', async () => {
        await expect(adapter.writeNexusFileInfo('manual.zip', { ...info, game: 'oblivion' })).rejects.toThrow("no game for the Nexus game 'oblivion'");

        expect(await isThere(join(downloadsFolder(), 'manual.zip.meta'))).toBe(false);
      });

      describe('put as a downloaded file', () => {
        const HASH_OF_THE_BYTES = 'CAfPxuSisds=';
        const theBytes = (): AsyncIterable<Uint8Array> => Readable.from([Buffer.from('the '), Buffer.from('bytes')]);

        it('puts bytes that have the hash asked for as the downloaded file, with what Nexus names in its metadata, and nothing else', async () => {
          const before = await snapshotTree(root);

          expect(await adapter.putDownloadedFile('fetched.7z', theBytes(), { hash: HASH_OF_THE_BYTES, info })).toEqual({ put: true });

          expect(await readFile(join(downloadsFolder(), 'fetched.7z'), 'utf8')).toBe('the bytes');
          expect(await metaOf('fetched.7z')).toMatch(/^gameName=Fallout4\r\nmodID=4598\r\nfileID=78\r$/m);
          assertOnlyChanged(before, await snapshotTree(root), new Set(['downloads/fetched.7z', 'downloads/fetched.7z.meta']));
        });

        it('writes its metadata whole, so nothing an orphan metadata of that name held, as MO2\'s removed mark, survives', async () => {
          await writeFile(join(downloadsFolder(), 'fetched.7z.meta'), '[General]\r\nremoved=true\r\ninstalled=true\r\n');

          await adapter.putDownloadedFile('fetched.7z', theBytes(), { hash: HASH_OF_THE_BYTES, info });

          expect(await metaOf('fetched.7z')).not.toMatch(/removed|installed/);
        });

        it('puts nothing when the bytes have another hash', async () => {
          const before = await snapshotTree(root);

          expect(await adapter.putDownloadedFile('fetched.7z', theBytes(), { hash: 'another=', info })).toEqual({ put: false });

          assertOnlyChanged(before, await snapshotTree(root), new Set());
        });

        it.each([
          ['a name the downloads folder already holds', 'manual.zip', info, "'manual.zip' is already in the downloads folder"],
          ['a name that is no bare file name', '../fetched.7z', info, "'../fetched.7z' is not a file name"],
          ['a Nexus game Modbench has no game for', 'fetched.7z', { ...info, game: 'oblivion' }, "no game for the Nexus game 'oblivion'"],
        ])('refuses %s, writing nothing', async (_name, name, nexusInfo, refusal) => {
          const before = await snapshotTree(root);

          await expect(adapter.putDownloadedFile(name, theBytes(), { hash: HASH_OF_THE_BYTES, info: nexusInfo })).rejects.toThrow(refusal);

          assertOnlyChanged(before, await snapshotTree(root), new Set());
        });

        it('takes the file back when its metadata cannot be written', async () => {
          await mkdir(join(downloadsFolder(), 'fetched.7z.meta'));
          const before = await snapshotTree(root);

          await expect(adapter.putDownloadedFile('fetched.7z', theBytes(), { hash: HASH_OF_THE_BYTES, info })).rejects.toThrow();

          assertOnlyChanged(before, await snapshotTree(root), new Set());
        });
      });
    });

    it('moves a downloaded file to the trash, then its metadata when it has any, and changes nothing else', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      };
      const before = await snapshotTree(root);

      expect(await adapter.trashDownloadedFile(DOWNLOADED_FILE, trash)).toEqual({ gone: false });
      expect(await adapter.trashDownloadedFile('manual.zip', trash)).toEqual({ gone: false });

      expect(trashed).toEqual([join(downloadsFolder(), DOWNLOADED_FILE), join(downloadsFolder(), `${DOWNLOADED_FILE}.meta`), join(downloadsFolder(), 'manual.zip')]);
      expect(await snapshotTree(root)).toEqual(before);
    });

    it('answers a downloaded file already gone as gone, trashing nothing', async () => {
      const trash = vi.fn<MoveToTrash>();

      expect(await adapter.trashDownloadedFile('gone.zip', trash)).toEqual({ gone: true });

      expect(trash).not.toHaveBeenCalled();
    });

    it('rejects when the file cannot be trashed, leaving its metadata', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.reject(new Error('EPERM'));
      };

      await expect(adapter.trashDownloadedFile(DOWNLOADED_FILE, trash)).rejects.toThrow('EPERM');

      expect(trashed).toEqual([join(downloadsFolder(), DOWNLOADED_FILE)]);
    });

    it('answers the reason when the file landed in the trash but its metadata could not', async () => {
      const trash = (path: string): Promise<void> => (path.endsWith('.meta') ? Promise.reject(new Error('EPERM')) : Promise.resolve());

      expect(await adapter.trashDownloadedFile(DOWNLOADED_FILE, trash)).toEqual({ gone: false, metadataLeftBehind: 'EPERM' });
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

describe('a folder is an MO2 instance by what it holds', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-detect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const settingsIn = (at: string): Promise<void> => writeFile(join(at, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\n');
  const folderIn = async (at: string, name: string): Promise<void> => { await mkdir(join(at, name)); };
  const instanceIn = async (at: string): Promise<void> => {
    await settingsIn(at);
    await folderIn(at, 'mods');
    await folderIn(at, 'profiles');
  };

  it.each<[string, (at: string) => Promise<void>, boolean]>([
    ['is one when it holds ModOrganizer.ini, mods/ and profiles/', instanceIn, true],
    ['is none without ModOrganizer.ini', async (at) => { await folderIn(at, 'mods'); await folderIn(at, 'profiles'); }, false],
    ['is none without mods/', async (at) => { await settingsIn(at); await folderIn(at, 'profiles'); }, false],
    ['is none without profiles/', async (at) => { await settingsIn(at); await folderIn(at, 'mods'); }, false],
    ['is none when empty', () => Promise.resolve(), false],
  ])('%s', async (_case, lay, instance) => {
    await lay(root);

    expect(isMo2Instance(root)).toBe(instance);
  });

  it('is none for a path where nothing is, without throwing', () => {
    expect(isMo2Instance(join(root, 'does-not-exist'))).toBe(false);
  });

  it('is one with a modlist.txt that is not text, its contents unread', async () => {
    await instanceIn(root);
    await mkdir(join(root, 'profiles', 'Default'));
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '\x00not valid text\xff');

    expect(isMo2Instance(root)).toBe(true);
  });
});
