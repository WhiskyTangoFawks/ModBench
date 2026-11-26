import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import { fileProblemsFake } from '../../../test/fileProblemsFake';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MoveToTrash } from '../../../ports/trash';
import type { NexusFileInfo } from '../../../ports/nexusFileInfo';
import {
  access, appendFile, chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename as fsRename, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { appendFileSync, writeFileSync, type PathLike } from 'node:fs';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { eventually, writtenAndHeard } from '../../../test/eventually';
import { present } from '../../../ports/present';
import { expectKind } from '../../../test/expectKind';
import { BUILD_FILE } from '../../../wire/sourceMod';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({
  rename: undefined as typeof import('node:fs/promises').rename | undefined,
  stat: undefined as typeof import('node:fs/promises').stat | undefined,
  readdir: undefined as typeof import('node:fs/promises').readdir | undefined,
  readFile: undefined as typeof import('node:fs/promises').readFile | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  real.stat = actual.stat;
  real.readdir = actual.readdir;
  real.readFile = actual.readFile;
  return { ...actual, rename: vi.fn(actual.rename), stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);
const actualStat = present(real.stat, 'the real stat');
const actualReaddir = present(real.readdir, 'the real readdir');
const actualReadFile = present(real.readFile, 'the real readFile');
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { basename, dirname, join, matchesGlob, relative as relativeFrom, sep } from 'node:path';
import { adapterForInstance, isInstance } from '../../openInstance';
import { fixedGameFolderSetting } from '../../../test/gameFolderSetting';
import { FOMOD_ENGINE } from '../../../test/fomodEngine';
import { DEPLOYED_PATH } from '../../../test/deployedPath';
import {
  CHECK_THE_DISK, type InstanceAdapter, type InstanceReading, type OriginFiles, type Reread, type WatcherExclude,
} from '../../instanceAdapter';
import { watcherExcluding } from '../../../test/watcherExclusion';
import { OVERWRITE_ORIGIN } from '../../../wire/pluginAddress';
import type {
  EntryRef, FileOrigin, GameFolder, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange, PluginsProvided,
} from '../../instanceAdapter';
import { installationFileMeta } from './installationFileMeta';
import { ownTempPrefix } from '../../../repositoriesLib/wholeWrites';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { runningProgram } from '../../../test/runningProgram';
import { hostWithoutGit } from '../../../test/hostGitDouble';
import { fileSystemClockMovedOn } from '../../../test/fileSystemClock';
import { adapterOver, type AdapterAnswers } from '../../../test/mo2/adapterOver';
import { INSTALLED_DEPOT, writeAppManifestOfDepot } from '../../../test/steamAppManifestFixture';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_LOAD_ORDER, DEFAULT_MODLIST, DEFAULT_PLUGINS, modFolderNames, snapshotTree,
} from '../../../test/mo2/corpusFixture';
import { onPosix } from '../../../test/platform';

type GameDetectors = NonNullable<AdapterAnswers['detectors']>;

const INI = 'ModOrganizer.ini';
const TRASH: MoveToTrash = (file) => rm(file);
const DOWNLOADED_FILE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

const text = (root: string, relative: string): Promise<string> => readFile(join(root, relative), 'utf8');

const modNames = (order: readonly ModlistEntry[]): string[] => order.map((e) => `${e.kind}:${e.name}:${e.enabled}`);

/** A profile's mod order, as a change to it is handed the order. */
async function modOrderOf(adapter: InstanceAdapter, profile: string): Promise<readonly ModlistEntry[]> {
  let order: readonly ModlistEntry[] = [];
  await adapter.changeModOrder(profile, (stands) => {
    order = stands;
    return [];
  });
  return order;
}

/** The adapter the extension builds, asking this machine whether MO2 runs; the game folder setting names `game`, or a
 *  folder with no Data folder, so no Steam is asked where the game is. */
const onThisMachineOver = (root: string, { game = join(root, 'no game'), watcherExclude = watcherExcluding() }: { game?: string; watcherExclude?: WatcherExclude } = {}): InstanceAdapter =>
  adapterForInstance({
    instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(game), watcherExclude, hostGit: hostWithoutGit, installationFileReader: fakeInstallationFileReader([]),
    fileProblems: fileProblemsFake(), fomodEngine: FOMOD_ENGINE, deployedPath: DEPLOYED_PATH, scriptEnvironmentFileSetting: () => undefined,
  });

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
    adapter = adapterOver(root);
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    vi.mocked(stat).mockImplementation(actualStat);
    vi.mocked(readdir).mockImplementation(actualReaddir);
    vi.mocked(readFile).mockImplementation(actualReadFile);
    await rm(root, { recursive: true, force: true });
  });

  const deploys = async (mod: string, names: string, pathInMod = 'Root/Fallout4.ccc'): Promise<string> => {
    const file = join(root, 'mods', mod, pathInMod);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, names);
    return file;
  };

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

          expect(await adapterOver(root, { gameFolderSettingValue: game }).gameFolder()).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('answers the game folder with no depots when Steam holds no such game', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-gamefolder-'));
        try {
          await mkdir(join(game, 'Data'));

          expect(await adapterOver(root, { gameFolderSettingValue: game, detectors: NO_DETECTORS }).gamePlace()).toEqual({ root: game, depots: [], depotProblems: [] });
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it.each<[string, (library: string, steam: string) => Promise<{ game: string; reached: string; expected: object }>]>([
        ['a Steam install that is not the game folder, beside it', async (library, steam) => {
          const game = `${library}-stock`;
          await mkdir(join(game, 'Data'), { recursive: true });
          return { game, reached: steam, expected: { root: game, steamRoot: steam } };
        }],
        ['a Steam install reached through a link to the game folder, as the game folder', async (library, steam) => {
          const linked = `${library}-link`;
          await symlink(library, linked);
          return { game: steam, reached: join(linked, 'steamapps', 'common', 'Fallout 4'), expected: { root: steam } };
        }],
      ])('answers %s, with its depots', async (_case, arrange) => {
        const library = await mkdtemp(join(tmpdir(), 'mo2-instance-steamlib-'));
        try {
          const steam = join(library, 'steamapps', 'common', 'Fallout 4');
          await mkdir(join(steam, 'Data'), { recursive: true });
          await writeAppManifestOfDepot(library);
          const { game, reached, expected } = await arrange(library, steam);
          const detectors: GameDetectors = { ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: join(reached, 'Data') }) };

          expect(await adapterOver(root, { gameFolderSettingValue: game, detectors }).gamePlace()).toEqual({
            ...expected, steamApp: 377160, depots: [INSTALLED_DEPOT], depotProblems: [],
          });
        } finally {
          await rm(`${library}-link`, { force: true });
          await rm(`${library}-stock`, { recursive: true, force: true });
          await rm(library, { recursive: true, force: true });
        }
      });

      it('answers none when the game folder is not found', async () => {
        expect(await adapterOver(root, {}).gamePlace()).toBeUndefined();
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
        const nameAt = async (path: string, over: InstanceAdapter = adapter): Promise<string | undefined> => {
          const at = await over.downloadedFileAt(path);
          return expectKind(at, 'read').answer?.name;
        };

        it('answers the file for the path it is listed at', async () => {
          expect(await nameAt(join(root, listed))).toBe(DOWNLOADED_FILE);
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
      let withGame: InstanceAdapter;
      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-provided-'));
        await mkdir(join(game, 'Data'));
        withGame = adapterOver(root, { gameFolderSettingValue: game });
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const providedOver = async (over: InstanceAdapter, profile = 'Default'): Promise<PluginsProvided> => {
        let answer: PluginsProvided | undefined;
        await over.changePluginOrderOverProvided(profile, (_order, provided) => {
          answer = provided;
          return [];
        });
        return present(answer, 'the plugins provided');
      };
      const pluginsOver = async (over: InstanceAdapter, profile?: string): Promise<ReadonlyMap<string, string>> => {
        const provided = await providedOver(over, profile);
        return expectKind(provided, 'listed').plugins;
      };

      it('answers by the mod order of the profile it changes', async () => {
        await writeFile(join(root, 'mods', 'Unofficial Fallout 4 Patch', 'Unofficial Fallout 4 Patch.esp'), '');

        const plugins = await pluginsOver(withGame, 'Secondary');

        expect(['unofficial fallout 4 patch.esp', 'patch mod.esp'].map((key) => plugins.has(key))).toEqual([true, false]);
      });

      it('loads with no line each plugin of the Creation Club list an enabled mod deploys', async () => {
        await deploys('Patch Mod', 'ccDeployed.esl\r\n');

        const provided = expectKind(await providedOver(withGame), 'listed');

        expect(provided.loadedWithNoLine).toContain('ccDeployed.esl');
      });

      it('answers no plugins while the game folder is not found', async () => {
        expect(await providedOver(adapter)).toEqual({ kind: 'unresolved' });
      });

      it.each([
        ['a mod', join('mods', 'Patch Mod')],
        ['Overwrite', 'overwrite'],
      ])('lists the files at the root of %s alone when asked for its root', async (_, folder) => {
        await mkdir(join(root, folder, 'Optional'), { recursive: true });
        await writeFile(join(root, folder, 'Optional', 'Nested.esp'), '');
        await symlink(join(root, folder, 'Optional'), join(root, folder, 'Linked'));
        await writeFile(join(root, folder, 'Root.esp'), '');

        const plugins = await pluginsOver(withGame);

        expect(['root.esp', 'nested.esp'].map((key) => plugins.has(key))).toEqual([true, false]);
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

          const reading = await adapterOver(root, { gameFolderSettingValue: game }).reading();

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

          const { programVersions } = await adapterOver(root, { gameFolderSettingValue: game }).reading();

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
        const onThisMachine = onThisMachineOver(root);
        const mo2 = await runningProgram('ModOrganizer.exe');
        try {
          expect(await onThisMachine.managerRunning()).toEqual({ kind: 'running' });
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

      it('asks the platform whether MO2 is running on each call, even inside a read that trusts what is kept', async () => {
        let running = false;
        const adapter = adapterOver(root, { mo2Running: () => Promise.resolve(running) });

        const asked = await (await adapter.reading()).trustingKept(async () => {
          const before = await adapter.managerRunning();
          running = true;
          return [before, await adapter.managerRunning()];
        });

        expect(asked).toEqual([{ kind: 'notRunning' }, { kind: 'running' }]);
      });

      it('asks again where the game is when the game path the settings hold or the Data folder changes, and whether MO2 is running only at a check of the disk', async () => {
        const game = join(root, 'game');
        const asked: string[] = [];
        const adapter = adapterOver(root, {
          mo2Running: () => { asked.push('running'); return Promise.resolve(false); },
          gameFolder: () => { asked.push('game'); return Promise.resolve({ kind: 'found', root: game, dataFolder: join(game, 'Data') }); },
        });
        const askedBy = async (reread: Reread): Promise<string[]> => {
          asked.length = 0;
          await adapter.reading(reread);
          return [...asked].sort();
        };
        const first = await askedBy(CHECK_THE_DISK);
        const settings = join(root, 'ModOrganizer.ini');
        await writeFile(settings, (await readFile(settings, 'utf8')).replace(/^gamePath=.*$/m, `gamePath=@ByteArray(${join(root, 'elsewhere')})`));

        expect([first, await askedBy({ named: [settings], disk: false }), await askedBy({ named: [join(game, 'Data')], disk: false })])
          .toEqual([['game', 'running'], ['game'], ['game']]);
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
        expect([reading.dataFolderPlugins, reading.dataFolderFiles, reading.dataFolderArchives]).toEqual([{ kind: 'unresolved' }, { kind: 'unresolved' }, { kind: 'unresolved' }]);
        expect([reading.creationClubList, reading.archiveList]).toEqual([[], []]);
      });

    });

    it('names MO2 and the file it keeps mod order in', () => {
      expect(adapter.names).toEqual({ manager: 'MO2', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' });
    });

    it('refuses an instance of Skyrim, which Modbench does not support, naming it', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Skyrim\r\nselected_profile=@ByteArray(Default)\r\n');

      await expect(adapter.activeProfile()).rejects.toThrow('Modbench does not support Skyrim');
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

      const folder = await adapter.gameFolder();

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

      const downloadedFiles = (await adapter.reading()).downloadedFiles;

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

      const downloadedFiles = (await adapter.reading()).downloadedFiles;

      const idsByName = new Map((expectKind(downloadedFiles, 'listed').files ?? []).map((file) => [file.name, file.modID]));
      expect(idsByName.get('Named Mod-4321-1-0-1700000000.7z')).toBe('4321');
      expect(idsByName.get('manual.zip')).toBeUndefined();
    });

    it('answers metadata that is there but empty as metadata, so a file whose metadata is there to open does not show none', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await writeFile(join(root, 'downloads', 'manual.zip.meta'), '');

      const downloadedFiles = (await adapter.reading()).downloadedFiles;

      expect(expectKind(downloadedFiles, 'listed').files?.find((file) => file.name === 'manual.zip')?.meta).toMatchObject({ status: 'Downloaded' });
    });

    it('answers no files, rather than none, when the downloads folder is not there', async () => {
      await rm(join(root, 'downloads'), { recursive: true });

      expect((await adapter.reading()).downloadedFiles)
        .toEqual({ kind: 'listed', downloadsDir: join(root, 'downloads'), files: undefined });
    });

    it('answers where the downloads are from the same read the profile came from, so a rewrite between two answers does not land two generations in one value', async () => {
      const rewrite = vi.fn(() => {
        writeFileSync(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Secondary)\r\n[Settings]\r\ndownload_directory=@ByteArray(elsewhere)\r\n');
      });
      vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof actualReadFile>) => {
        const read = await actualReadFile(...args);
        if (args[0] === join(root, INI) && rewrite.mock.calls.length === 0) rewrite();
        return read;
      });

      const { profile, downloadedFiles } = await adapter.reading();

      expect(rewrite).toHaveBeenCalledOnce();
      expect([['Default', join(root, 'downloads')], ['Secondary', join(root, 'elsewhere')]]).toContainEqual([profile, expectKind(downloadedFiles, 'listed').downloadsDir]);
    });

    it('answers every profile, and no stray file beside them', async () => {
      await writeFile(join(root, 'profiles', 'stray.txt'), '');

      expect((await adapter.reading()).profiles).toEqual(['Default', 'Secondary']);
    });

    it('answers a profile folder that is a link to a folder, and no link to a file or to nothing', async () => {
      await mkdir(join(root, 'elsewhere', 'Linked'), { recursive: true });
      await symlink(join(root, 'elsewhere', 'Linked'), join(root, 'profiles', 'Linked'));
      await writeFile(join(root, 'elsewhere', 'file'), '');
      await symlink(join(root, 'elsewhere', 'file'), join(root, 'profiles', 'FileLink'));
      await symlink(join(root, 'nowhere'), join(root, 'profiles', 'Broken'));

      const { profiles, linkNotes } = await adapter.reading();

      expect([...profiles].sort()).toEqual(['Default', 'Linked', 'Secondary']);
      expect(linkNotes).toEqual([expect.stringContaining(join(root, 'profiles', 'Broken'))]);
    });

    it('answers a downloaded file that is a link to a file, and hands over one that links to nothing', async () => {
      await writeFile(join(root, 'elsewhere.7z'), '');
      await symlink(join(root, 'elsewhere.7z'), join(root, 'downloads', 'Linked-1-0.7z'));
      await symlink(join(root, 'nowhere.7z'), join(root, 'downloads', 'Broken-1-0.7z'));

      const { downloadedFiles, linkNotes } = await adapter.reading();

      expect(expectKind(downloadedFiles, 'listed').files?.map(({ name }) => name)).toContain('Linked-1-0.7z');
      expect(linkNotes).toEqual([expect.stringContaining(join(root, 'downloads', 'Broken-1-0.7z'))]);
    });

    it('answers no profiles when the instance has none', async () => {
      await rm(join(root, 'profiles'), { recursive: true });

      expect(await adapter.profiles()).toEqual([]);
    });

    it('rejects a profile with no mod order to read', async () => {
      await expect(adapter.changeModOrder('No Such Profile', () => [])).rejects.toThrow(/ENOENT/);
    });

    it('answers the meta and the files of a mod whose folder differs from its name only in case', async () => {
      await mkdir(join(root, 'mods', 'FOO'));
      await writeFile(join(root, 'mods', 'FOO', 'meta.ini'), '[General]\r\nversion=3.0\r\n');
      await writeFile(join(root, 'mods', 'FOO', 'Foo.esp'), '');
      await appendFile(join(root, DEFAULT_MODLIST), '+foo\n');

      const { mods, modFiles } = await adapter.reading();

      expect(mods.find((entry) => entry.name === 'foo')).toMatchObject({ version: '3.0' });
      expect(modFiles.get('foo')?.files.map((f) => f.relativePath)).toEqual(['Foo.esp']);
    });

    it('answers an empty meta for a mod with none', async () => {
      await appendFile(join(root, DEFAULT_MODLIST), '+DragIn Manual Extract\n');

      expect((await adapter.reading()).mods.find((entry) => entry.name === 'DragIn Manual Extract'))
        .toEqual({ kind: 'mod', name: 'DragIn Manual Extract', enabled: true, updateAvailable: false });
    });

    it('rejects a meta that is there but cannot be read, not publishing an unreadable meta as an empty one', async () => {
      await rm(join(root, 'mods', 'Harder VATS', 'meta.ini'));
      await mkdir(join(root, 'mods', 'Harder VATS', 'meta.ini'));

      await expect(adapter.reading()).rejects.toThrow(/EISDIR/);
    });

    it('answers every mod folder as the entry it holds, with its path and the name MO2 knows its mod by', async () => {
      const folders = (await adapter.reading()).modFolders?.all;

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

      expect((await adapter.reading()).modFolders?.all.map((f) => f.name)).not.toContain('Overwrite');
    });

    describe('a folder an install is extracting into', () => {
      const listed = async (): Promise<string[]> => present((await adapter.reading()).modFolders, 'the mod folders').all.map((f) => f.name);

      it('is listed when an interrupted install left only its extraction', async () => {
        await mkdir(join(root, 'mods', 'Left Over', '.medit_tmp_2147483646_new-abc123'), { recursive: true });

        expect(await listed()).toContain('Left Over');
      });
    });

    onPosix.it('(Windows cannot hold two names that differ only in case) answers each of two folders whose names differ only in case for the entry spelled as its own', async () => {
      await mkdir(join(root, 'mods', 'ModA'));
      await mkdir(join(root, 'mods', 'moda'));
      const folders = present((await adapter.reading()).modFolders, 'the mod folders');

      expect(folders.holding({ kind: 'mod', name: 'moda' })?.path).toBe(join(root, 'mods', 'moda'));
      expect(folders.holding({ kind: 'mod', name: 'ModA' })?.path).toBe(join(root, 'mods', 'ModA'));
    });

    it('hands over a link it cannot follow rather than answering it as a folder', async () => {
      await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));

      const { modFolders, linkNotes } = await adapter.reading();

      expect(modFolders?.all.map((f) => f.name)).not.toContain('Loop');
      expect(linkNotes).toEqual([expect.stringContaining(join(root, 'mods', 'Loop'))]);
    });

    it('answers undefined when there is no folder for mods at all', async () => {
      await rm(join(root, 'mods'), { recursive: true });

      expect((await adapter.reading()).modFolders).toBeUndefined();
    });

    it('rejects when mods/ is there but cannot be listed, only its absence meaning there is no folder for mods', async () => {
      await rm(join(root, 'mods'), { recursive: true });
      await writeFile(join(root, 'mods'), 'not a directory');

      await expect(adapter.reading()).rejects.toThrow(/ENOTDIR/);
    });

    it('rejects a profile with no plugin order to read', async () => {
      await expect(adapter.changePluginOrder('No Such Profile', () => [])).rejects.toThrow(/ENOENT/);
    });

    describe('the game folder\'s facts', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-data-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (dataFolder = join(game, 'Data')): GameFolder => ({ kind: 'found', root: game, dataFolder });
      const readingOver = (gameFolder: GameFolder, answers: AdapterAnswers = {}): Promise<InstanceReading> => adapterOver(root, { ...answers, gameFolder }).reading();

      it('answers the Data folder\'s plugins, files and archives unreadable, with why, when the Data folder cannot be listed', async () => {
        const reading = await readingOver(found(join(game, 'Missing')));

        expect([reading.dataFolderPlugins, reading.dataFolderFiles, reading.dataFolderArchives].map((fact) => expectKind(fact, 'unreadable').reason))
          .toEqual([expect.stringMatching(/ENOENT/), expect.stringMatching(/ENOENT/), expect.stringMatching(/ENOENT/)]);
      });

      describe('the game folder\'s plugins', () => {
        it('answers the plugin files at the Data folder\'s root, as the folder spells them', async () => {
          const data = join(game, 'Data');
          await mkdir(join(data, 'Nested.esp'), { recursive: true });
          await writeFile(join(data, 'Fallout4.ESM'), '');
          await writeFile(join(data, 'Patch.esp'), '');
          await writeFile(join(data, 'readme.txt'), '');

          expect((await readingOver(found())).dataFolderPlugins).toEqual({ kind: 'listed', names: new Set(['Fallout4.ESM', 'Patch.esp']) });
        });

        onPosix.it('(Windows cannot hold two names that differ only in case) answers both of two files whose names differ only in case', async () => {
          const data = join(game, 'Data');
          await mkdir(data, { recursive: true });
          await writeFile(join(data, 'Foo.esp'), '');
          await writeFile(join(data, 'foo.esp'), '');

          expect((await readingOver(found())).dataFolderPlugins).toEqual({ kind: 'listed', names: new Set(['Foo.esp', 'foo.esp']) });
        });

        it('answers no plugin that is a hard link, and hands over the link, a link being a deployed file', async () => {
          const data = join(game, 'Data');
          await mkdir(data, { recursive: true });
          await writeFile(join(root, 'Real.esp'), '');
          await writeFile(join(data, 'Own.esp'), '');
          await link(join(root, 'Real.esp'), join(data, 'Hard.esp'));

          const { dataFolderPlugins, gameFolderLinks } = await readingOver(found());

          expect([dataFolderPlugins, gameFolderLinks]).toEqual([{ kind: 'listed', names: new Set(['Own.esp']) }, 1]);
        });

        onPosix.it('(a link needs no privilege on POSIX) answers no plugin that is a symlink, broken or not, and hands over each', async () => {
          const data = join(game, 'Data');
          await mkdir(data, { recursive: true });
          await writeFile(join(game, 'Real.esp'), '');
          await symlink(join(game, 'Real.esp'), join(data, 'Soft.esp'));
          await symlink(join(game, 'nowhere.esp'), join(data, 'Broken.esp'));

          const { dataFolderPlugins, gameFolderLinks } = await readingOver(found());

          expect([dataFolderPlugins, gameFolderLinks]).toEqual([{ kind: 'listed', names: new Set() }, 2]);
        });
      });

      describe('the game folder\'s files', () => {
        it('answers every file at any depth of the Data folder, as the folder spells it and at its own path, by its path in it in lower case', async () => {
          const data = join(game, 'Data');
          await mkdir(join(data, 'F4SE', 'Plugins'), { recursive: true });
          await writeFile(join(data, 'Fallout4 - Main.ba2'), '');
          await writeFile(join(data, 'F4SE', 'Plugins', 'X.dll'), '');

          expect((await readingOver(found())).dataFolderFiles).toEqual({ kind: 'listed', files: new Map([
            ['fallout4 - main.ba2', { relativePath: 'Fallout4 - Main.ba2', path: join(data, 'Fallout4 - Main.ba2') }],
            ['f4se/plugins/x.dll', { relativePath: 'F4SE/Plugins/X.dll', path: join(data, 'F4SE/Plugins/X.dll') }],
          ]) });
        });

        it('answers no file that is a hard link, and hands over the link', async () => {
          const data = join(game, 'Data');
          await mkdir(join(data, 'F4SE'), { recursive: true });
          await writeFile(join(root, 'Real.dll'), '');
          await link(join(root, 'Real.dll'), join(data, 'F4SE', 'Hard.dll'));

          const { dataFolderFiles, gameFolderLinks } = await readingOver(found());

          expect([dataFolderFiles, gameFolderLinks]).toEqual([{ kind: 'listed', files: new Map() }, 1]);
        });
      });

      describe('the game folder\'s Creation Club list, where Mod Management takes the Creation Club plugins from', () => {
        it('answers the plugins the release\'s list names, in its order', async () => {
          await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4044-HellfirePowerArmor.esl\r\nccBGSFO4001-PipBoy(Black).esl\r\n');

          expect((await readingOver(found())).creationClubList)
            .toEqual(['ccBGSFO4044-HellfirePowerArmor.esl', 'ccBGSFO4001-PipBoy(Black).esl']);
        });

        it('answers none when the game folder holds no list', async () => {
          expect((await readingOver(found())).creationClubList).toEqual([]);
        });

        describe('the list the game gets when it runs', () => {
          const gameRead = async (): Promise<InstanceReading> => {
            await mkdir(join(game, 'Data'), { recursive: true });
            return adapterOver(root, { gameFolderSettingValue: game }).reading();
          };
          const listRead = async (): Promise<readonly string[]> => (await gameRead()).creationClubList;

          it('is the list an enabled mod deploys at the game folder\'s root, over the game folder\'s own', async () => {
            await writeFile(join(game, 'Fallout4.ccc'), 'ccOwn.esl\r\n');
            await deploys('Patch Mod', 'ccDeployed.esl\r\n');

            expect(await listRead()).toEqual(['ccDeployed.esl']);
          });

          it('is a deployed copy spelled in any case, as the game reads it', async () => {
            await deploys('Patch Mod', 'ccDeployed.esl\r\n', 'Root/fallout4.CCC');

            expect(await listRead()).toEqual(['ccDeployed.esl']);
          });

          it('is the game folder\'s own spelled in any case, as the game reads it', async () => {
            await writeFile(join(game, 'fallout4.CCC'), 'ccOwn.esl\r\n');

            expect(await listRead()).toEqual(['ccOwn.esl']);
          });

          it('notes a link it cannot follow where a mod deploys the list', async () => {
            const broken = join(root, 'mods', 'Patch Mod', 'Root', 'Fallout4.ccc');
            await mkdir(dirname(broken), { recursive: true });
            await symlink(join(root, 'nowhere.ccc'), broken);

            expect((await gameRead()).linkNotes.join('\n')).toContain(broken);
          });

          it('is never a folder a mod deploys under the list\'s name', async () => {
            await writeFile(join(game, 'Fallout4.ccc'), 'ccOwn.esl\r\n');
            await mkdir(join(root, 'mods', 'Patch Mod', 'Root', 'Fallout4.ccc'), { recursive: true });

            expect(await listRead()).toEqual(['ccOwn.esl']);
          });

          it('is the copy of the mod that wins the mod order', async () => {
            await deploys('Patch Mod', 'ccLosing.esl\r\n');
            await deploys('Ñoño\'s Retexture', 'ccWinning.esl\r\n');

            expect(await listRead()).toEqual(['ccWinning.esl']);
          });

          it('is never the copy of a disabled mod', async () => {
            await writeFile(join(game, 'Fallout4.ccc'), 'ccOwn.esl\r\n');
            await deploys('Harder VATS', 'ccDisabled.esl\r\n');

            expect(await listRead()).toEqual(['ccOwn.esl']);
          });

          it('is never a copy that deploy puts in the Data folder', async () => {
            await writeFile(join(game, 'Fallout4.ccc'), 'ccOwn.esl\r\n');
            await deploys('Patch Mod', 'ccInData.esl\r\n', 'Textures/Fallout4.ccc');

            expect(await listRead()).toEqual(['ccOwn.esl']);
          });

          it.each([['a hard link', link], ['a symlink', symlink]])('skips the game folder\'s own when it is %s, as a deploy leaves it, and counts the link once', async (_, linked) => {
            await linked(await deploys('Harder VATS', 'ccDisabled.esl\r\n'), join(game, 'Fallout4.ccc'));

            const { creationClubList, gameFolderLinks } = await gameRead();

            expect([creationClubList, gameFolderLinks]).toEqual([[], 1]);
          });
        });
      });

      describe('the archives the game\'s INIs list, where Mod Management takes the archives the game loads from', () => {
        const profileFile = (name: string): string => join(root, 'profiles', 'Default', name);
        const localSettings = (on: boolean): Promise<void> => writeFile(profileFile('settings.ini'), `[General]\nLocalSettings=${on}\n`);
        const archiveListOf = async (answers: AdapterAnswers = {}): Promise<{ archives: readonly string[]; notes: readonly string[] }> => {
          const { archiveList, archiveListNotes } = await readingOver(found(), answers);
          return { archives: archiveList, notes: archiveListNotes };
        };

        it('lists the default INI\'s archives key by key, in the order the release loads its keys, whatever the case of section, key or file', async () => {
          await writeFile(join(game, 'fallout4_default.ini'), [
            '[Display]', 'sResourceArchiveList=Not An Archive.ba2',
            '[archive]', 'SResourceArchiveList=Fallout4 - Voices.ba2, Fallout4 - Meshes.ba2',
            '; sResourceArchiveList2=Commented.ba2', 'sResourceStartUpArchiveList=Fallout4 - Startup.ba2,Fallout4 - Interface.ba2,',
          ].join('\r\n'));

          expect((await archiveListOf()).archives)
            .toEqual(['Fallout4 - Startup.ba2', 'Fallout4 - Interface.ba2', 'Fallout4 - Voices.ba2', 'Fallout4 - Meshes.ba2']);
        });

        it('reads no default INI that is a link, and hands the link over, a link being a deployed file', async () => {
          await writeFile(join(root, 'Deployed.ini'), '[Archive]\nsResourceArchiveList=Deployed.ba2\n');
          await link(join(root, 'Deployed.ini'), join(game, 'Fallout4_Default.ini'));

          const { archiveList, gameFolderLinks } = await readingOver(found());

          expect([archiveList, gameFolderLinks]).toEqual([[], 1]);
        });

        it('lists the default INI\'s archives and notes the profile by name, when it keeps no game INIs and the My Games folder is nowhere', async () => {
          await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\n');
          await localSettings(false);

          const { archives, notes } = await archiveListOf();

          expect(archives).toEqual(['Default.ba2']);
          expect(notes).toEqual([expect.stringMatching(/^The profile Default keeps no game INIs of its own/)]);
        });

        describe('while the profile keeps no game INIs of its own', () => {
          let myGames: string;
          let detectors: GameDetectors;

          beforeEach(async () => {
            const prefix = join(game, 'pfx');
            const documents = join(prefix, 'drive_c', 'users', 'steamuser', 'Documents');
            myGames = join(documents, 'My Games', 'Fallout4');
            await mkdir(myGames, { recursive: true });
            detectors = { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix), documents: () => Promise.resolve(documents) };
            await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
            await localSettings(false);
          });

          it('takes a key the My Games INIs give over the default INI\'s, the custom INI\'s over the main one\'s, with no warning', async () => {
            await writeFile(join(myGames, 'Fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
            await writeFile(join(myGames, 'Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');

            expect(await archiveListOf({ detectors })).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
          });

          it('reads a My Games INI that is a link, which is the user\'s own file and not the game folder\'s', async () => {
            await writeFile(join(root, 'Shared.ini'), '[Archive]\nsResourceArchiveList=Shared.ba2\n');
            await link(join(root, 'Shared.ini'), join(myGames, 'Fallout4.ini'));

            const { archiveList, gameFolderLinks } = await readingOver(found(), { detectors });

            expect([archiveList, gameFolderLinks]).toEqual([['Shared.ba2', 'Default2.ba2'], 0]);
          });

          it('reads none of the profile\'s INIs', async () => {
            await writeFile(profileFile('Fallout4.ini'), '[Archive]\nsResourceArchiveList=Left Behind.ba2\n');

            expect((await archiveListOf({ detectors })).archives).toEqual(['Default.ba2', 'Default2.ba2']);
          });
        });

        it('takes a key the profile\'s own INIs give over the default INI\'s, the custom INI\'s over the main one\'s, when the profile keeps its own', async () => {
          await writeFile(join(game, 'Fallout4_Default.ini'), '[Archive]\nsResourceArchiveList=Default.ba2\nsResourceArchiveList2=Default2.ba2\n');
          await writeFile(profileFile('fallout4.ini'), '[Archive]\nsResourceArchiveList=Main.ba2\nsResourceArchiveList2=Main2.ba2\n');
          await writeFile(profileFile('Fallout4Custom.ini'), '[Archive]\nsResourceArchiveList2=Custom2.ba2\n');
          await localSettings(true);

          expect(await archiveListOf()).toEqual({ archives: ['Main.ba2', 'Custom2.ba2'], notes: [] });
        });
      });

      describe('the game folder\'s archives and strings files', () => {
        it('answers the release\'s archives at the Data folder\'s root and the strings files in its strings folder, by their paths in it', async () => {
          const data = join(game, 'Data');
          await mkdir(join(data, 'STRINGS'), { recursive: true });
          await mkdir(join(data, 'Nested.ba2'), { recursive: true });
          await writeFile(join(data, 'Fallout4 - Interface.BA2'), '');
          await writeFile(join(data, 'Skyrim - Interface.bsa'), '');
          await writeFile(join(data, 'STRINGS', 'Fallout4_en.STRINGS'), '');
          await writeFile(join(data, 'STRINGS', 'readme.txt'), '');

          expect((await readingOver(found())).dataFolderArchives).toEqual({
            kind: 'listed', archives: ['Fallout4 - Interface.BA2'], stringsFiles: ['STRINGS/Fallout4_en.STRINGS'],
          });
        });

        onPosix.it('(a link needs no privilege on POSIX) answers no archive that is a symlink, and hands it over', async () => {
          const data = join(game, 'Data');
          await mkdir(data, { recursive: true });
          await writeFile(join(game, 'Real.ba2'), '');
          await symlink(join(game, 'Real.ba2'), join(data, 'Fallout4 - Soft.ba2'));

          const { dataFolderArchives, gameFolderLinks } = await readingOver(found());

          expect([dataFolderArchives, gameFolderLinks]).toEqual([{ kind: 'listed', archives: [], stringsFiles: [] }, 1]);
        });

        it('answers no archive or strings file that is a hard link, and hands over each link, a link being a deployed file', async () => {
          const data = join(game, 'Data');
          await mkdir(join(data, 'Strings'), { recursive: true });
          await writeFile(join(root, 'Real.ba2'), '');
          await writeFile(join(data, 'Fallout4 - Own.ba2'), '');
          await writeFile(join(data, 'Strings', 'Fallout4_en.STRINGS'), '');
          await writeFile(join(root, 'Fallout4_fr.STRINGS'), '');
          await link(join(root, 'Real.ba2'), join(data, 'Fallout4 - Hard.ba2'));
          await link(join(root, 'Fallout4_fr.STRINGS'), join(data, 'Strings', 'Fallout4_fr.STRINGS'));

          const { dataFolderArchives, gameFolderLinks } = await readingOver(found());

          expect([dataFolderArchives, gameFolderLinks]).toEqual([{ kind: 'listed', archives: ['Fallout4 - Own.ba2'], stringsFiles: ['Strings/Fallout4_en.STRINGS'] }, 2]);
        });
      });
    });

    describe('LOOT\'s metadata files, at the instance root', () => {
      it('answers each file\'s text, and a file that is not there as absent', async () => {
        await writeFile(join(root, 'masterlist.yaml'), 'plugins: []\n');
        await writeFile(join(root, 'userlist.yaml'), 'plugins: []\n');

        expect((await adapter.reading()).sortingRuleFiles).toEqual({
          masterlist: { path: join(root, 'masterlist.yaml'), kind: 'text', text: 'plugins: []\n' },
          prelude: { path: join(root, 'prelude.yaml'), kind: 'absent' },
          userlist: { path: join(root, 'userlist.yaml'), kind: 'text', text: 'plugins: []\n' },
        });
      });

      it('answers unreadable, with why, for a file that cannot be read as a file', async () => {
        await mkdir(join(root, 'userlist.yaml'));

        const { userlist } = (await adapter.reading()).sortingRuleFiles;

        expect(expectKind(userlist, 'unreadable').reason).toMatch(/EISDIR/);
      });
    });
  });

  describe('the watch', () => {
    afterEach(() => {
      watchers.length = 0;
    });

    const live = (): FakeWatcher[] => watchers.filter((w) => !w.disposed);

    const watcherOf = (path: string): FakeWatcher | undefined => live().find((w) => {
      const below = relativeFrom(w.base, path);
      return below !== '' && !below.startsWith('..') && matchesGlob(below.split(sep).join('/'), w.pattern);
    });
    const fire = (base: string, relativePath: string, heardAsByVsCodesMatcher = relativePath): boolean => {
      const watcher = watcherOf(join(base, heardAsByVsCodesMatcher));
      watcher?.fireChange(join(base, relativePath));
      return watcher !== undefined;
    };
    const recursive = (pattern: string): boolean => pattern.includes('**') || pattern.includes('/');

    it('watches the whole of nothing in the instance but the mods, Overwrite and the source folders, and each profile for its files', async () => {
      const watched = adapterOver(root);
      watched.subscribe(() => undefined);
      await watched.reading();

      const wholeBelow = live().filter((w) => recursive(w.pattern)).map((w) => relativeFrom(root, w.base).split(sep).join('/'));
      const patternsUnder = (folder: string): string[] => live().filter((w) => dirname(w.base) === join(root, folder)).map((w) => w.pattern);

      expect(wholeBelow.sort()).toEqual(['mods', 'overwrite', 'source']);
      expect(patternsUnder('mods')).toEqual([]);
      expect(patternsUnder('profiles')).toEqual(['{modlist.txt,plugins.txt,*.[iI][nN][iI]}', '{modlist.txt,plugins.txt,*.[iI][nN][iI]}']);
    });

    describe('where the user excludes folders from VS Code\'s watch (files.watcherExclude)', () => {
      beforeEach(() => writeFile(join(root, 'profiles', 'Default', 'settings.ini'), '[General]\nLocalSettings=true\n'));

      const wholeBelow = (): string[] => live().filter((w) => recursive(w.pattern) && !relativeFrom(root, w.base).startsWith('..'))
        .map((w) => relativeFrom(root, w.base).split(sep).join('/')).sort();
      const firstLevelOf = (folder: string): number => live().filter((w) => w.base === join(root, folder) && w.pattern === '?*').length;
      const listedWith = async (patterns: Record<string, boolean>): Promise<InstanceAdapter> => {
        await mkdir(join(root, 'mods', 'Harder VATS', 'textures', 'actors'), { recursive: true });
        await writeFile(join(root, 'mods', 'Harder VATS', 'textures', 'actors', 'a.dds'), '');
        const watched = onThisMachineOver(root, { watcherExclude: watcherExcluding(patterns) });
        watched.subscribe(() => undefined);
        return watched;
      };
      const named = async (watched: InstanceAdapter): Promise<{ folder: string; reason: string }[]> =>
        (await watched.reading()).unwatchedFolders.map(({ folder, reason }) => ({ folder: relativeFrom(root, folder).split(sep).join('/'), reason }));
      const EXCLUDED = 'excluded in files.watcherExclude';

      it('watches the mods to their first level and names them where the mods are excluded', async () => {
        const watched = await listedWith({ '**/mods/**': true });

        expect(await named(watched)).toEqual([{ folder: 'mods', reason: EXCLUDED }]);
        expect(wholeBelow()).toEqual(['overwrite', 'source']);
      });

      it('names the topmost excluded folder below a mod and watches it to its first level, the mods held whole', async () => {
        const watched = await listedWith({ '**/textures/**': true });

        expect(await named(watched)).toEqual([{ folder: 'mods/Harder VATS/textures', reason: EXCLUDED }]);
        expect(wholeBelow()).toEqual(['mods', 'overwrite', 'source']);
        expect(firstLevelOf('mods/Harder VATS/textures')).toBe(1);
      });

      it('names a mod the user excluded alone, and Overwrite where Overwrite is excluded, once each, watching Overwrite\'s first level once', async () => {
        const watched = await listedWith({ '**/mods/Harder VATS/**': true, '**/overwrite/**': true });

        expect((await named(watched)).sort((a, b) => a.folder.localeCompare(b.folder))).toEqual([
          { folder: 'mods/Harder VATS', reason: EXCLUDED }, { folder: 'overwrite', reason: EXCLUDED },
        ]);
        expect([wholeBelow(), firstLevelOf('overwrite')]).toEqual([['mods', 'source'], 1]);
      });

      it('names the game folder\'s Data folder where it is excluded, and watches its first level', async () => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-excluded-data-'));
        try {
          await mkdir(join(game, 'Data'));
          const watched = onThisMachineOver(root, { game, watcherExclude: watcherExcluding({ '**/Data/**': true }) });
          watched.subscribe(() => undefined);

          expect((await watched.reading()).unwatchedFolders).toEqual([{ folder: join(game, 'Data'), reason: EXCLUDED }]);
          const patterns = live().filter((w) => w.base === join(game, 'Data')).map((w) => w.pattern);
          expect([patterns.includes('?*'), patterns.filter((pattern) => pattern.includes('**'))]).toEqual([true, []]);
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it.each([
        ['Strings/Fallout4_en.STRINGS', true],
        ['Textures/a.dds', false],
      ])('follows the strings files of a Data folder the user excluded, in any case, once read: %s heard %s', async (name, heard) => {
        const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-excluded-strings-'));
        try {
          await mkdir(join(game, 'Data', 'Strings'), { recursive: true });
          const watched = onThisMachineOver(root, { game, watcherExclude: watcherExcluding({ '**/Data/**': true }) });
          watched.subscribe(() => undefined);

          await watched.reading();

          expect(fire(join(game, 'Data'), name)).toBe(heard);
        } finally {
          await rm(game, { recursive: true, force: true });
        }
      });

      it('names the folder holding files the user excluded, with the pattern, once for each pattern however many mods hold them', async () => {
        await writeFile(join(root, 'mods', 'Patch Mod', 'b.dds'), '');
        const watched = await listedWith({ '**/*.dds': true });

        expect(await named(watched)).toEqual([{ folder: 'mods', reason: `files matching **/*.dds are ${EXCLUDED}` }]);
        expect(wholeBelow()).toEqual(['mods', 'overwrite', 'source']);
      });

      it('names an excluded mod once, though both its root-only and its full listing name it', async () => {
        await writeFile(join(root, DEFAULT_MODLIST), (await text(root, DEFAULT_MODLIST)).replace('-Harder VATS', '+Harder VATS'));
        const watched = await listedWith({ '**/mods/Harder VATS/**': true });

        await watched.changePluginOrderOverProvided('Default', () => []);

        expect(await named(watched)).toEqual([{ folder: 'mods/Harder VATS', reason: EXCLUDED }]);
      });

      it('watches everything whole, and names no folder, once the user stops excluding them', async () => {
        let excluded: Record<string, boolean> = { '**/textures/**': true, '**/*.dds': true };
        let settingChanged = (): void => undefined;
        const watched = onThisMachineOver(root, { watcherExclude: { value: () => excluded, changed: (listener) => { settingChanged = listener; return { dispose: () => {} }; } } });
        await mkdir(join(root, 'mods', 'Harder VATS', 'textures'), { recursive: true });
        await writeFile(join(root, 'mods', 'Harder VATS', 'textures', 'a.dds'), '');
        watched.subscribe(() => undefined);
        await watched.reading();

        excluded = {};
        settingChanged();
        const watching = [wholeBelow(), firstLevelOf('mods/Harder VATS/textures')];

        expect([...watching, await named(watched)]).toEqual([['mods', 'overwrite', 'source'], 0, []]);
      });

      it('stops watching an excluded folder a later listing does not hold', async () => {
        const watched = await listedWith({ '**/textures/**': true });
        await watched.reading();
        const textures = join(root, 'mods', 'Harder VATS', 'textures');
        const watching = live().find((w) => w.base === textures);

        await rm(textures, { recursive: true });

        expect([await named(watched), watching?.disposed]).toEqual([[], true]);
      });
    });

    it('hears a file created, changed or deleted alike, each by its path, so a deleted mod folder is heard', async () => {
      const heard: (string | undefined)[] = [];
      const watched = adapterOver(root);
      watched.subscribe((path) => { heard.push(path); });
      await watched.reading();
      heard.length = 0;
      const harderVats = join(root, 'mods', 'Harder VATS');

      watcherOf(join(harderVats, 'x.esp'))?.fireCreate(join(harderVats, 'x.esp'));
      watcherOf(join(harderVats, 'x.esp'))?.fireChange(join(harderVats, 'x.esp'));
      watcherOf(harderVats)?.fireDelete(harderVats);

      expect(heard).toEqual([join(harderVats, 'x.esp'), join(harderVats, 'x.esp'), harderVats]);
    });

    it('hears a repository appear at, or vanish from, the instance root', () => {
      let signals = 0;
      adapterOver(root).subscribe(() => { signals++; });
      const entry = watcherOf(join(root, '.git'));

      entry?.fireCreate(join(root, '.git'));
      entry?.fireDelete(join(root, '.git'));

      expect(signals).toBe(2);
    });

    it('hears a repository made again at the instance root, which VS Code reports as a change of its .git', () => {
      const heard: (string | undefined)[] = [];
      adapterOver(root).subscribe((path) => { heard.push(path); });

      expect(fire(root, '.git')).toBe(true);
      expect(heard).toEqual([join(root, '.git')]);
    });

    it('arms nothing until someone listens, and disarms when the last listener leaves', () => {
      const watched = adapterOver(root);
      expect(live()).toEqual([]);

      const first = watched.subscribe(() => undefined);
      const second = watched.subscribe(() => undefined);
      expect(live().length).toBeGreaterThan(0);

      first.dispose();
      expect(live().length).toBeGreaterThan(0);
      second.dispose();
      expect(live()).toEqual([]);
    });

    it('signals a change to the game-folder setting as a change with no path, while anyone listens', () => {
      let setting: (() => void) | undefined;
      const adapter = adapterOver(root, { gameFolderSettingChanged: (listener) => {
        setting = listener;
        return { dispose: () => { setting = undefined; } };
      } });
      expect(setting).toBeUndefined();
      const heard: (string | undefined)[] = [];
      const subscription = adapter.subscribe((path) => { heard.push(path); });

      setting?.();
      expect(heard).toEqual([undefined]);

      subscription.dispose();
      expect(setting).toBeUndefined();
    });

    it.each([
      ['a profile\'s mod order', 'profiles/Default/modlist.txt', 1],
      ['another profile\'s plugin order', 'profiles/Secondary/plugins.txt', 1],
      ['the settings', 'ModOrganizer.ini', 1],
      ['a profile made', 'profiles/Third', 1],
      ['a mod\'s source', 'source/Harder VATS/plugin-source/Harder VATS.esp/a.json', 1],
      ['a file in overwrite', 'overwrite/F4SE/Plugins/x.ini', 1],
      ['a profile\'s INI, in any case', 'profiles/Default/fallout4.INI', 1],
      ['no other file of a profile', 'profiles/Default/other.txt', 0],
      ['a file deeper in a mod', 'mods/Harder VATS/Textures/a.dds', 1],
      ['the record index folder', 'modbench', 1],
      ['the hash index folder', 'hash-index', 1],
      ['the source folder', 'source', 1],
      ['the ignore list, which decides the folders git holds whole', '.gitignore', 1],
      ['.gitmodules, which names the submodules of the source folders', '.gitmodules', 1],
      ['.git/config, where git init writes the path filter and the hooks path', '.git/config', 1],
      ['.git/index, which decides the folders git holds whole', '.git/index', 1],
      ['.git/info/exclude, which decides the folders git holds whole', '.git/info/exclude', 1],
      ['.git/HEAD, which names the commit', '.git/HEAD', 1],
      ['LOOT\'s masterlist', 'masterlist.yaml', 1],
      ['LOOT\'s prelude', 'prelude.yaml', 1],
      ['the userlist', 'userlist.yaml', 1],
    ])('signals a change to %s', async (_what, relativePath, signalled) => {
      const watched = adapterOver(root);
      let signals = 0;
      watched.subscribe(() => { signals++; });
      await watched.reading();
      signals = 0;

      fire(root, relativePath);

      expect(signals).toBe(signalled);
    });

    it.each(['HEAD', 'packed-refs', 'refs/heads/main', ''])(
      'hears .git/%s in a mod\'s repository', (inside) => {
        let signals = 0;
        adapterOver(root).subscribe(() => { signals++; });

        expect(fire(root, join('source/Harder VATS/.git', inside), join('source/Harder VATS/git', inside))).toBe(true);
        expect(signals).toBe(1);
      });

    it.each<[string, string, (repository: string) => void]>([
      ['git keeps its hooks', '.git/hooks', () => undefined],
      ['core.hooksPath puts it', '.git/kept-hooks', (repository) => { execFileSync('git', ['-C', repository, 'config', 'core.hooksPath', '.git/kept-hooks']); }],
    ])('signals a change to the push check where %s, once a reading found the repository', async (_where, hooks, configure) => {
      execFileSync('git', ['init', '-q', root]);
      configure(root);
      const watched = adapterOver(root);
      let signals = 0;
      watched.subscribe(() => { signals++; });
      await watched.reading();
      signals = 0;

      expect(fire(root, `${hooks}/pre-push`)).toBe(true);
      expect(signals).toBe(1);
    });

    it('tells a ref from git\'s bookkeeping in a Windows path', () => {
      let signals = 0;
      adapterOver(root).subscribe(() => { signals++; });
      const source = watcherOf(join(root, 'source', 'A', 'x.json'));

      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\index');
      source?.fireChange('C:\\MO2\\source\\Harder VATS\\.git\\refs\\heads\\main');

      expect(signals).toBe(1);
    });

    it('hears nothing of .git/index in a mod\'s repository, git\'s own bookkeeping not reading as a change', () => {
      let signals = 0;
      adapterOver(root).subscribe(() => { signals++; });

      expect(fire(root, 'source/Harder VATS/.git/index', 'source/Harder VATS/git/index')).toBe(true);
      expect(signals).toBe(0);
    });

    it('hears a .git a mod\'s folder holds at its first level, which is the mod\'s content', async () => {
      const watched = adapterOver(root);
      let signals = 0;
      watched.subscribe(() => { signals++; });
      await watched.reading();
      signals = 0;

      expect(fire(root, 'mods/Harder VATS/.git', 'mods/Harder VATS/git')).toBe(true);
      expect(signals).toBe(1);
    });

    onPosix.describe('(VS Code\'s recursive watcher misses them only on Linux) the folders a folder heard created already held', () => {
      const mod = (): string => join(root, 'source', 'Harder VATS');
      const fireCreated = (path: string): void => {
        watcherOf(path)?.fireCreate(path);
      };

      it('signals a change inside one', async () => {
        let signals = 0;
        const subscription = adapterOver(root).subscribe(() => { signals++; });
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Weapons', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        fireCreated(mod());
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        subscription.dispose();

        expect(signalled).toBe(true);
      });

      it('signals a change inside a folder heard changed, as VS Code reports one deleted and made again in one burst', async () => {
        let signals = 0;
        const subscription = adapterOver(root).subscribe(() => { signals++; });
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        watcherOf(mod())?.fireChange(mod());
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(file, `${Date.now()}`));
        subscription.dispose();

        expect(signalled).toBe(true);
      });

      it('signals a change inside one once armed again after a disarm', async () => {
        const watched = adapterOver(root);
        const file = join(mod(), 'plugin-source', 'Harder VATS.esp', 'Gun.json');
        await mkdir(dirname(file), { recursive: true });
        let signals = 0;
        const first = watched.subscribe(() => { signals++; });
        fireCreated(mod());
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
        const watched = adapterOver(root);
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
        watcherOf(gone)?.fireDelete(gone);
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

      it('signals a change to the refs of a repository in source/, and none to git\'s object store', async () => {
        const repository = join(root, 'source', 'Repository Mod');
        const refs = join(repository, '.git', 'refs', 'heads');
        const objects = join(repository, '.git', 'objects', 'ab');
        await mkdir(refs, { recursive: true });
        await mkdir(objects, { recursive: true });
        let signals = 0;
        const subscription = adapterOver(root).subscribe(() => { signals++; });
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
        const watched = adapterOver(root);
        const subscription = watched.subscribe(() => { signals++; });
        fireCreated(repository);
        fireCreated(join(repository, '.git'));
        signals = 0;

        const signalled = await eventually(() => signals > 0, () => writeFile(join(folder, 'Gun.json'), `${Date.now()}`));
        const { unwatchedFolders } = await watched.reading();
        subscription.dispose();

        expect(signalled).toBe(true);
        expect(unwatchedFolders).toEqual([]);
      });

      it('signals no write to git\'s own bookkeeping in a source repository\'s .git', async () => {
        const repository = join(root, 'source', 'Repository Mod');
        const refs = join(repository, '.git', 'refs', 'heads');
        await mkdir(refs, { recursive: true });
        let signals = 0;
        const subscription = adapterOver(root).subscribe(() => { signals++; });
        fireCreated(repository);
        signals = 0;

        const refsSignalled = await eventually(() => signals > 0, () => writeFile(join(refs, 'main'), `${Date.now()}`));
        signals = 0;
        await writtenAndHeard(join(repository, '.git'));
        subscription.dispose();

        expect(refsSignalled).toBe(true);
        expect(signals).toBe(0);
      });

      it.skipIf(process.getuid?.() === 0)('(root reads every folder) signals a folder whose watch failed, and the next reading names it and why', async () => {
        const unreadable = join(mod(), 'Unreadable');
        await mkdir(unreadable, { recursive: true });
        await chmod(unreadable, 0o000);
        const watched = adapterOver(root);
        let signals = 0;
        const subscription = watched.subscribe(() => { signals++; });

        fireCreated(mod());
        signals = 0;
        const signalled = await eventually(() => signals > 0);
        const { unwatchedFolders } = await watched.reading();
        await chmod(unreadable, 0o755);
        subscription.dispose();

        expect(signalled).toBe(true);
        expect(unwatchedFolders).toEqual([{ folder: unreadable, reason: 'EACCES: permission denied' }]);
      });
    });

    it('follows the downloads folder the last read of the settings resolved, signalling once with no path when it moves, not the one where the instance began, so a downloaded file landing in the folder the settings name now is heard', async () => {
      let heard: (string | undefined)[] = [];
      const watched = adapterOver(root);
      watched.subscribe((path) => { heard.push(path); });
      await watched.reading();
      expect(fire(join(root, 'downloads'), 'new.7z')).toBe(true);
      heard = [];

      await writeFile(join(root, INI), `${await text(root, INI)}download_directory=@ByteArray(Elsewhere)\r\n`);
      await watched.reading();
      expect(heard).toEqual([undefined]);
      await watched.reading();
      expect(heard).toEqual([undefined]);

      expect(fire(join(root, 'downloads'), 'old.7z')).toBe(false);
      expect(fire(join(root, 'Elsewhere'), 'new.7z')).toBe(true);
    });

    it('follows everything under the game folder\'s Data folder, so a file the game folder holds is heard, at any depth', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-game-'));
      try {
        await mkdir(join(game, 'Data'));
        const watched = adapterOver(root, { gameFolderSettingValue: game });
        watched.subscribe(() => undefined);

        await watched.gameFolder();

        expect(fire(join(game, 'Data'), 'F4SE/Plugins/x.dll')).toBe(true);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it.each([
      ['Fallout4.exe', true],
      ['F4SE_Loader.EXE', true],
      ['Fallout4Launcher.exe', false],
    ])('follows the game\'s program and its script extender\'s loader at the game folder\'s root, in any case: %s heard %s', async (name, heard) => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-programs-'));
      try {
        await mkdir(join(game, 'Data'));
        const watched = adapterOver(root, { gameFolderSettingValue: game });
        watched.subscribe(() => undefined);

        await watched.gameFolder();

        expect(fire(game, name)).toBe(heard);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    describe('the Creation Club list the game gets, so a changed list does not wait for the next focus', () => {
      let game: string;
      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-ccc-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const watchedFromPatchMod = async (): Promise<void> => {
        const watched = adapterOver(root, { gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') } });
        watched.subscribe(() => undefined);
        await watched.reading();
      };

      it('follows the game folder\'s own while no origin deploys one', async () => {
        await watchedFromPatchMod();

        expect(fire(game, 'Fallout4.ccc')).toBe(true);
        expect(fire(game, 'Fallout4.ini')).toBe(false);
      });

      it('follows the copy the winning origin deploys, and not the game folder\'s own', async () => {
        const deployed = dirname(await deploys('Patch Mod', 'ccDeployed.esl\r\n'));

        await watchedFromPatchMod();

        expect(fire(deployed, 'Fallout4.ccc')).toBe(true);
        expect(fire(game, 'Fallout4.ccc')).toBe(false);
      });
    });

    it.each([
      ['fallout4_default.INI', true],
      ['Fallout4Prefs.ini', false],
    ])('follows the release\'s default INI at the game folder\'s root, in any case, once read: %s heard %s', async (name, heard) => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-watch-archives-'));
      try {
        const found: GameFolder = { kind: 'found', root: game, dataFolder: join(game, 'Data') };
        const watched = adapterOver(root, { gameFolder: found });
        watched.subscribe(() => undefined);

        await watched.reading();

        expect(fire(game, name)).toBe(heard);
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
        const watched = adapterOver(root, {
          gameFolder: found, detectors: { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix), documents: () => Promise.resolve(documents) },
        });
        watched.subscribe(() => undefined);

        await watched.reading();

        expect(fire(myGames, 'FALLOUT4CUSTOM.ini')).toBe(true);
        expect(fire(myGames, 'Fallout4Prefs.ini')).toBe(false);
      } finally {
        await rm(prefix, { recursive: true, force: true });
      }
    });

    it('follows no game folder when none is found', async () => {
      const watched = adapterOver(root);
      watched.subscribe(() => undefined);
      const before = live().length;

      await watched.gameFolder();

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

    it('answers the folder of the entry\'s own kind where a separator\'s folder and a mod\'s share a name', async () => {
      await mkdir(join(root, 'mods', 'Harder VATS_separator'));
      const folders = present((await adapter.reading()).modFolders, 'the mod folders');

      expect([folders.holding({ kind: 'mod', name: 'harder vats' })?.path, folders.holding({ kind: 'separator', name: 'Harder VATS' })?.path])
        .toEqual([join(root, 'mods', 'Harder VATS'), join(root, 'mods', 'Harder VATS_separator')]);
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
        await adapter.writeModMetadata(SEPARATOR, { version: '1', installationFile: { name: 'Other.7z' } }, TRASH);

        expect(await readFile(join(root, 'mods', SEPARATOR, 'meta.ini'), 'utf8')).toBe('[General]\nversion=9\ninstallationFile=Held.7z\n');
      });

      it('writes no meta.ini it has none of', async () => {
        await mkdir(join(root, 'mods', 'Bare_separator'));

        await adapter.writeModMetadata('Bare_separator', { version: undefined }, TRASH);

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
      const listing = (mod: string): Promise<void> => appendFile(join(root, DEFAULT_MODLIST), `+${mod}\n`);
      const filesIn = (reading: InstanceReading, origin: FileOrigin): OriginFiles =>
        (origin.kind === 'mod' ? present(reading.modFiles.get(origin.name), `the files of ${origin.name}`) : reading.runtimeOutput);
      const filesOf = async (origin: FileOrigin): Promise<OriginFiles> => filesIn(await adapter.reading(), origin);
      const relativePaths = (files: readonly { relativePath: string }[]): string[] => files.map((f) => f.relativePath).sort();

      it('walks a mod\'s folder, leaving out its metadata and writes in flight', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Textures', 'Source'), { recursive: true });
        await writeFile(join(folder, 'Textures', 'a.dds'), '');
        await writeFile(join(folder, 'Textures', 'Source', 'kept.psc'), '');
        await writeFile(`${ownTempPrefix(join(folder, 'Textures'), '')}b.tmp`, '');

        const files = await filesOf(mod('Harder VATS'));

        expect(files.origin).toBe('Harder VATS');
        expect(files.folder).toBe(folder);
        expect(relativePaths(files.files)).toEqual(['Textures/Source/kept.psc', 'Textures/a.dds']);
        expect(files.files.find((f) => f.relativePath === 'Textures/a.dds'))
          .toMatchObject({ path: join(folder, 'Textures', 'a.dds'), sourcePath: join(folder, 'Textures', 'a.dds') });
        expect(files.folders).toEqual([
          { relativePath: 'Textures', path: join(folder, 'Textures'), includedPath: 'Textures', excluded: false },
          { relativePath: 'Textures/Source', path: join(folder, 'Textures', 'Source'), includedPath: 'Textures/Source', excluded: false },
        ]);
      });

      describe('read again', () => {
        const folder = (): string => join(root, 'mods', 'Harder VATS');
        const callsOn = (spy: typeof readdir | typeof stat, path: string): number => vi.mocked(spy).mock.calls.filter(([called]) => String(called) === path).length;
        const settled = async (): Promise<void> => {
          await mkdir(join(folder(), 'Textures'), { recursive: true });
          await writeFile(join(folder(), 'Textures', 'a.dds'), '');
          await fileSystemClockMovedOn();
          vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
        };
        const told = (...named: string[]): Promise<InstanceReading> => adapter.reading({ named, disk: false });
        afterEach(() => vi.useRealTimers());

        it.each([
          ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
          ['Overwrite', { kind: 'runtimeOutput' as const }, 'overwrite'],
        ])('answers the same files for %s while no folder it walked has changed', async (_, origin, below) => {
          await mkdir(join(root, 'overwrite', 'Textures'), { recursive: true });
          await writeFile(join(root, 'overwrite', 'Textures', 'a.dds'), '');
          await settled();
          const first = await filesOf(origin);
          const walked = callsOn(readdir, join(root, below, 'Textures'));

          const second = filesIn(await told(), origin);

          expect([second, callsOn(readdir, join(root, below, 'Textures'))]).toEqual([first, walked]);
        });

        it('answers new files once a folder below the mod\'s root has changed', async () => {
          await mkdir(join(folder(), 'Textures', 'Source'), { recursive: true });
          await settled();
          await filesOf(mod('Harder VATS'));
          await writeFile(join(folder(), 'Textures', 'Source', 'deep.psc'), '');

          const second = filesIn(await told(join(folder(), 'Textures', 'Source', 'deep.psc')), mod('Harder VATS'));

          expect(relativePaths(second.files)).toContain('Textures/Source/deep.psc');
        });

        it('walks again a folder changed within the settle window, as its stamp may not change for a write that follows', async () => {
          await mkdir(join(folder(), 'Textures'), { recursive: true });
          await writeFile(join(folder(), 'Textures', 'a.dds'), '');

          await filesOf(mod('Harder VATS'));
          const walked = callsOn(readdir, join(folder(), 'Textures'));
          await told();

          expect(callsOn(readdir, join(folder(), 'Textures'))).toBeGreaterThan(walked);
        });

        it('does not keep a walk that met a folder removed mid-read, though the stamp of the folder above it did not change', async () => {
          await mkdir(join(folder(), 'Gone'), { recursive: true });
          await writeFile(join(folder(), 'Gone', 'Lost.esp'), '');
          await settled();
          const rootStamp = await actualStat(folder(), { bigint: true });
          vi.mocked(stat).mockImplementation(async (path, ...rest) => {
            const facts = await actualStat(path, ...rest);
            const { size, mtimeNs } = rootStamp;
            return String(path) === folder() ? Object.assign(facts, { size, mtimeNs }) : facts;
          });
          vi.mocked(readdir).mockImplementation(async (path, options) => {
            if (String(path) === join(folder(), 'Gone')) await rm(path, { recursive: true, force: true });
            return actualReaddir(path, options);
          });

          const first = await filesOf(mod('Harder VATS'));
          const walked = callsOn(stat, join(folder(), 'Gone'));
          const second = filesIn(await told(), mod('Harder VATS'));

          expect(first.notes).toEqual([expect.stringMatching(/Gone/)]);
          expect(callsOn(stat, join(folder(), 'Gone'))).toBeGreaterThan(walked);
          expect(second.notes).toEqual([expect.stringMatching(/Gone/)]);
        });

        it('walks a mod that links to a file again each time, as a link\'s target is not stamped', async () => {
          await settled();
          await symlink(join(folder(), 'Textures', 'a.dds'), join(folder(), 'Linked.dds'));

          await filesOf(mod('Harder VATS'));
          const followed = callsOn(stat, join(folder(), 'Linked.dds'));
          await told();

          expect(callsOn(stat, join(folder(), 'Linked.dds'))).toBeGreaterThan(followed);
        });
      });

      it('leaves out a manifest at its root, whatever its name, as a folder renamed outside Modbench keeps the name it had, and keeps a file below the root that bears the name', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'docs'), { recursive: true });
        await writeFile(join(folder, 'Old Name.manifest.json'), '{}');
        await writeFile(join(folder, 'docs', 'Harder VATS.manifest.json'), '{}');

        const files = await filesOf(mod('Harder VATS'));

        expect(relativePaths(files.files)).toEqual(['docs/Harder VATS.manifest.json']);
      });

      it('leaves out a temp left by a dead writer, at any depth', async () => {
        const temp = '.medit_tmp_12_ab.tmp';
        const folder = join(root, 'mods', 'Harder VATS');
        await mkdir(join(folder, 'Meshes', temp), { recursive: true });
        await writeFile(join(folder, 'Meshes', temp, 'inside.nif'), '');
        await writeFile(join(folder, 'Meshes', 'kept.nif'), '');
        await writeFile(join(folder, temp), '');

        const { files, folders } = await filesOf(mod('Harder VATS'));

        expect([...relativePaths(files), ...folders.map((f) => f.relativePath)].filter((path) => path.includes(temp))).toEqual([]);
        expect(relativePaths(files)).toContain('Meshes/kept.nif');
      });

      it('reads a linked file from where the link points, and places it where the link sits, and notes a broken link rather than failing', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(folder, 'Linked.esp'));
        await symlink(join(root, 'nowhere.esp'), join(folder, 'Broken.esp'));

        const files = await filesOf(mod('Harder VATS'));

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

        const paths = relativePaths((await filesOf(mod('Harder VATS'))).files);

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

        const files = await filesOf(origin);
        const excludedOf = (entries: readonly { relativePath: string; excluded: boolean }[], relativePath: string) =>
          entries.find((entry) => entry.relativePath === relativePath)?.excluded;

        expect(['Textures.mohidden/Armour/a.dds', 'Hidden.esp.MOHIDDEN', 'Kept.esp'].map((path) => excludedOf(files.files, path)))
          .toEqual([true, true, false]);
        expect(['Textures.mohidden', 'Textures.mohidden/Armour'].map((path) => excludedOf(files.folders, path))).toEqual([true, true]);
        expect(files.folders.filter(({ relativePath }) => relativePath.startsWith('Textures.mohidden')).map(({ includedPath }) => includedPath))
          .toEqual(['Textures', 'Textures/Armour']);
      });

      it('says which files their own mark excludes, apart from their folder, and the path each has unmarked', async () => {
        await mkdir(join(root, 'mods', 'Harder VATS', 'Textures.mohidden'), { recursive: true });
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'a.dds'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Textures.mohidden', 'b.dds.mohidden'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Hidden.esp.MOHIDDEN'), '');
        await writeFile(join(root, 'mods', 'Harder VATS', 'Kept.esp'), '');

        const { files } = await filesOf(mod('Harder VATS'));
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

        const files = await filesOf(mod('Harder VATS'));

        expect(files.files.find((f) => f.relativePath === 'linked/foo.dds')?.path).toBe(join(root, 'mods', 'Harder VATS', 'linked', 'foo.dds'));
        expect(files.folders).toContainEqual({ relativePath: 'linked', path: join(root, 'mods', 'Harder VATS', 'linked'), includedPath: 'linked', excluded: false });
      });

      it('notes a link cycle and walks each file once', async () => {
        const folder = join(root, 'mods', 'Cycle');
        await mkdir(folder);
        await writeFile(join(folder, 'sibling.dds'), '');
        await symlink(folder, join(folder, 'loop'));

        await listing('Cycle');

        const files = await filesOf(mod('Cycle'));

        expect(relativePaths(files.files)).toEqual(['sibling.dds']);
        expect(files.notes.join('\n')).toMatch(/cycle.*loop/);
      });

      it.each([
        ['the overwrite folder', { kind: 'runtimeOutput' as const }, 'overwrite'],
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
      ])('lists the rest of %s and notes a folder below it that cannot be read', async (_name, origin, below) => {
        const held = join(root, below, 'Textures', 'Locked');
        await mkdir(held, { recursive: true });
        await writeFile(join(root, below, 'Textures', 'a.dds'), '');
        vi.mocked(readdir).mockImplementation(async (path, options) => {
          if (String(path) === held) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return actualReaddir(path, options);
        });

        const first = await filesOf(origin);
        const listings = (): number => vi.mocked(readdir).mock.calls.filter(([path]) => String(path) === held).length;
        const walked = listings();
        await filesOf(origin);

        expect(relativePaths(first.files)).toContain('Textures/a.dds');
        expect(first.notes).toEqual([expect.stringMatching(/Locked.*EACCES/)]);
        expect(listings()).toBeGreaterThan(walked);
      });

      describe.each([
        ['the overwrite folder', { kind: 'runtimeOutput' as const }, 'overwrite'],
        ['a mod', mod('Harder VATS'), join('mods', 'Harder VATS')],
      ])('a folder of %s that becomes unreadable after a read', (_name, origin, below) => {
        it('names the folder and lists none of its files when a read the watch asked for meets a folder below it unreadable', async () => {
          const locked = join(root, below, 'Textures', 'Locked');
          await mkdir(join(locked, 'Deeper'), { recursive: true });
          await writeFile(join(locked, 'hidden.txt'), '');
          await writeFile(join(locked, 'Deeper', 'deeper.txt'), '');
          await writeFile(join(root, below, 'Textures', 'a.dds'), '');
          const longAgo = new Date('2020-01-01');
          for (const folder of [locked, join(root, below, 'Textures'), join(root, below)]) await utimes(folder, longAgo, longAgo);
          const filesFirst = async (path: PathLike, options: Parameters<typeof actualReaddir>[1]) =>
            [...await actualReaddir(path, options)].sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()));
          vi.mocked(readdir).mockImplementation(filesFirst);
          await filesOf(origin);
          vi.mocked(readdir).mockImplementation(async (path: PathLike, options: Parameters<typeof actualReaddir>[1]) => {
            if (String(path) === locked || String(path).startsWith(locked + sep)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            return filesFirst(path, options);
          });
          vi.mocked(stat).mockImplementation(async (path, ...rest) => {
            if (String(path).startsWith(locked + sep)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            return actualStat(path, ...rest);
          });
          const answer = filesIn(await adapter.reading({ named: [], disk: false }), origin);

          expect(relativePaths(answer.files).filter((path) => path.startsWith('Textures/'))).toEqual(['Textures/a.dds']);
          expect(relativePaths(answer.folders).filter((path) => path.startsWith('Textures'))).toEqual(['Textures', 'Textures/Locked']);
          expect(answer.notes.join('\n')).toContain(`"${locked}" cannot be read`);
        });
      });

      it('rejects when a link\'s target cannot be checked for a reason other than its absence, simulated through a mocked stat as chmod denies nothing when the runner is root', async () => {
        const folder = join(root, 'mods', 'Harder VATS');
        await symlink(join(root, 'whatever.dds'), join(folder, 'restricted.dds'));
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('restricted.dds')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return actualStat(path, ...rest);
        });

        await expect(adapter.reading()).rejects.toThrow(/permission denied/);
      });

      onPosix.it('notes a FIFO and a link to one, and answers neither as a file, built with the POSIX mkfifo that Windows lacks', async () => {
        const folder = join(root, 'mods', 'Pipes');
        await mkdir(folder);
        execFileSync('mkfifo', [join(folder, 'pipe')]);
        execFileSync('mkfifo', [join(root, 'real-pipe')]);
        await symlink(join(root, 'real-pipe'), join(folder, 'linked-pipe'));

        await listing('Pipes');

        const files = await filesOf(mod('Pipes'));

        expect(files.files).toEqual([]);
        expect(files.notes.join('\n')).toMatch(/pipe/);
        expect(files.notes.join('\n')).toMatch(/linked-pipe/);
        expect(files.notes).toHaveLength(2);
      });

      it('answers no files for a mod with no folder, or a name that gives it none', async () => {
        await listing('No Such Mod');
        await listing('../profiles');

        const reading = await adapter.reading();

        expect(filesIn(reading, mod('No Such Mod')).files).toEqual([]);
        expect(filesIn(reading, mod('../profiles'))).toEqual({ origin: '../profiles', folder: undefined, files: [], folders: [], notes: [] });
      });

      it('lists everything the game wrote at run time, under the reserved origin, without writes in flight', async () => {
        const folder = join(root, 'overwrite');
        await writeFile(join(folder, 'Stray.esp'), '');
        await writeFile(`${ownTempPrefix(folder, '')}stray.tmp`, '');

        const files = await filesOf({ kind: 'runtimeOutput' });

        expect(files.origin).toBe(OVERWRITE_ORIGIN);
        expect(files.folder).toBe(folder);
        expect(relativePaths(files.files)).toContain('Stray.esp');
        expect(relativePaths(files.files).some((path) => path.startsWith('F4SE/'))).toBe(true);
        expect(files.files.every((f) => !f.relativePath.endsWith('.tmp'))).toBe(true);
        expect(files.folders).toContainEqual({ relativePath: 'F4SE', path: join(folder, 'F4SE'), includedPath: 'F4SE', excluded: false });
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

        const files = await filesOf(origin);

        expect(relativePaths(files.files)).toContain(kept);
        expect(relativePaths(files.files)).not.toContain('Gone/Lost.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Gone/)]);
      });

      it('notes a link in the overwrite folder, which it does not follow, rather than skipping it with no word and dropping its file from the picture', async () => {
        const target = join(root, 'elsewhere.esp');
        await writeFile(target, '');
        await symlink(target, join(root, 'overwrite', 'Linked.esp'));

        const files = await filesOf({ kind: 'runtimeOutput' });

        expect(relativePaths(files.files)).not.toContain('Linked.esp');
        expect(files.notes).toEqual([expect.stringMatching(/Linked\.esp/)]);
      });

      it('answers no files when there is no overwrite folder', async () => {
        await rm(join(root, 'overwrite'), { recursive: true });

        expect((await filesOf({ kind: 'runtimeOutput' })).files).toEqual([]);
      });
    });

    describe('a mod\'s repository', () => {

      it('answers a mod\'s source folder beside mods/, whether or not it is there, and none for a name that reaches outside it', () => {
        expect(adapter.sourceFolder('Harder VATS')).toBe(join(root, 'source', 'Harder VATS'));
        expect(adapter.sourceFolder('No Such Mod')).toBe(join(root, 'source', 'No Such Mod'));
        expect(adapter.sourceFolder('../Harder VATS')).toBeUndefined();
      });

      it('lists every repository under the source folder that holds its build file by its name, with its folder, and no folder without a `.git` the instance repository does not track', async () => {
        await mkdir(join(root, 'source', 'Harder VATS', '.git'), { recursive: true });
        await writeFile(join(root, 'source', 'Harder VATS', BUILD_FILE), '{}');
        await mkdir(join(root, 'source', 'No Repository'), { recursive: true });
        await writeFile(join(root, 'source', 'No Repository', BUILD_FILE), '{}');

        expect(await adapter.sourceModFolders()).toEqual(new Map([['Harder VATS', join(root, 'source', 'Harder VATS')]]));
      });

      it('lists none when the instance has no source folder', async () => {
        expect(await adapter.sourceModFolders()).toEqual(new Map());
      });
    });

    describe('a mod\'s installation file', () => {
      it('answers no installation file for a mod whose meta records none, and its meta as the mod manager\'s own file', async () => {
        expect(await adapter.installationFile('DragIn Manual Extract')).toEqual({ kind: 'read', answer: undefined });
        expect(adapter.metadataFilesInModFolder).toEqual(['meta.ini']);
      });
    });

    describe('a mod\'s installation files', () => {
      const ENTRY = 'textures/a.dds';

      it('answers the downloaded file its meta names, in the downloads folder, with its size and hash and each entry\'s', async () => {
        const answer = await adapterOver(root, { installationFileReader: fakeInstallationFileReader([ENTRY]) }).installationFile('Unofficial Fallout 4 Patch');

        expect(answer).toEqual({
          kind: 'read',
          answer: { path: join(root, 'downloads', DOWNLOADED_FILE), size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: ENTRY, hash: 'q7ZLRnu1+Os=' }] },
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
          return expectKind(await adapter.modMetadata('Unofficial Fallout 4 Patch'), 'read').answer.installationFile?.page;
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
          }, TRASH);

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

          await adapter.writeModMetadata(PATCH, metadata, TRASH);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        it('leaves metadata byte for byte when the manifest says the version it holds', async () => {
          const held = await holding(mo2Written('2.0'));

          await adapter.writeModMetadata(PATCH, { version: '2.0', installationFile: { name: DOWNLOADED_FILE } }, TRASH);

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

        it('reads the page of a mod of a game Modbench does not support on that game\'s domain, and writes it back as held', async () => {
          const skyrimPage = 'https://www.nexusmods.com/skyrim/mods/600?tab=files&file_id=901';
          const held = await holding(metaWith('gameName=Skyrim\r\nmodid=600\r\n', [['600', '901']]));

          expect(expectKind(await adapter.modMetadata(PATCH), 'read').answer.installationFile?.page).toBe(skyrimPage);
          await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE, page: skyrimPage } }, TRASH);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        it.each(WRITTEN)('writes the modid the manifest page names over %s', async (_name, text, page, modId, pairs) => {
          await holding(text);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE, page } }, TRASH);

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

            await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE, page } }, TRASH);

            expect(await pageHeld()).toBe(true);
            expect((await readFile(metaOf(PATCH), 'utf8')) === held).toBe(!differed);
          },
        );

        it('changes only the value that differs', async () => {
          const held = await holding(mo2Written('1.0'));

          await adapter.writeModMetadata(PATCH, { version: '2.0', installationFile: { name: DOWNLOADED_FILE } }, TRASH);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held.replace('version=1.0', 'version=2.0'));
        });

        it('keeps the version the manifest lacks', async () => {
          await patchMeta(`installationFile=${DOWNLOADED_FILE}\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: DOWNLOADED_FILE } }, TRASH);

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: DOWNLOADED_FILE, page: 'https://www.nexusmods.com/fallout4/mods/4598' } }));
        });

        it('gives a file the manifest names another name no page of the file it replaces, and keeps every other key', async () => {
          await patchMeta(`installationFile=${DOWNLOADED_FILE}\r\n\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=77\r\nsize=1\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: 'Patch-3.7z' } }, TRASH);

          expect(await adapter.modMetadata(PATCH)).toEqual(read({ version: '2.1.5.0', installationFile: { name: 'Patch-3.7z' } }));
          expect(await readFile(metaOf(PATCH), 'utf8')).toContain(CHROME);
        });

        it("writes MO2's short name for the instance's game for a domain the instance's game has", async () => {
          await writeFile(join(root, INI), (await readFile(join(root, INI), 'utf8')).replace(/gameName=.*/, 'gameName=Fallout 4 VR'));
          await holding(`[General]\r\ngameName=SkyrimSE\r\n`);

          await adapter.writeModMetadata(PATCH, { installationFile: { name: 'P.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }, TRASH);

          expect(await readFile(metaOf(PATCH), 'utf8')).toContain('gameName=Fallout4VR');
        });

        it('writes nothing for metadata that says nothing', async () => {
          await adapter.writeModMetadata('Brand New', {}, TRASH);

          await expect(access(metaOf('Brand New'))).rejects.toThrow();
        });

        it('makes the metadata of a mod with none, in its folder', async () => {
          await adapter.writeModMetadata('Brand New', { version: '1.0' }, TRASH);

          expect(await readFile(metaOf('Brand New'), 'utf8')).toContain('version=1.0');
        });

        it.each([
          ['a Nexus domain with no game', 'https://www.nexusmods.com/nowhere/mods/1', 'nowhere'],
          ['a page that is not a Nexus one', 'https://gitlab.com/a/b', 'https://gitlab.com/a/b'],
        ])('cannot write a page naming %s, says why, and writes nothing', async (_name, page, mentioned) => {
          const held = await holding(mo2Written('1.0'));
          const metadata = { version: '9', installationFile: { name: 'P.7z', page } };

          expect(await adapter.unwritableMetadata(PATCH, metadata)).toContain(mentioned);
          await expect(adapter.writeModMetadata(PATCH, metadata, TRASH)).rejects.toThrow(mentioned);

          expect(await readFile(metaOf(PATCH), 'utf8')).toBe(held);
        });

        it('can write a page naming a game the tables hold', async () => {
          expect(await adapter.unwritableMetadata(PATCH, { installationFile: { name: 'P.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } })).toBeUndefined();
        });

        it('reads back as what it was handed', async () => {
          const written = { version: '3.0', installationFile: { name: 'Patch-3.7z', page: 'https://www.nexusmods.com/starfield/mods/5?tab=files&file_id=6' } };

          await adapter.writeModMetadata('Brand New', written, TRASH);

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
          writeFile(join(root, 'mods', 'Unofficial Fallout 4 Patch', 'meta.ini'), installationFileMeta(path));

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

      it('answers unreadable, saying this machine does not hold the downloaded file and no system error, when it is gone', async () => {
        await rm(join(root, 'downloads', DOWNLOADED_FILE));

        const answer = await adapter.installationFile('Unofficial Fallout 4 Patch');

        expect(expectKind(answer, 'unreadable').reason).toBe(`this machine does not hold ${DOWNLOADED_FILE}, the file it is installed from`);
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
      it('answers the file of that name in the downloads folder, with its page, size and hash and each entry\'s', async () => {
        const answer = await adapterOver(root, { installationFileReader: fakeInstallationFileReader(['textures/a.dds']) }).downloadedFile(DOWNLOADED_FILE);

        expect(answer).toEqual({
          kind: 'read', answer: { path: join(root, 'downloads', DOWNLOADED_FILE), page: 'https://www.nexusmods.com/fallout4/mods/4598', size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: 'textures/a.dds', hash: 'q7ZLRnu1+Os=' }] },
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

    describe('a downloaded file by its bytes', () => {
      const holding = () => adapterOver(root, { installationFileReader: fakeInstallationFileReader(['textures/a.dds']) });
      const renamed = (): string => join(root, 'downloads', 'Renamed-copy.7z');

      it('answers the file with that size and hash, whatever its name', async () => {
        await actualRename(join(root, 'downloads', DOWNLOADED_FILE), renamed());

        expect(await holding().downloadedFileHolding({ size: 28, hash: 'yMPjZVarjmw=' })).toEqual({
          file: { path: renamed(), size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: 'textures/a.dds', hash: 'q7ZLRnu1+Os=' }] }, notes: [],
        });
      });

      it('answers none for a file of that size with other bytes', async () => {
        expect(await holding().downloadedFileHolding({ size: 28, hash: 'AAAAAAAAAAA=' })).toEqual({ file: undefined, notes: [] });
      });

      it('passes over a file it cannot read, saying why, and answers the one that holds the bytes', async () => {
        await writeFile(join(root, 'downloads', 'Locked.7z'), 'x');
        await actualRename(join(root, 'downloads', DOWNLOADED_FILE), renamed());
        vi.mocked(stat).mockImplementation(async (path, ...rest) => {
          if (String(path).endsWith('Locked.7z')) throw new Error('EACCES');
          return actualStat(path, ...rest);
        });

        expect(await holding().downloadedFileHolding({ size: 28, hash: 'yMPjZVarjmw=' })).toMatchObject({ file: { path: renamed() }, notes: ['Locked.7z could not be read: EACCES'] });
      });
    });

    describe('every downloaded file', () => {
      const hashing = () => adapterOver(root, { installationFileReader: fakeInstallationFileReader(['textures/a.dds']) });

      it('answers each file of the downloads folder, never hashed before, with its page, its size and hash and each entry\'s', async () => {
        expect(await hashing().downloadedFilesHashed()).toEqual({
          files: [{ path: join(root, 'downloads', DOWNLOADED_FILE), page: 'https://www.nexusmods.com/fallout4/mods/4598', size: 28, hash: 'yMPjZVarjmw=', entries: [{ path: 'textures/a.dds', hash: 'q7ZLRnu1+Os=' }] }],
          notes: [],
        });
      });

      it('gives a file the page its metadata names, with the file, else the mod its name carries', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\ngameName=Fallout4\r\nmodID=7\r\nfileID=78\r\n');

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [{ page: 'https://www.nexusmods.com/fallout4/mods/7?tab=files&file_id=78' }] });
      });

      it('gives a file the direct URL its metadata names, whether or not it names a Nexus file', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\ndirectURL=https://f4se.silverlock.org/beta/f4se_0_06_23.7z\r\n');

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [{ directUrl: 'https://f4se.silverlock.org/beta/f4se_0_06_23.7z' }] });
      });

      it('gives a file the version its metadata names', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\nversion=1.2.3\r\n');

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [{ version: '1.2.3' }] });
      });

      it('gives a file of a game Modbench does not support the page its metadata names, on that game\'s domain', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\ngameName=Skyrim\r\nmodID=7\r\nfileID=78\r\n');

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [{ page: 'https://www.nexusmods.com/skyrim/mods/7?tab=files&file_id=78' }], notes: [] });
      });

      it('names no page and no note for a file of a game with no domain', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\ngameName=EnderalSE\r\nmodID=7\r\n');

        const { files, notes } = await hashing().downloadedFilesHashed();

        expect([files[0]?.page, notes]).toEqual([undefined, []]);
      });

      it('keeps the direct URL of a file of a game with no domain that names a mod ID', async () => {
        await writeFile(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`), '[General]\r\ngameName=EnderalSE\r\nmodID=7\r\ndirectURL=https://example.com/a.7z\r\n');

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [{ page: undefined, directUrl: 'https://example.com/a.7z' }], notes: [] });
      });

      it('costs a file its page alone, saying why, when its metadata cannot be read', async () => {
        await rm(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`));
        await mkdir(join(root, 'downloads', `${DOWNLOADED_FILE}.meta`));

        expect(await hashing().downloadedFilesHashed()).toMatchObject({
          files: [{ path: join(root, 'downloads', DOWNLOADED_FILE), page: undefined, hash: 'yMPjZVarjmw=', pageUnreadable: expect.any(String) as unknown }],
          notes: [],
        });
      });

      it('answers none, saying why, when the downloads folder cannot be resolved', async () => {
        await rm(join(root, INI));

        expect(await hashing().downloadedFilesHashed()).toMatchObject({ files: [], notes: [expect.stringContaining('the downloads folder could not be read') as unknown] });
      });

      it('answers none when the downloads folder the settings name is absent', async () => {
        await writeFile(join(root, INI), `${await text(root, INI)}download_directory=@ByteArray(Elsewhere)\r\n`);

        expect(await hashing().downloadedFilesHashed()).toEqual({ files: [], notes: [] });
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
    it.each(['a\\b', '..', '.', ''])('refuses to create a folder for a name that reaches outside the mods folder: %j', async (name) => {
      const before = await modFolderNames(root);

      await expect(adapter.createModFolder(name)).rejects.toThrow(`Not a valid mod name: "${name}"`);

      expect(await modFolderNames(root)).toEqual(before);
    });

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

    it('counts a folder another program moved to the new name as renamed, and moves nothing', async () => {
      await actualRename(join(root, 'mods', 'Harder VATS'), join(root, 'mods', 'Harder VATS 2'));
      const moved = await snapshotTree(root);

      await adapter.renameModFolder('Harder VATS', 'Harder VATS 2');

      assertOnlyChanged(moved, await snapshotTree(root), new Set());
    });

    it('refuses a name another mod\'s folder holds when the mod\'s own folder is gone, never counting it as renamed', async () => {
      await rm(join(root, 'mods', 'Harder VATS'), { recursive: true });

      await expect(adapter.renameModFolder('Harder VATS', 'Patch Mod')).rejects.toThrow('Mod not found in modlist: Harder VATS');
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

  describe('excluding and including a file of a mod or Overwrite', () => {
    const modOrigin = { kind: 'mod' as const, name: 'Harder VATS' };

    const overwrite = { kind: 'runtimeOutput' as const };
    const put = async (path: string, content = ''): Promise<void> => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    };

    it.each(['textures//a.dds', 'textures\\..\\a.dds'])('refuses a path that reaches outside the origin: %s', async (path) => {
      const folder = join(root, 'mods', 'Harder VATS');
      const notAFile = `Not a file of mod "Harder VATS": "${path}"`;

      await expect(adapter.originFile(modOrigin, path)).rejects.toThrow(notAFile);
      await expect(adapter.markOriginFile(modOrigin, path, 'Excluded')).rejects.toThrow(notAFile);
      await expect(adapter.trashFileIn(folder, path, TRASH)).rejects.toThrow(`Not a file or folder of "${folder}": "${path}"`);
    });

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

    it('changes nothing when a mark would replace a file already at the new name', async () => {
      const folder = join(root, 'mods', 'Harder VATS');
      await put(join(folder, 'a.dds'), 'mine');
      await put(join(folder, 'a.dds.mohidden'), 'theirs');
      const before = await snapshotTree(root);

      await adapter.markOriginFile(modOrigin, 'a.dds', 'Excluded');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('takes a mod named overwrite for a mod, never for Overwrite', async () => {
      await put(join(root, 'mods', 'overwrite', 'a.esp'));
      await put(join(root, 'overwrite', 'a.esp'));

      expect(await adapter.markOriginFile({ kind: 'mod', name: 'overwrite' }, 'a.esp', 'Excluded')).toEqual({ gone: false, wrote: true, relativePath: 'a.esp.mohidden' });

      expect(await isThere(join(root, 'mods', 'overwrite', 'a.esp.mohidden'))).toBe(true);
      expect(await isThere(join(root, 'overwrite', 'a.esp'))).toBe(true);
    });

    describe('moving files into Overwrite', () => {
      const elsewhere = (name: string): string => join(root, 'deployed', name);

      it('moves each file to its path in Overwrite, making the folders', async () => {
        await put(elsewhere('settings.ini'), 'mine');
        await put(elsewhere('b.txt'), 'other');

        await adapter.moveIntoOverwrite([{ from: elsewhere('settings.ini'), relativePath: 'MCM/settings.ini' }, { from: elsewhere('b.txt'), relativePath: 'Root/b.txt' }]);

        expect([await text(root, join('overwrite', 'MCM', 'settings.ini')), await text(root, join('overwrite', 'Root', 'b.txt')), await isThere(elsewhere('settings.ini')), await isThere(elsewhere('b.txt'))])
          .toEqual(['mine', 'other', false, false]);
      });

      it('refuses, and moves nothing, when Overwrite already holds a file at one path', async () => {
        await put(elsewhere('a.txt'), 'mine');
        await put(elsewhere('b.txt'), 'mine');
        await put(join(root, 'overwrite', 'b.txt'), 'theirs');

        const refusal = await adapter.moveIntoOverwrite([{ from: elsewhere('a.txt'), relativePath: 'a.txt' }, { from: elsewhere('b.txt'), relativePath: 'b.txt' }]);

        expect(refusal).toBe('"b.txt" is already in Overwrite.');

        expect([await isThere(elsewhere('a.txt')), await isThere(join(root, 'overwrite', 'a.txt')), await text(root, join('overwrite', 'b.txt'))]).toEqual([true, false, 'theirs']);
      });

      it('refuses a path that leaves Overwrite', async () => {
        await put(elsewhere('a.txt'), 'mine');

        expect(await adapter.moveIntoOverwrite([{ from: elsewhere('a.txt'), relativePath: '../mods/a.txt' }])).toBe('Not a file of Overwrite: "../mods/a.txt"');

        expect(await isThere(elsewhere('a.txt'))).toBe(true);
      });

      it('refuses, and moves nothing, when two files move to paths that differ only in case', async () => {
        await put(elsewhere('1'), 'first');
        await put(elsewhere('2'), 'second');

        const refusal = await adapter.moveIntoOverwrite([{ from: elsewhere('1'), relativePath: 'a/X.ini' }, { from: elsewhere('2'), relativePath: 'a/x.INI' }]);

        expect([refusal, await text(root, join('deployed', '1')), await text(root, join('deployed', '2')), await isThere(join(root, 'overwrite', 'a/X.ini'))])
          .toEqual(['More than one file is moving to "a/x.INI" in Overwrite.', 'first', 'second', false]);
      });

      it('puts back the files before the one that failed to move, and leaves Overwrite as it was, the folders it made included', async () => {
        await put(elsewhere('a.txt'), 'mine');

        await expect(adapter.moveIntoOverwrite([{ from: elsewhere('a.txt'), relativePath: 'MCM/deep/a.txt' }, { from: elsewhere('gone.txt'), relativePath: 'gone.txt' }])).rejects.toThrow('ENOENT');

        expect([await text(root, join('deployed', 'a.txt')), await isThere(join(root, 'overwrite', 'MCM'))]).toEqual(['mine', false]);
      });
    });

    it('refuses a mod that has no folder', async () => {
      await expect(adapter.markOriginFile({ kind: 'mod', name: '../profiles' }, 'a.esp', 'Excluded')).rejects.toThrow(/Not a file of/);
    });

    it('moves a mod\'s file to the trash', async () => {
      await put(join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds'));
      const trashed: string[] = [];

      await adapter.trashFileIn(join(root, 'mods', 'Harder VATS'), 'Textures/a.dds', (file) => {
        trashed.push(file);
        return Promise.resolve();
      });

      expect(trashed).toEqual([join(root, 'mods', 'Harder VATS', 'Textures', 'a.dds')]);
    });

    it('moves a folder to the trash whole, and removes each folder it leaves empty', async () => {
      const source = join(root, 'source', 'Mod');
      await put(join(source, 'plugin-source', 'A.esp', 'npc_', '1.json'));
      const trash: MoveToTrash = (path) => rm(path, { recursive: true });

      await adapter.trashFileIn(source, 'plugin-source/A.esp', trash);

      expect(await readdir(source)).toEqual([]);
    });

    describe('trashing a tree set aside, as the path it had', () => {
      const source = () => join(root, 'source', 'Mod');
      const ASIDE = '.medit_tmp_aside_x/A.esp';
      const HAD = 'plugin-source/A.esp';
      const setAside = async () => {
        await put(join(source(), '.medit_tmp_aside_x', 'A.esp', 'old.json'));
        await put(join(source(), 'plugin-source', 'A.esp', 'new.json'));
      };
      const held = async () => (await readdir(source(), { recursive: true })).sort();
      const aside = ['.medit_tmp_aside_x', join('.medit_tmp_aside_x', 'A.esp'), join('.medit_tmp_aside_x', 'A.esp', 'old.json')];
      const had = ['plugin-source', join('plugin-source', 'A.esp'), join('plugin-source', 'A.esp', 'new.json')];

      it('hands the trash the tree at the path it had, with the tree there now kept, and removes the aside folder it empties', async () => {
        await setAside();
        const seen: { path: string; held: string[] }[] = [];
        const trash: MoveToTrash = async (path) => {
          seen.push({ path, held: await readdir(path) });
          await rm(path, { recursive: true });
        };

        await adapter.trashFileIn(source(), ASIDE, trash, HAD);

        expect([seen, await held()]).toEqual([[{ path: join(source(), HAD), held: ['old.json'] }], had]);
      });

      it('leaves both trees where they were, and reports the trash\'s error, when the trash refuses', async () => {
        await setAside();

        await expect(adapter.trashFileIn(source(), ASIDE, () => Promise.reject(new Error('no trash')), HAD)).rejects.toThrow(/^no trash$/);

        expect(await held()).toEqual([...aside, ...had].sort());
      });

      it('leaves both trees whole, and names the first error and what was not put back, when the trash refuses and the old tree cannot go back', async () => {
        await setAside();
        const trash: MoveToTrash = async (path) => {
          await put(join(path, '..', '..', ASIDE.split('/')[0] ?? '', 'A.esp', 'blocker.txt'));
          return Promise.reject(new Error('no trash'));
        };

        const failure = await adapter.trashFileIn(source(), ASIDE, trash, HAD).then(() => undefined, (err: unknown) => err);

        const left = await held();
        expect([String(failure).includes('no trash; not put back'), left.includes(join(HAD, 'old.json')), left.some((name) => name.endsWith('new.json') && name.includes('.medit_tmp_'))])
          .toEqual([true, true, true]);
      });

      it('says the old tree is in the trash, and where the tree that stood there is, when that tree cannot be put back', async () => {
        await setAside();
        const trash: MoveToTrash = async (path) => {
          await rm(path, { recursive: true });
          await put(join(path, 'blocker.txt'));
        };

        const why = await adapter.trashFileIn(source(), ASIDE, trash, HAD);

        const kept = (await held()).find((name) => name.endsWith('new.json') && name.includes('.medit_tmp_')) ?? '';
        expect(why).toContain(`was moved to the trash, but the tree that stood there could not be put back and is at ${join(source(), dirname(kept))}`);
      });

      it('leaves both trees where they were when the path it had cannot be written', async () => {
        await put(join(source(), '.medit_tmp_aside_x', 'A.esp', 'old.json'));

        await expect(adapter.trashFileIn(source(), ASIDE, () => Promise.resolve(), 'missing/A.esp')).rejects.toThrow('ENOENT');

        expect(await held()).toEqual(aside.slice().sort());
      });

      onPosix.it('(a link needs no privilege on POSIX) refuses a path it had that a link resolves outside the folder, moving nothing', async () => {
        await put(join(source(), '.medit_tmp_aside_x', 'A.esp', 'old.json'));
        await put(join(root, 'outside', 'A.esp', 'other.json'));
        await symlink(join(root, 'outside'), join(source(), 'linked'));
        const trash = vi.fn(() => Promise.resolve());

        await expect(adapter.trashFileIn(source(), ASIDE, trash, 'linked/A.esp')).rejects.toThrow(/Not a file or folder of/);

        expect([trash.mock.calls.length, await readdir(join(root, 'outside', 'A.esp'))]).toEqual([0, ['other.json']]);
      });
    });

    it('removes each folder the trashed file leaves empty, and keeps the mod\'s folder and a folder that holds more', async () => {
      const mod = join(root, 'mods', 'Built');
      await put(join(mod, 'Textures', 'sub', 'a.dds'));
      await put(join(mod, 'Textures', 'b.dds'));
      const trash: MoveToTrash = (file) => rm(file);

      await adapter.trashFileIn(mod, 'Textures/sub/a.dds', trash);
      const left = await readdir(mod, { recursive: true });
      await adapter.trashFileIn(mod, 'Textures/b.dds', trash);

      expect([left.sort(), await readdir(mod)]).toEqual([['Textures', join('Textures', 'b.dds')], []]);
    });

    onPosix.it.skipIf(process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root writes every folder) trashes the file and answers why a folder it emptied could not be removed, naming the folder', async () => {
      const mod = join(root, 'mods', 'Built');
      await put(join(mod, 'locked', 'sub', 'a.dds'));
      await chmod(join(mod, 'locked'), 0o555);

      const why = await adapter.trashFileIn(mod, 'locked/sub/a.dds', (file) => rm(file)).finally(() => chmod(join(mod, 'locked'), 0o755));

      expect([why, await readdir(join(mod, 'locked', 'sub'))])
        .toEqual([expect.stringMatching(/^trashing 'locked\/sub\/a.dds' left the folder 'locked\/sub' empty, and it could not be removed: EACCES/), []]);
    });

    it('takes a file already gone as trashed', async () => {
      const trashed: string[] = [];

      await adapter.trashFileIn(join(root, 'mods', 'Harder VATS'), 'Textures/gone.dds', (file) => {
        trashed.push(file);
        return Promise.resolve();
      });

      expect(trashed).toEqual([]);
    });

    onPosix.it('(a link needs no privilege on POSIX) refuses to trash a file a link in the mod\'s folder resolves outside it, trashing nothing', async () => {
      await put(join(root, 'outside', 'a.txt'));
      await symlink(join(root, 'outside'), join(root, 'mods', 'Harder VATS', 'linked'));
      const trashed: string[] = [];

      await expect(adapter.trashFileIn(join(root, 'mods', 'Harder VATS'), 'linked/a.txt', (file) => {
        trashed.push(file);
        return Promise.resolve();
      })).rejects.toThrow(/Not a file or folder of/);

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

      expect(seen).toEqual([modNames((await adapter.reading()).mods)]);
      expect(folders).toEqual((await adapter.reading()).modFolders?.all);
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
      expect(modNames((await adapter.reading()).mods)).toEqual([
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

    it('lands its change on the order an outside write left, not over it', async () => {
      const file = join(root, DEFAULT_MODLIST);
      const decide = vi.fn(() => [{ kind: 'enable', mod: 'Harder VATS', enabled: true }] satisfies ModOrderChange[]);
      decide.mockImplementationOnce(() => {
        appendFileSync(file, '-Outside Mod\n');
        return [{ kind: 'enable', mod: 'Harder VATS', enabled: true }];
      });
      const before = modNames((await adapter.reading()).mods);

      await adapter.changeModOrder('Default', decide);

      expect(modNames((await adapter.reading()).mods)).toEqual([...before.map((name) => (name === 'mod:Harder VATS:false' ? 'mod:Harder VATS:true' : name)), 'mod:Outside Mod:false']);
      expect(decide).toHaveBeenCalledTimes(2);
    });

    it('adds a separator with its folder', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);

      expect(modNames((await adapter.reading()).mods)[0]).toBe('separator:New Separator:true');
      expect(await isThere(separatorFolder('New Separator'))).toBe(true);
    });

    it('adds a separator beside an anchor named in another case', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', anchor: { kind: 'mod', name: 'skk fast start NEW GAME (fallout 4)' } }]);

      expect(modNames((await adapter.reading()).mods)[3]).toBe('separator:New Separator:true');
    });

    it('renames a separator\'s line and its folder as one change', async () => {
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames((await adapter.reading()).mods)).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(false);
    });

    it('renames a separator\'s line in a second profile, its folder moved with the first', async () => {
      await writeFile(join(root, 'profiles', 'Secondary', 'modlist.txt'), await text(root, DEFAULT_MODLIST));
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      await adapter.changeModOrder('Secondary', () => [{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames(await modOrderOf(adapter, 'Secondary'))).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
    });

    it('renames a mod\'s line in place, keeping its state, and nothing else', async () => {
      const before = await snapshotTree(root);
      const order = modNames((await adapter.reading()).mods);

      expect(await change([{ kind: 'renameMod', from: 'harder vats', to: 'Harder VATS 2' }])).toMatchObject({ wrote: true });

      expect(modNames((await adapter.reading()).mods)).toEqual(order.map((n) => n.replace('mod:Harder VATS:', 'mod:Harder VATS 2:')));
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

      it('refuses a rename onto a folder already there in any case, before anything moves, as on Linux a rename onto an empty folder would replace it in silence where Windows refuses', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(separatorFolder('core mods'));

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow(/is in the way/);

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
        expect(await isThere(separatorFolder('core mods'))).toBe(true);
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

        expect(modNames((await adapter.reading()).mods)[0]).toBe('separator:Core Mods:true');
        expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
        await expect(change([{ kind: 'addSeparator', separator: 'CON', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }])).rejects.toThrow(/Not a valid separator name/);
      });

      it('drops path separators from a separator\'s name, so its folder stays inside mods/, on adding and on renaming', async () => {
        await change([{ kind: 'addSeparator', separator: '../Escape', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);
        await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'A/B' }]);

        const names = modNames((await adapter.reading()).mods);
        expect(names).toContain('separator:..Escape:true');
        expect(names).toContain('separator:AB:false');
        expect(await isThere(separatorFolder('..Escape'))).toBe(true);
        expect(await isThere(separatorFolder('AB'))).toBe(true);
        expect(await isThere(join(root, 'Escape_separator'))).toBe(false);
      });

      it('takes a separator\'s name a mod has, on adding and on renaming: a mod is no clash', async () => {
        await change([{ kind: 'addSeparator', separator: 'Harder VATS', anchor: { kind: 'separator', name: 'Unassigned (Modlist Development)' } }]);
        await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'ENBoost - 12k' }]);

        const names = modNames((await adapter.reading()).mods);
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
      expect((await adapter.reading()).pluginOrder).toEqual([
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

    it('writes no loadorder.txt from a first pass that an outside write to plugins.txt made unneeded', async () => {
      const decide = vi.fn(() => [{ kind: 'add', plugin: 'New.esp' }] satisfies PluginOrderChange[]);
      decide.mockImplementationOnce(() => {
        appendFileSync(join(root, DEFAULT_PLUGINS), '*New.esp\r\n');
        return [{ kind: 'add', plugin: 'New.esp' }];
      });

      await expect(adapter.changePluginOrder('Default', decide)).resolves.toEqual({ wrote: false });

      expect(decide).toHaveBeenCalledTimes(2);
      await expect(text(root, DEFAULT_LOAD_ORDER)).rejects.toThrow(/ENOENT/);
    });

    it('hands the decision the order as it stands', async () => {
      const seen: string[][] = [];

      await adapter.changePluginOrder('Default', (order) => {
        seen.push(order.map((p) => p.name));
        return [];
      });

      expect(seen).toEqual([((await adapter.reading()).pluginOrder).map((p) => p.name)]);
    });
  });

  describe('a downloaded file\'s metadata', () => {
    const downloadsFolder = (): string => join(root, 'downloads');
    const metaOf = (name: string): Promise<string> => text(root, join('downloads', `${name}.meta`));

    beforeEach(() => writeFile(join(downloadsFolder(), 'manual.zip'), 'zip'));

    it('marks a downloaded file installed, creating its metadata when it has none', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Installed')).toEqual({ gone: false, wrote: true });

      const listed = (await adapter.reading()).downloadedFiles;
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
      const longAgo = new Date(2001, 1, 1);
      const markedAgain = async (mark: 'Excluded' | 'Included'): Promise<unknown[]> => {
        await adapter.markDownloadedFile(DOWNLOADED_FILE, mark);
        await utimes(join(downloadsFolder(), `${DOWNLOADED_FILE}.meta`), longAgo, longAgo);
        return [await adapter.markDownloadedFile(DOWNLOADED_FILE, mark), (await stat(join(downloadsFolder(), `${DOWNLOADED_FILE}.meta`))).mtime];
      };

      expect([await markedAgain('Excluded'), await markedAgain('Included')]).toEqual([[{ gone: false, wrote: false }, longAgo], [{ gone: false, wrote: false }, longAgo]]);
    });

    it('lands two edits of one downloaded file\'s metadata at once, each over the other\'s', async () => {
      await Promise.all([
        adapter.markDownloadedFile(DOWNLOADED_FILE, 'Excluded'),
        adapter.writeNexusFileInfo(DOWNLOADED_FILE, { game: 'fallout4', modID: '4598', fileID: '78', name: 'Both Landed' }),
      ]);

      const meta = await metaOf(DOWNLOADED_FILE);

      expect([/^removed=true\r$/m.test(meta), /^name=Both Landed\r$/m.test(meta)]).toEqual([true, true]);
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

        const listed = (await adapter.reading()).downloadedFiles;
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

      it('names the Nexus games of the instance\'s game, in order', async () => {
        await writeFile(join(root, INI), '[General]\r\ngameName=Skyrim Special Edition\r\nselected_profile=@ByteArray(Default)\r\n');

        expect(await adapter.nexusGames()).toEqual(['skyrimspecialedition', 'skyrim']);
      });

      it('has no Nexus game for an instance whose game Nexus has no domain for', async () => {
        await writeFile(join(root, INI), '[General]\r\ngameName=Morrowind\r\nselected_profile=@ByteArray(Default)\r\n');

        await expect(adapter.nexusGames()).rejects.toThrow("Nexus has no game for 'Morrowind'");
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

        it('puts any bytes when no hash is asked for', async () => {
          expect(await adapter.putDownloadedFile('fetched.7z', theBytes(), { info })).toEqual({ put: true });

          expect(await readFile(join(downloadsFolder(), 'fetched.7z'), 'utf8')).toBe('the bytes');
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

        describe('copy as a downloaded file', () => {
          const source = (): string => join(downloadsFolder(), 'manual.zip');

          it('puts a copy of the file under the name, with its metadata, and nothing else', async () => {
            await writeFile(`${source()}.meta`, '[General]\r\nmodID=4598\r\n');
            const before = await snapshotTree(root);

            await adapter.copyDownloadedFile(source(), 'copied.7z');

            expect([await readFile(join(downloadsFolder(), 'copied.7z'), 'utf8'), await metaOf('copied.7z')]).toEqual([await readFile(source(), 'utf8'), '[General]\r\nmodID=4598\r\n']);
            assertOnlyChanged(before, await snapshotTree(root), new Set(['downloads/copied.7z', 'downloads/copied.7z.meta']));
          });

          it.each([
            ['a name the downloads folder already holds', 'manual.zip', "'manual.zip' is already in the downloads folder"],
            ['a name that is no bare file name', '../copied.7z', "'../copied.7z' is not a file name"],
          ])('refuses %s, writing nothing', async (_name, name, refusal) => {
            const before = await snapshotTree(root);

            await expect(adapter.copyDownloadedFile(source(), name)).rejects.toThrow(refusal);

            assertOnlyChanged(before, await snapshotTree(root), new Set());
          });
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

  describe('the userlist', () => {
    it('is written at the instance root, beside LOOT\'s other files', async () => {
      await adapter.changeUserlist([{ plugin: 'B.esp', after: ['A.esp'] }]);

      expect(await readFile(join(root, 'userlist.yaml'), 'utf8')).toBe('plugins:\n  - name: B.esp\n    after:\n      - A.esp\n');
    });

    it('rejects, writing nothing, when the file cannot be read as a file', async () => {
      await mkdir(join(root, 'userlist.yaml'));

      await expect(adapter.changeUserlist([{ plugin: 'B.esp', after: ['A.esp'] }])).rejects.toThrow(/EISDIR/);
    });

    it('rejects, writing nothing, when the file is not a map of plugins', async () => {
      await writeFile(join(root, 'userlist.yaml'), '- a\n- b\n');

      await expect(adapter.changeUserlist([{ plugin: 'B.esp', after: ['A.esp'] }])).rejects.toThrow(/not a map/);
      expect(await readFile(join(root, 'userlist.yaml'), 'utf8')).toBe('- a\n- b\n');
    });
  });

  describe('the masterlist', () => {
    const trashing = (trashed: string[]): MoveToTrash => (path) => {
      trashed.push(basename(path));
      return rm(path);
    };

    it('sends each file it replaces to the trash before the write, and leaves an absent or unchanged file alone', async () => {
      await writeFile(join(root, 'masterlist.yaml'), 'my edit');
      await writeFile(join(root, 'prelude.yaml'), 'common: []\n');
      const trashed: string[] = [];

      await adapter.changeMasterlist({ masterlist: 'plugins: []\n', prelude: 'common: []\n' }, trashing(trashed));
      await rm(join(root, 'masterlist.yaml'));
      await adapter.changeMasterlist({ masterlist: 'plugins: []\n', prelude: 'common: [x]\n' }, trashing(trashed));

      expect(trashed).toEqual(['masterlist.yaml', 'prelude.yaml']);
      expect(await readFile(join(root, 'masterlist.yaml'), 'utf8')).toBe('plugins: []\n');
    });

    it('is written whole with the prelude at the instance root, and a second identical write changes nothing', async () => {
      const files = { masterlist: 'plugins: []\n', prelude: 'common: []\n' };

      expect(await adapter.changeMasterlist(files, trashing([]))).toEqual({ written: ['masterlist.yaml', 'prelude.yaml'] });
      expect(await adapter.changeMasterlist(files, trashing([]))).toEqual({ written: [] });

      expect([await readFile(join(root, 'masterlist.yaml'), 'utf8'), await readFile(join(root, 'prelude.yaml'), 'utf8')]).toEqual(['plugins: []\n', 'common: []\n']);
    });

    it('puts the masterlist back when the prelude cannot be written, so the pair changes together', async () => {
      await writeFile(join(root, 'masterlist.yaml'), 'pinned masterlist');
      await mkdir(join(root, 'prelude.yaml'));

      await expect(adapter.changeMasterlist({ masterlist: 'new masterlist', prelude: 'new prelude' }, trashing([]))).rejects.toThrow(/EISDIR/);

      expect(await readFile(join(root, 'masterlist.yaml'), 'utf8')).toBe('pinned masterlist');
    });

    it('puts both files back as they were when the trash takes the prelude and then fails', async () => {
      await writeFile(join(root, 'masterlist.yaml'), 'pinned masterlist');
      await writeFile(join(root, 'prelude.yaml'), 'pinned prelude');
      const trashed: string[] = [];
      const failing: MoveToTrash = async (path) => {
        await trashing(trashed)(path);
        if (basename(path) === 'prelude.yaml') throw new Error('the trash failed');
      };

      await expect(adapter.changeMasterlist({ masterlist: 'new masterlist', prelude: 'new prelude' }, failing)).rejects.toThrow('the trash failed');

      expect(trashed).toEqual(['masterlist.yaml', 'prelude.yaml']);
      expect([await readFile(join(root, 'masterlist.yaml'), 'utf8'), await readFile(join(root, 'prelude.yaml'), 'utf8')]).toEqual(['pinned masterlist', 'pinned prelude']);
    });

    it('takes the masterlist away again when it was absent and the prelude cannot be written', async () => {
      await mkdir(join(root, 'prelude.yaml'));

      await expect(adapter.changeMasterlist({ masterlist: 'new masterlist', prelude: 'new prelude' }, trashing([]))).rejects.toThrow(/EISDIR/);

      await expect(readFile(join(root, 'masterlist.yaml'), 'utf8')).rejects.toThrow(/ENOENT/);
    });
  });

  describe('the selected profile', () => {
    it('selects a profile, touching the settings alone', async () => {
      const before = await snapshotTree(root);

      expect(await adapter.selectProfile('Secondary')).toEqual({ wrote: true });

      assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
      expect(await adapter.activeProfile()).toBe('Secondary');
    });

    it('serializes concurrent selections, so the last one issued is the selected one', async () => {
      const [first, second] = await Promise.all([adapter.selectProfile('Secondary'), adapter.selectProfile('Default')]);

      expect([first, second]).toEqual([{ wrote: true }, { wrote: true }]);
      expect(await adapter.activeProfile()).toBe('Default');
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
  ])('%s', async (_case, lay, instance) => {
    await lay(root);

    expect(isInstance(root)).toBe(instance);
  });

  it('is none for a path where nothing is, without throwing', () => {
    expect(isInstance(join(root, 'does-not-exist'))).toBe(false);
  });

  it('is one with a modlist.txt that is not text, its contents unread', async () => {
    await instanceIn(root);
    await mkdir(join(root, 'profiles', 'Default'));
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '\x00not valid text\xff');

    expect(isInstance(root)).toBe(true);
  });
});
