import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileRead, FoundGameFolder, GamePlace, InstallationFile, InstanceAdapter, OtherManifest } from '../../instanceAdapter/instanceAdapter';
import { manifestIn, writeManifestIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { fakeInstanceAdapter, flaggedKey, modFoldersIn, readingFixture, refusing, repositoriesOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { updateManifest, type UpdateManifestStatus } from '../updateManifest';

const HA = 'AAAAAAAAAAA=';
const HB = 'BBBBBBBBBBA=';
const HX = 'XXXXXXXXXXA=';
const HZ = 'ZZZZZZZZZZA=';
const FOUND: FoundGameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'HHHHHHHHHHA=', entries: [{ path: 'a.nif', hash: HA }] };
const read = <T>(answer: T): FileRead<T> => ({ kind: 'read', answer });
const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map() };
const holding = (files: Record<string, string>): Manifest['files'] => new Map(Object.entries(files));

let root: string;
let modsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'updateManifest-'));
  modsDir = join(root, 'mods');
  await mkdir(modsDir);
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface Setup {
  readonly files?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly answers?: InstanceAnswers;
  readonly sourceFolders?: Record<string, string>;
  readonly gameFolder?: typeof FOUND | typeof GAME_FOLDER_NOT_FOUND;
  readonly adapterOver?: Partial<InstanceAdapter>;
  readonly sourceFiles?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

async function over({ files = { ModA: {}, ModB: {} }, answers = {}, sourceFolders = {}, gameFolder = FOUND, adapterOver = {}, sourceFiles = {} }: Setup = {}) {
  for (const mod of Object.keys(files)) await mkdir(join(modsDir, mod), { recursive: true });
  const folders = [...Object.entries(files).map(([mod, held]) => [join(modsDir, mod), held] as const), ...Object.entries(sourceFiles)];
  const folderFiles = new Map(folders.map(([folder, held]) => [folder, Object.keys(held)]));
  const hashes = new Map(folders.flatMap(([folder, held]) => Object.entries(held).map(([path, hash]) => [join(folder, path), { size: 1, hash }] as const)));
  const fake = fakeInstanceAdapter(
    readingFixture({ gameFolder, sourceRepositories: repositoriesOf(sourceFolders), modFolders: modFoldersIn(modsDir, ...Object.keys(files)) }),
    { folderFiles, hashes, ...answers });
  const deps = { adapter: { ...fake.adapter, ...adapterOver } };
  return {
    fake,
    update: (mods: readonly string[], options: Parameters<typeof updateManifest>[2] = {}, others: readonly OtherManifest[] = [], everyMod = false, sourceMods: readonly string[] = []) =>
      updateManifest(deps, mods, options, others, everyMod, sourceMods),
    manifestOf: (mod: string) => manifestIn(join(modsDir, mod)),
    manifestHeld: async (mod: string): Promise<Manifest> => {
      const read = await manifestIn(join(modsDir, mod));
      if (read === undefined || 'refused' in read) throw new Error(`${mod} holds no manifest`);
      return read.manifest;
    },
  };
}

async function heldIn(folder: string): Promise<Manifest> {
  const read = await manifestIn(folder);
  if (read === undefined || 'refused' in read) throw new Error(`${folder} holds no manifest`);
  return read.manifest;
}

describe('update manifest', () => {
  it('writes each mod\'s manifest from its folder, naming each file no package holds (The manifest, story 5)', async () => {
    const { update, manifestOf } = await over({ files: { ModA: { 'a.nif': HA }, ModB: { 'b.nif': HB } } });

    const result = await update(['ModA', 'ModB']);

    expect([result.landed, result.refused, await manifestOf('ModA'), await manifestOf('ModB')]).toEqual([
      [{ mod: 'ModA', manifestWritten: true, notInPackage: ['a.nif'], otherBytes: [] }, { mod: 'ModB', manifestWritten: true, notInPackage: ['b.nif'], otherBytes: [] }], [],
      { manifest: { ...EMPTY, files: holding({ 'a.nif': HA }) } }, { manifest: { ...EMPTY, files: holding({ 'b.nif': HB }) } },
    ]);
  });

  it('names the installation file as a package with its file on Nexus as its host, and none of the mod\'s metadata (Query info, story 1)', async () => {
    const page = 'https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2';
    const { update, manifestOf } = await over({
      files: { ModA: { 'a.nif': HA } }, answers: { installations: new Map([['ModA', read({ ...INSTALLED, page })]]), metadata: new Map([['ModA', { version: '1.2.3' }]]) },
    });

    const result = await update(['ModA']);

    expect([result.landed, await manifestOf('ModA')]).toEqual([
      [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }],
      { manifest: { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash, host: { nexus: { game: 'fallout4', mod: 1, file: 2 } } }], files: holding({ 'a.nif': HA }) } },
    ]);
  });

  it('names the installation file\'s host from the downloaded file\'s own metadata when the mod\'s metadata names none (Query info, story 1)', async () => {
    const page = 'https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2';
    const { update, manifestOf } = await over({
      files: { ModA: { 'a.nif': HA } },
      answers: { installations: new Map([['ModA', read(INSTALLED)]]), downloadedFilesHashed: { files: [{ ...INSTALLED, page }], notes: [] } },
    });

    await update(['ModA']);

    expect(await manifestOf('ModA')).toEqual({
      manifest: { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash, host: { nexus: { game: 'fallout4', mod: 1, file: 2 } } }], files: holding({ 'a.nif': HA }) },
    });
  });

  it.each([
    ['the downloaded row is the same file by another path', '/elsewhere/ModA-1.0.7z'],
    ['the downloaded row\'s page differs from the mod\'s', '/downloads/ModA-1.0.7z'],
  ])('names the host of the downloaded file\'s metadata over the mod\'s, when %s', async (_name, rowPath) => {
    const { update, manifestOf } = await over({
      files: { ModA: { 'a.nif': HA } },
      answers: {
        installations: new Map([['ModA', read({ ...INSTALLED, page: 'https://www.nexusmods.com/fallout4/mods/9?tab=files&file_id=9' })]]),
        downloadedFilesHashed: { files: [{ ...INSTALLED, path: rowPath, page: 'https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2' }], notes: [] },
      },
    });

    await update(['ModA']);

    const held = await manifestOf('ModA');
    expect(held !== undefined && 'manifest' in held && held.manifest.packages).toEqual([
      { kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash, host: { nexus: { game: 'fallout4', mod: 1, file: 2 } } },
    ]);
  });

  it.each([
    ['missing', 'this machine does not hold Gone.7z, the file it is installed from'],
    ['unreadable', 'Modbench cannot tell what Gone.7z installs: 7z crashed'],
  ])('takes a file from the downloaded file that holds its bytes when the installation file the mod manager names is %s (Update manifest, story 6)', async (_what, reason) => {
    const { update, manifestOf } = await over({
      files: { ModA: { 'a.nif': HA } },
      answers: { installations: new Map([['ModA', { kind: 'unreadable', reason }]]), downloadedFilesHashed: { files: [INSTALLED], notes: [] } },
    });

    const result = await update(['ModA']);

    expect([result.refused, result.landed.map(({ mod }) => mod), await manifestOf('ModA')]).toEqual([
      [], ['ModA'],
      { manifest: { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }], files: holding({ 'a.nif': HA }) } },
    ]);
  });

  it('refuses a mod whose folder holds a file and its excluded copy, which its manifest names as one file', async () => {
    const { update } = await over({ files: { ModA: { 'b.esp': HA, 'b.esp.mohidden': HB } } });

    expect((await update(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was not updated: its folder holds 'b.esp' and 'b.esp.mohidden', which a manifest names as one file" }]);
  });

  it('records each file the folder excludes by its own path, and the exclusion apart (formats/manifest.md)', async () => {
    const { update, manifestOf } = await over({ files: { ModA: { 'docs.mohidden/a.txt': HA, 'b.esp.mohidden': HB } } });

    await update(['ModA']);

    expect(await manifestOf('ModA')).toEqual({ manifest: { ...EMPTY, exclude: ['b.esp', 'docs'], ignore: [], flags: new Map(), files: holding({ 'docs/a.txt': HA, 'b.esp': HB }) } });
  });

  it('leaves out a file its manifest ignores, with the exclusion of it, and keeps the ignore (The manifest, story 11)', async () => {
    const { update, manifestOf } = await over({ files: { ModA: { 'a.nif': HA, 'F4SE/Plugins/BetterConsole.mem': HB, 'logs.mohidden/x.log': HX } } });
    await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, ignore: ['F4SE/Plugins/BetterConsole.mem', 'logs'] });

    const result = await update(['ModA']);

    expect([result.refused, await manifestOf('ModA')]).toEqual([
      [], { manifest: { ...EMPTY, ignore: ['F4SE/Plugins/BetterConsole.mem', 'logs'], flags: new Map(), files: holding({ 'a.nif': HA }) } },
    ]);
  });

  it('records only the lines of the paths it is asked for, keeping every package the manifest holds as it is, and adding those it lacks', async () => {
    const OTHER: InstallationFile = { path: '/downloads/Other.7z', size: 5, hash: 'OOOOOOOOOOA=', entries: [{ path: 'b.nif', hash: HB }] };
    const heldPackage = { kind: 'installationFile' as const, name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash, host: { nexus: { game: 'fallout4', mod: 9, file: 9 } } };
    const { update, manifestOf } = await over({
      files: { ModA: { 'a.nif': HA, 'b.nif': HB, 'c.nif': HX } },
      answers: {
        installations: new Map([['ModA', read({ ...INSTALLED, page: 'https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2' })]]),
        downloadedFilesHashed: { files: [INSTALLED, OTHER], notes: [] },
      },
    });
    await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, packages: [heldPackage], files: holding({ 'a.nif': HA }) });

    await update(['ModA'], { only: new Map([['ModA', ['b.nif']]]) });

    expect(await manifestOf('ModA')).toEqual({
      manifest: {
        ...EMPTY, packages: [heldPackage, { kind: 'installationFile', name: 'Other.7z', size: 5, hash: OTHER.hash }], files: holding({ 'a.nif': HA, 'b.nif': HB }),
      },
    });
  });

  it('does not refuse a mod for an ignored file it cannot read (The manifest, story 11)', async () => {
    const unreadable = { path: 'Game.mem', excluded: false, read: { kind: 'unreadable' as const, reason: 'EBUSY: resource busy' } };
    const { update, manifestOf } = await over({
      files: { ModA: {} },
      adapterOver: { folderValue: () => Promise.resolve({ files: new Map([['Game.mem', unreadable]]), exclude: [], ignoresCase: false }) },
    });
    await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, ignore: ['Game.mem'] });

    const result = await update(['ModA']);

    expect([result.refused, await manifestOf('ModA')]).toEqual([[], { manifest: { ...EMPTY, ignore: ['Game.mem'] } }]);
  });

  it('writes a mod\'s manifest once, whatever the number of updates', async () => {
    const { update } = await over({ files: { ModA: { 'a.nif': HA } } });

    await update(['ModA']);

    expect((await update(['ModA'])).landed).toEqual([{ mod: 'ModA', manifestWritten: false, notInPackage: ['a.nif'], otherBytes: [] }]);
  });

  it('updates a mod named twice once', async () => {
    const { update } = await over({ files: { ModA: { 'a.nif': HA } } });

    const result = await update(['ModA', 'ModA']);

    expect(result.landed).toEqual([{ mod: 'ModA', manifestWritten: true, notInPackage: ['a.nif'], otherBytes: [] }]);
  });

  it('names each file a package holds with other bytes apart from each nothing holds', async () => {
    const { update } = await over({ files: { ModA: { 'a.nif': HX, 'z.txt': HZ } }, answers: { installations: new Map([['ModA', read(INSTALLED)]]) } });

    expect((await update(['ModA'])).landed).toEqual([{ mod: 'ModA', manifestWritten: true, notInPackage: ['z.txt'], otherBytes: ['a.nif'] }]);
  });

  it('writes a manifest of the format before version 1 over in version 1 (formats/CLAUDE.md, Versions)', async () => {
    const { update, manifestOf } = await over({ files: { ModA: { 'a.nif': HA } } });
    await writeFile(join(modsDir, 'ModA', 'ModA.manifest.json'), '{\n"files": [\n{"path":"a.nif","inPackage":false}\n]\n}\n');

    const result = await update(['ModA']);

    expect([result.refused, await manifestOf('ModA')]).toEqual([[], { manifest: { ...EMPTY, files: holding({ 'a.nif': HA }) } }]);
  });

  describe('refuses a mod, naming why, and updates the rest', () => {
    const asked = ['ModA', 'ModB'];

    const refusedBy = async (setup: Setup, prepare: () => Promise<unknown> = () => Promise.resolve()) => {
      const { update, manifestOf } = await over(setup);
      await prepare();
      const result = await update(asked);
      return { result, otherManifest: await manifestOf('ModB') };
    };

    it('whose manifest cannot be read, leaving it as it was', async () => {
      const { result, otherManifest } = await refusedBy({ files: { ModA: {}, ModB: {} } }, () => writeFile(join(modsDir, 'ModA', 'ModA.manifest.json'), '{"version": 1, "files": 3}'));

      expect([result.refused, result.landed.map(({ mod }) => mod), otherManifest !== undefined]).toEqual([
        [{ item: 'ModA', reason: expect.stringContaining('was not updated: its manifest cannot be read') as unknown }], ['ModB'], true,
      ]);
    });

    it('whose manifest is of another version, naming both, and leaving it as it was (formats/CLAUDE.md, Versions)', async () => {
      const { result } = await refusedBy({}, () => writeFile(join(modsDir, 'ModA', 'ModA.manifest.json'), '{"version": 2}'));

      expect(result.refused).toEqual([{ item: 'ModA', reason: 'was not updated: its manifest is version 2, and Modbench reads only version 1.' }]);
    });

    it('whose manifest names the game folder when the game folder was not found', async () => {
      const { result } = await refusedBy({ gameFolder: GAME_FOLDER_NOT_FOUND }, () => writeManifestIn(
        join(modsDir, 'ModA'), { ...EMPTY, packages: [{ kind: 'gameFolder' }] }));

      expect(result.refused).toEqual([{ item: 'ModA', reason: 'was not updated: its manifest names the game folder, and the game folder was not found.' }]);
    });

    it.each([
      ['a second installation file', 'Other.7z'],
      ['the first installation file, among the downloaded files', 'ModA-1.0.7z'],
    ])('whose manifest names %s that is missing from this machine, leaving the manifest as it was', async (_, missing) => {
      const OTHER: InstallationFile = { path: '/downloads/Other.7z', size: 5, hash: 'OOOOOOOOOOA=', entries: [{ path: 'b.nif', hash: HB }] };
      const held: Manifest = {
        packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }, { kind: 'installationFile', name: 'Other.7z', size: 5, hash: OTHER.hash }],
        exclude: [], ignore: [], flags: new Map(), files: holding({ 'a.nif': HA, 'b.nif': HB }),
      };
      const downloads = [INSTALLED, OTHER].filter((file) => !file.path.endsWith(missing));
      const { update, manifestHeld } = await over({
        files: { ModA: { 'a.nif': HA, 'b.nif': HB } },
        answers: { installations: new Map(), downloadedFilesHashed: { files: downloads, notes: [] } },
      });
      await writeManifestIn(join(modsDir, 'ModA'), held);

      const result = await update(['ModA']);

      expect([result.refused, result.landed, await manifestHeld('ModA')]).toEqual([
        [{ item: 'ModA', reason: `was not updated: its manifest names '${missing}', and this machine does not hold it.` }], [], held,
      ]);
    });

    it('whose folder is gone', async () => {
      const { result } = await refusedBy({
        adapterOver: { fileStamp: (path) => Promise.resolve(path.endsWith('ModA') ? { kind: 'unreadable', reason: `ENOENT: no such file or directory, stat '${path}'` } : read({ size: 0n, modifiedNs: 0n, changedNs: 0n })) },
      });

      expect(result.refused).toEqual([{ item: 'ModA', reason: 'was not updated: its folder does not exist.' }]);
    });

    it('a file of which could not be read, naming why', async () => {
      const unreadable = { files: new Map([['a.nif', { path: 'a.nif', excluded: false, read: { kind: 'unreadable' as const, reason: 'EACCES: permission denied' } }]]), exclude: [], ignoresCase: false };
      const { result } = await refusedBy({ files: { ModA: { 'a.nif': HA }, ModB: {} }, adapterOver: { folderValue: (folder) => Promise.resolve(folder.endsWith('ModA') ? unreadable : { files: new Map(), exclude: [], ignoresCase: false }) } });

      expect([result.refused, result.landed.map(({ mod }) => mod)]).toEqual([[{ item: 'ModA', reason: 'was not updated: a file could not be read: EACCES: permission denied' }], ['ModB']]);
    });

    it('whose manifest could not be written', async () => {
      const { result } = await refusedBy({}, () => mkdir(join(modsDir, 'ModA', 'ModA.manifest.json', 'inside'), { recursive: true }));

      expect([result.refused.map(({ item }) => item), result.landed.map(({ mod }) => mod)]).toEqual([['ModA'], ['ModB']]);
    });

    it('whose name gives it no folder', async () => {
      const { result } = await refusedBy({ adapterOver: { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : join(modsDir, mod)) } });

      expect([result.refused, result.landed.map(({ mod }) => mod)]).toEqual([[{ item: 'ModA', reason: 'its name gives it no folder' }], ['ModB']]);
    });

    it('whose game files cannot be read', async () => {
      const { result } = await refusedBy({ answers: { gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) } });

      expect([result.refused, result.landed.map(({ mod }) => mod)]).toEqual([[{ item: 'ModA', reason: 'EACCES' }], ['ModB']]);
    });
  });

  describe('a source mod', () => {
    const SOURCE = () => join(root, 'source', 'ModB');

    const among = async (files: Record<string, string> = {}, answers: InstanceAnswers = {}, sourceFiles: Record<string, string> = {}) => {
      await mkdir(SOURCE(), { recursive: true });
      return over({ files: { ModA: {}, ModB: files }, sourceFolders: { ModB: SOURCE() }, answers, sourceFiles: { [SOURCE()]: sourceFiles } });
    };

    const SOURCE_FILES = { 'tool.dll': HA, 'plugin.json': HX, '.git': HB, '.git/HEAD': HB };
    const GIT_HOLDS = () => ({ heldByGit: new Map([[SOURCE(), ['plugin.json']]]) });

    it('has neither its mod folder nor its source folder recorded when named as a mod', async () => {
      const { update, manifestOf } = await among({ 'extra.nif': HX }, GIT_HOLDS(), SOURCE_FILES);

      const result = await update(['ModA', 'ModB']);

      expect([result.landed.map(({ mod }) => mod), result.refused, await manifestOf('ModB'), await manifestIn(SOURCE())]).toEqual([['ModA'], [], undefined, undefined]);
    });

    it('has its source folder recorded in a manifest of its own, naming no file git holds, when named as a source folder', async () => {
      const { update, manifestOf } = await among({ 'extra.nif': HX }, GIT_HOLDS(), SOURCE_FILES);

      const result = await update(['ModA'], {}, [], false, ['ModB']);

      expect([result.landed.map(({ mod }) => mod), result.refused, await manifestOf('ModB'), await heldIn(SOURCE())]).toEqual([
        ['ModA', 'ModB'], [], undefined, { ...EMPTY, files: holding({ 'tool.dll': HA }) },
      ]);
    });

    it('has its source folder recorded when every mod is updated', async () => {
      const { update } = await among({}, GIT_HOLDS(), SOURCE_FILES);

      await update(['ModA', 'ModB'], {}, [], true);

      expect(await heldIn(SOURCE())).toEqual({ ...EMPTY, files: holding({ 'tool.dll': HA }) });
    });

    it('is refused when named as a source folder though no source folder builds it', async () => {
      const { update } = await among();

      const result = await update([], {}, [], false, ['ModA']);

      expect([result.landed, result.refused.map(({ item }) => item)]).toEqual([[], ['ModA']]);
    });

    it('is refused, with no mod landed, when its source folder holds two manifests', async () => {
      const { update } = await among();
      await writeFile(join(SOURCE(), 'one.manifest.json'), '{}');
      await writeFile(join(SOURCE(), 'two.manifest.json'), '{}');

      const result = await update([], {}, [], false, ['ModB']);

      expect([result.landed, result.refused.map(({ item }) => item)]).toEqual([[], ['ModB']]);
    });

    it('still has its submodule entry written when it is all the selection holds', async () => {
      const { update, fake } = await among();

      const result = await update(['ModB']);

      expect([fake.calls[0], result.landed, result.refused]).toEqual([{ verb: 'writeSubmodules', acted: ['ModB'] }, [], []]);
    });

    it('still has its submodule entry written, as a mod acted on', async () => {
      const { update, fake } = await among();

      await update(['ModA', 'ModB']);

      expect(fake.calls[0]).toEqual({ verb: 'writeSubmodules', acted: ['ModB', 'ModA'] });
    });
  });

  describe('a mod that takes files from the game folder', () => {
    const taken = (path: string, hash: string): InstanceAnswers['gameFilesTaken'] =>
      new Map([['ModA', read({ gameFiles: [{ path: `Data/${path}`, hash, pathInFolder: path }], notes: [] })]]);

    it('names the game folder as its package, with no host where no store installed the game', async () => {
      const { update, manifestOf } = await over({ files: { ModA: { 'meshes/a.nif': HA } }, answers: { gameFilesTaken: taken('meshes/a.nif', HA) } });

      const result = await update(['ModA']);

      expect([result.landed, await manifestOf('ModA')]).toEqual([
        [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }], { manifest: { ...EMPTY, packages: [{ kind: 'gameFolder' }], files: holding({ 'meshes/a.nif': HA }) } },
      ]);
    });

    it('names Steam as the game folder\'s host, with the depots of the places it takes from, and notes why a place gave fewer depots than it holds', async () => {
      const place: GamePlace = { root: '/game', holdsDataFiles: true, steamApp: 377160, depots: [{ id: '1', version: '11' }], depotProblems: ['appmanifest_377160.acf records no installed depot'] };
      const { update, manifestHeld } = await over({ files: { ModA: { 'a.nif': HA } }, answers: { places: [{ ...place, gameFilesTaken: taken('a.nif', HA) }] } });

      const result = await update(['ModA']);

      expect([result.repositoryNotes, (await manifestHeld('ModA')).packages]).toEqual([
        place.depotProblems, [{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 1: '11' } } } }],
      ]);
    });

    it('notes no depot problem when no mod of the update takes a file from the game', async () => {
      const place: GamePlace = { root: '/game', holdsDataFiles: true, depots: [], depotProblems: ['appmanifest_377160.acf records no installed depot'] };
      const { update } = await over({ answers: { places: [place] } });

      expect((await update(['ModA'])).repositoryNotes).toEqual([]);
    });

    it('is noted, when its installation file yields its bytes, why its game files could not be read', async () => {
      const { update } = await over({
        files: { ModA: { 'a.nif': HA } }, answers: { installations: new Map([['ModA', read(INSTALLED)]]), gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) },
      });

      const result = await update(['ModA']);

      expect([result.refused, result.notes]).toEqual([[], [{ mod: 'ModA', note: expect.stringContaining('EACCES') as unknown }]]);
    });

    it('is noted, with no installation file, that the game folder was not found', async () => {
      const { update } = await over({ gameFolder: GAME_FOLDER_NOT_FOUND });

      expect((await update(['ModA'])).notes).toEqual([
        { mod: 'ModA', note: 'the game folder was not found, so its manifest cannot name the game folder as its package' },
      ]);
    });
  });

  it('updates a mod whose manifest names the installation file the mod manager names, though the downloaded files lack it', async () => {
    const { update, manifestHeld } = await over({
      files: { ModA: { 'a.nif': HA } },
      answers: { installations: new Map([['ModA', read(INSTALLED)]]), downloadedFilesHashed: { files: [], notes: [] } },
    });
    await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }], files: holding({ 'a.nif': HA }) });

    const result = await update(['ModA']);

    expect([result.refused, result.landed.map(({ mod }) => mod), (await manifestHeld('ModA')).packages.map((pkg) => ('name' in pkg ? pkg.name : pkg.kind))]).toEqual([[], ['ModA'], ['ModA-1.0.7z']]);
  });

  it('notes a mod whose installation file comes from a game without a Nexus domain', async () => {
    const { update } = await over({ answers: { installations: new Map([['ModA', read({ ...INSTALLED, unpagedGame: 'EnderalSE' })]]) } });

    expect((await update(['ModA'])).notes).toEqual([{ mod: 'ModA', note: expect.stringContaining("its installation file comes from 'EnderalSE'") as unknown }]);
  });

  describe('a mod\'s files that its installation file lacks', () => {
    it('are taken from another downloaded file, whose entries the hash index kept, which is named a package', async () => {
      const OTHER: InstallationFile = { path: '/downloads/Other.7z', size: 5, hash: 'OOOOOOOOOOA=', entries: [{ path: 'b.nif', hash: HB }] };
      const { update, manifestHeld } = await over({
        files: { ModA: { 'a.nif': HA, 'b.nif': HB } },
        answers: { installations: new Map([['ModA', read(INSTALLED)]]), downloadedFilesHashed: { files: [INSTALLED, OTHER], notes: [] } },
      });

      await update(['ModA']);

      expect((await manifestHeld('ModA')).packages.map((pkg) => ('name' in pkg ? pkg.name : pkg.kind))).toEqual(['ModA-1.0.7z', 'Other.7z']);
    });
  });

  describe('a folder outside the mod folders', () => {
    const STOCK_GAME: OtherManifest = { name: 'Stock Game/', folder: '' };

    it('is updated by its name, with the game files its files may be and none of what a mod manager holds of a mod', async () => {
      const folder = join(root, 'Stock Game');
      await mkdir(folder);
      const { update } = await over({
        files: { ModA: {} },
        answers: {
          installations: new Map([['Stock Game/', read(INSTALLED)]]),
          folderFiles: new Map([[folder, ['Data/a.nif']]]), hashes: new Map([[join(folder, 'Data/a.nif'), { size: 1, hash: HA }]]),
          gameFilesTaken: new Map([['Stock Game', read({ gameFiles: [{ path: 'Data/a.nif', hash: HA, pathInFolder: 'Data/a.nif' }], notes: [] }) ]]),
        },
      });

      const result = await update(['ModA'], {}, [{ ...STOCK_GAME, folder }]);

      const { packages, ...rest } = await heldIn(folder);
      expect([result.refused, result.landed.map(({ mod }) => mod), packages.map(({ kind }) => kind), rest]).toEqual([
        [], ['ModA', 'Stock Game/'], ['gameFolder'], { exclude: [], ignore: [], flags: new Map(), files: holding({ 'Data/a.nif': HA }) },
      ]);
    });
  });

  describe('what it writes in the repository', () => {
    it('makes each source mod with a remote a submodule once its mods are updated, naming a source mod that is not one', async () => {
      const { update, fake } = await over({ answers: { submodules: { notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], other: ['source/Odd is not a source mod'] } } });

      const result = await update(['ModA']);

      expect([fake.calls, result.notes, result.repositoryNotes]).toEqual([
        [{ verb: 'writeSubmodules', acted: ['ModA'] }, { verb: 'writeOtherManifestLines' }],
        [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], ['source/Odd is not a source mod'],
      ]);
    });

    it('gives the submodules of every source mod to the Instance adapter when it acts on every mod, though a mod was refused', async () => {
      const { update, fake } = await over({ answers: { gameFilesTaken: new Map([['ModB', { kind: 'unreadable', reason: 'EACCES' }]]) } });

      const result = await update(['ModA', 'ModB'], {}, [], true);

      expect([fake.calls[0], result.refused.map(({ item }) => item)]).toEqual([{ verb: 'writeSubmodules', acted: 'every' }, ['ModB']]);
    });

    it.each([
      ['write the submodules', { refusals: refusing('writeSubmodules', 'git is not available') }, 'git is not available'],
      ['write the lines of the other manifests', { refusals: refusing('writeOtherManifestLines', '.gitignore has a marker with no match') }, '.gitignore has a marker with no match'],
    ] as const)('names the failure to %s beside the manifests that landed', async (_what, answers, note) => {
      const { update } = await over({ answers });

      const result = await update(['ModA']);

      expect([result.landed.map(({ mod }) => mod), result.repositoryNotes]).toEqual([['ModA'], [note]]);
    });

    it('reports why a downloaded file could not be read, and updates every mod', async () => {
      const { update } = await over({ answers: { downloadedFilesHashed: { files: [], notes: ['/downloads/Bad.7z could not be read: EIO'] } } });

      const result = await update(['ModA', 'ModB']);

      expect([result.landed.map(({ mod }) => mod), result.repositoryNotes]).toEqual([['ModA', 'ModB'], ['/downloads/Bad.7z could not be read: EIO']]);
    });
  });

  describe('progress and cancel', () => {
    const NEVER_HASHED: InstallationFile = { ...INSTALLED, path: '/downloads/Other.7z' };
    const heardFrom = (heard: UpdateManifestStatus[]) => (status: UpdateManifestStatus): void => { heard.push(status); };

    it('reports reading each mod\'s files, how many downloaded files are left to hash, then each mod it updates of how many', async () => {
      const { update } = await over({ answers: { downloadedFilesHashed: { files: [INSTALLED], lacking: [NEVER_HASHED], notes: [] } } });
      const heard: UpdateManifestStatus[] = [];

      await update(['ModA', 'ModB'], { onProgress: heardFrom(heard) });

      expect(heard).toEqual([
        { phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'ReadingFiles', mod: 'ModB' }, { phase: 'Hashing', left: 1 },
        { phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 }, { phase: 'Updating', mod: 'ModB', modsDone: 1, modsTotal: 2 },
      ]);
    });

    it('stops after the mod in hand, answers cancelled with the mods that landed, and acts on those alone', async () => {
      const cancel = new AbortController();
      const { update, manifestOf, fake } = await over({ files: { ModA: { 'a.nif': HA }, ModB: { 'b.nif': HB } } });

      const result = await update(['ModA', 'ModB'], { signal: cancel.signal, onProgress: (status) => { if (status.phase === 'Updating') cancel.abort(); } });

      expect([result.cancelled, result.landed.map(({ mod }) => mod), await manifestOf('ModB'), fake.calls[0]]).toEqual([true, ['ModA'], undefined, { verb: 'writeSubmodules', acted: ['ModA'] }]);
    });

    it('reads no further mod, and writes no manifest, once its signal aborts while it reads', async () => {
      const cancel = new AbortController();
      const { update, manifestOf } = await over();

      const result = await update(['ModA', 'ModB'], { signal: cancel.signal, onProgress: (status) => { if (status.phase === 'ReadingFiles') cancel.abort(); } });

      expect([result, await manifestOf('ModA')]).toEqual([{ cancelled: true, landed: [], refused: [], notes: [], repositoryNotes: [] }, undefined]);
    });

    it('writes no manifest once its signal aborts while it hashes the downloaded files', async () => {
      const cancel = new AbortController();
      const { update, manifestOf } = await over({ answers: { downloadedFilesHashed: { files: [], lacking: [NEVER_HASHED, { ...NEVER_HASHED, path: '/downloads/Another.7z' }], notes: [] } } });

      const result = await update(['ModA'], { signal: cancel.signal, onProgress: (status) => { if (status.phase === 'Hashing') cancel.abort(); } });

      expect([result.cancelled, result.landed, await manifestOf('ModA')]).toEqual([true, [], undefined]);
    });

    it('does not call a run whose signal never aborts cancelled', async () => {
      const { update } = await over();

      expect((await update(['ModA'], { signal: new AbortController().signal })).cancelled).toBeUndefined();
    });

    it('answers every refusal of a call that no mod can be updated in, with the paths still shown', async () => {
      const { update } = await over({ answers: { gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) } });

      expect(await update(['ModA'])).toEqual({ landed: [], refused: [{ item: 'ModA', reason: 'EACCES' }], notes: [], repositoryNotes: [] });
    });
  });

  it('leaves no temp file in a mod folder', async () => {
    const { update } = await over({ files: { ModA: { 'a.nif': HA } } });

    await update(['ModA']);

    expect(await readdir(join(modsDir, 'ModA'))).toEqual(['ModA.manifest.json']);
  });

  describe('a plugin its manifest flags (Update manifest, story 5)', () => {
    const FLAGS = { Small: true };
    const flagged = (hash: string, held: Partial<Manifest> = {}) => over({
      files: { ModA: { 'Mod.esp': hash } }, answers: { installations: new Map([['ModA', read({ ...INSTALLED, entries: [{ path: 'Mod.esp', hash: HA }] })]]), flaggedHashes: new Map([[flaggedKey(HA, FLAGS), HX]]) },
    }).then(async (setup) => {
      await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }], flags: new Map([['Mod.esp', FLAGS]]), files: holding({ 'Mod.esp': HA }), ...held });
      return setup;
    });

    it('records the package copy\'s hash for the file that holds the bytes restore kept for the copy and the flags, and keeps the flags', async () => {
      const { update, manifestHeld } = await flagged(HX);

      const result = await update(['ModA']);

      const held = await manifestHeld('ModA');
      expect([result.landed, held.flags, held.files]).toEqual([
        [{ mod: 'ModA', manifestWritten: false, notInPackage: [], otherBytes: [] }], new Map([['Mod.esp', FLAGS]]), holding({ 'Mod.esp': HA }),
      ]);
    });

    it('records the bytes of a file that holds neither, as any file, and keeps the flags', async () => {
      const { update, manifestHeld } = await flagged(HZ);

      await update(['ModA']);

      const held = await manifestHeld('ModA');
      expect([held.flags, held.files]).toEqual([new Map([['Mod.esp', FLAGS]]), holding({ 'Mod.esp': HZ })]);
    });

    it('leaves the hash its manifest records while restore has kept none for the copy and the flags', async () => {
      const { update, manifestHeld } = await over({
        files: { ModA: { 'Mod.esp': HZ } }, answers: { installations: new Map([['ModA', read({ ...INSTALLED, entries: [{ path: 'Mod.esp', hash: HA }] })]]) },
      });
      await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }], flags: new Map([['Mod.esp', FLAGS]]), files: holding({ 'Mod.esp': HA }) });

      await update(['ModA']);

      expect((await manifestHeld('ModA')).files).toEqual(holding({ 'Mod.esp': HA }));
    });

    it('drops the flags of a plugin that is no longer in the folder, as its manifest names no file it lacks', async () => {
      const { update, manifestHeld } = await flagged(HX);
      await writeManifestIn(join(modsDir, 'ModA'), { ...EMPTY, packages: [{ kind: 'installationFile', name: 'ModA-1.0.7z', size: 10, hash: INSTALLED.hash }], flags: new Map([['Gone.esp', FLAGS]]), files: holding({ 'Gone.esp': HA }) });

      await update(['ModA']);

      expect((await manifestHeld('ModA')).flags).toEqual(new Map());
    });
  });

  it('names no file a plugin renamed from its package\'s entry, which holds its bytes (The manifest, story 9)', async () => {
    const { update } = await over({
      files: { ModA: { 'Renamed.esp': HA } }, answers: { installations: new Map([['ModA', read({ ...INSTALLED, entries: [{ path: 'Original.esp', hash: HA }] })]]) },
    });

    expect((await update(['ModA'])).landed).toEqual([{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }]);
  });
});
