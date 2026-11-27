import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileRead, FoundGameFolder, GameFileTaken, GamePlace, InstallationFile } from '../../instanceAdapter/instanceAdapter';
import { manifestIn, writeManifestIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { fakeInstanceAdapter, modFoldersIn, readingFixture } from '../../test/fakeInstanceAdapter';
import { updateManifest } from '../updateManifest';

const FOUND: FoundGameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const NEXUS_PAGE = 'https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2';
const NEXUS = { game: 'fallout4', mod: 1, file: 2 };
const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map() };

const hashOf = (tag: string): string => `${tag.replace(/[^A-Za-z0-9]/g, '').padEnd(11, 'A')}=`;
const read = <T>(answer: T): FileRead<T> => ({ kind: 'read', answer });

const download = (name: string, entries: Record<string, string>, over: Partial<InstallationFile> = {}): InstallationFile =>
  ({ path: `/downloads/${name}`, size: 10, hash: hashOf(name), entries: Object.entries(entries).map(([path, hash]) => ({ path, hash: hashOf(hash) })), ...over });

interface Game { readonly place: GamePlace; readonly files: readonly GameFileTaken[] }

const place = (files: Record<string, string>, over: Partial<GamePlace> = {}, pathsInFolder: Record<string, string> = {}): Game => ({
  place: { root: '/game', depots: [], depotProblems: [], ...over },
  files: Object.entries(files).map(([path, hash]) => ({ root: '/game', path, hash: hashOf(hash), pathInFolder: pathsInFolder[path] ?? path })),
});

const holding = (files: Record<string, string>): Manifest['files'] => new Map(Object.entries(files).map(([path, hash]) => [path, hashOf(hash)]));

let modsDir: string;
beforeEach(async () => { modsDir = await mkdtemp(join(tmpdir(), 'manifestBuilder-')); });
afterEach(() => rm(modsDir, { recursive: true, force: true }));

async function built(
  files: Record<string, string>, { installationFile, game, downloads = [] }: { installationFile?: InstallationFile; game?: Game; downloads?: InstallationFile[] } = {},
  held?: Manifest, exclude: string[] = [],
) {
  const folder = join(modsDir, 'ModA');
  await mkdir(folder, { recursive: true });
  if (held !== undefined) await writeManifestIn(folder, held);
  const onDisk = Object.entries(files).map(([path, hash]) => [exclude.includes(path) ? `${path}.mohidden` : path, hash] as const);
  const fake = fakeInstanceAdapter(readingFixture({ gameFolder: FOUND, modFolders: modFoldersIn(modsDir, 'ModA') }), {
    folderFiles: new Map([[folder, onDisk.map(([path]) => path)]]),
    hashes: new Map(onDisk.map(([path, hash]) => [join(folder, path), { size: 1, hash: hashOf(hash) }])),
    installations: new Map(installationFile === undefined ? [] : [['ModA', read(installationFile)]]),
    downloadedFilesHashed: { files: [...downloads, ...installationFile === undefined ? [] : [installationFile]], notes: [] },
    ...game === undefined ? {} : { place: game.place, gameFilesTaken: new Map([['ModA', read({ gameFiles: game.files, notes: [] })]]) },
  });
  const result = await updateManifest({ adapter: fake.adapter }, ['ModA'], {}, false, []);
  const recorded = await manifestIn(folder);
  if (recorded === undefined || 'refused' in recorded) throw new Error(`no manifest was recorded: ${JSON.stringify(result.refused)}`);
  const [landed] = result.landed;
  return { manifest: recorded.manifest, notInPackage: landed?.notInPackage, otherBytes: landed?.otherBytes };
}

const namesOf = (manifest: Manifest): string[] => manifest.packages.map((pkg) => ('name' in pkg ? pkg.name : pkg.kind));

describe('a mod\'s manifest from its files', () => {
  it('takes a new file from a package with a host before one without', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, {
      installationFile: download('Own.7z', { 'a.nif': 'HA' }), downloads: [download('Hosted.7z', { 'a.nif': 'HA' }, { page: NEXUS_PAGE })],
    });

    expect(namesOf(manifest)).toEqual(['Hosted.7z', 'Own.7z']);
  });

  it('keeps the held package of a file whose bytes are unchanged before one with a host', async () => {
    const own = download('Own.7z', { 'a.nif': 'HA' });
    const { manifest } = await built({ 'a.nif': 'HA' }, { installationFile: own, downloads: [download('Hosted.7z', { 'a.nif': 'HA' }, { page: NEXUS_PAGE })] },
      { ...EMPTY, packages: [{ kind: 'installationFile', name: 'Own.7z', size: 10, hash: hashOf('Own.7z') }], files: holding({ 'a.nif': 'HA' }) });

    expect(namesOf(manifest)).toEqual(['Own.7z']);
  });

  describe('when the held package of an unchanged file is missing from this machine', () => {
    const held: Manifest = { ...EMPTY, packages: [{ kind: 'installationFile', name: 'Gone.7z', size: 10, hash: hashOf('Gone.7z') }], files: holding({ 'a.nif': 'HA' }) };

    it('keeps the held package and takes no game folder though the game holds the bytes', async () => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: place({ 'a.nif': 'HA' }, { steamApp: 377160 }) }, held);

      expect(manifest.packages).toEqual(held.packages);
    });

    it('takes a changed file from a newly added download, with no game folder', async () => {
      const { manifest } = await built({ 'a.nif': 'HB' }, { game: place({ 'a.nif': 'HA' }, { steamApp: 377160 }), downloads: [download('Added.7z', { 'a.nif': 'HB' })] }, held);

      expect(namesOf(manifest)).toEqual(['Added.7z']);
    });
  });

  it('names nothing for a folder of metadata alone', async () => {
    expect((await built({})).manifest).toEqual(EMPTY);
  });

  it('names each file with its hash, the installation file with its host on Nexus, and the paths the folder excludes', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { installationFile: download('Mod-1.7z', { 'a.nif': 'HA' }, { size: 7, page: NEXUS_PAGE }) }, undefined, ['a.nif']);

    expect(manifest).toEqual({
      packages: [{ kind: 'installationFile', name: 'Mod-1.7z', size: 7, hash: hashOf('Mod-1.7z'), host: { nexus: NEXUS } }],
      exclude: ['a.nif'], ignore: [], flags: new Map(), files: holding({ 'a.nif': 'HA' }),
    });
  });

  it.each<[string, Partial<InstallationFile>, object]>([
    ['whose page names no file on Nexus with no host', { page: 'https://www.nexusmods.com/fallout4/mods/1' }, {}],
    ['with its direct URL as its host when its page names no Nexus file', { directUrl: 'https://f4se.silverlock.org/beta/f4se_0_06_23.7z' },
      { host: { url: 'https://f4se.silverlock.org/beta/f4se_0_06_23.7z' } }],
    ['with the Nexus file as its host when its metadata names both a Nexus file and a direct URL', { page: NEXUS_PAGE, directUrl: 'https://example.com/M.7z' }, { host: { nexus: NEXUS } }],
    ['with no host for a direct URL the schema refuses', { directUrl: 'not a url' }, {}],
    ['with a direct URL of any scheme as its host, as the schema takes any URI', { directUrl: 'ftp://example.com/M.7z' }, { host: { url: 'ftp://example.com/M.7z' } }],
    ['with the version the downloaded file\'s metadata gives', { version: '1.2' }, { packageVersion: '1.2' }],
    ['with no version when the downloaded file\'s metadata gives none', {}, {}],
    ['whose Nexus file has file ID 0 with no host', { page: 'https://www.nexusmods.com/fallout4/mods/4?tab=files&file_id=0' }, {}],
    ['whose Nexus file has mod ID 0 with no host', { page: 'https://www.nexusmods.com/fallout4/mods/0?tab=files&file_id=2' }, {}],
  ])('names an installation file %s', async (_case, metadata, named) => {
    const { manifest } = await built({}, { installationFile: download('M.7z', {}, metadata) });

    expect(manifest.packages).toEqual([{ kind: 'installationFile', name: 'M.7z', size: 10, hash: hashOf('M.7z'), ...named }]);
  });

  it.each<[string, Partial<InstallationFile>, object]>([
    ['none', {}, {}],
    ['its own', { version: '2.0' }, { packageVersion: '2.0' }],
  ])('takes the version from the downloaded file alone, never the mod\'s, when the downloaded file gives %s', async (_case, downloaded, named) => {
    const fake = fakeInstanceAdapter(readingFixture({ gameFolder: FOUND, modFolders: modFoldersIn(modsDir, 'ModA') }), {
      installations: new Map([['ModA', read(download('F4SE.7z', {}, { version: '1.0' }))]]),
      downloadedFilesHashed: { files: [download('F4SE.7z', {}, downloaded)], notes: [] },
    });
    await mkdir(join(modsDir, 'ModA'));

    await updateManifest({ adapter: fake.adapter }, ['ModA'], {}, false, []);

    expect(await manifestIn(join(modsDir, 'ModA'))).toEqual({
      manifest: { ...EMPTY, packages: [{ kind: 'installationFile', name: 'F4SE.7z', size: 10, hash: hashOf('F4SE.7z'), ...named }] },
    });
  });

  it('names the installation file though it gives no file, as the mod was installed from it', async () => {
    expect(namesOf((await built({ 'a.nif': 'HA' }, { installationFile: download('M.7z', {}) })).manifest)).toEqual(['M.7z']);
  });

  it('takes a file from wherever its package holds its bytes, as a FOMOD install moves files', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { installationFile: download('Own.7z', {}), downloads: [download('Other.7z', { 'Data/a.nif': 'HA' })] });

    expect(namesOf(manifest)).toEqual(['Other.7z', 'Own.7z']);
  });

  it('names each file no package holds the bytes of, apart from those a package holds a file of its name of (Status, story 5)', async () => {
    const recorded = await built({ 'meshes/A.nif': 'HX', 'z.txt': 'HZ', 'b.nif': 'HB' }, { installationFile: download('M.7z', { 'Meshes/a.nif': 'HA', 'b.nif': 'HB' }) });

    expect([recorded.notInPackage, recorded.otherBytes, recorded.manifest.files.get('z.txt')]).toEqual([['z.txt'], ['meshes/A.nif'], hashOf('HZ')]);
  });
});

describe('a mod\'s files that the installation file lacks', () => {
  it('are taken from a second download when the installation file holds their path with other bytes', async () => {
    const recorded = await built({ 'a.nif': 'HA' }, { installationFile: download('Own.7z', { 'a.nif': 'HX' }), downloads: [download('Other.7z', { 'a.nif': 'HA' })] });

    expect([namesOf(recorded.manifest), recorded.otherBytes]).toEqual([['Other.7z', 'Own.7z'], []]);
  });

  it('are taken, with no installation file, from each downloaded file in the order they first serve, preferring one already a package', async () => {
    const { manifest } = await built({ 'a.nif': 'H', 'b.nif': 'H2' }, { downloads: [download('Z.7z', { 'a.nif': 'H', 'b.nif': 'H2' }), download('A.7z', { 'a.nif': 'H' })] });

    expect(namesOf(manifest)).toEqual(['A.7z', 'Z.7z']);
  });

  it('are taken from the first by hash of two downloaded files of one name', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, {
      downloads: [download('M.7z', { 'a.nif': 'HX' }, { hash: hashOf('zzz') }), download('M.7z', { 'a.nif': 'HA' }, { hash: hashOf('aaa') })],
    });

    expect(manifest.packages).toEqual([expect.objectContaining({ hash: hashOf('aaa') })]);
  });

  it('are taken from the game folder before a downloaded file', async () => {
    expect(namesOf((await built({ 'a.nif': 'HA' }, { game: place({ 'a.nif': 'HA' }), downloads: [download('Other.7z', { 'a.nif': 'HA' })] })).manifest)).toEqual(['gameFolder']);
  });
});

describe('a mod\'s files that the game folder holds', () => {
  it('are named by the game folder though two game files hold their bytes', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { game: place({ 'Data/zz.nif': 'HA', 'Data/a.nif': 'HA' }, {}, { 'Data/zz.nif': 'zz.nif', 'Data/a.nif': 'a.nif' }) });

    expect(manifest.packages).toEqual([{ kind: 'gameFolder' }]);
  });

  it('name no package when the game holds none of the mod\'s files', async () => {
    expect((await built({ 'a.nif': 'HA' }, { game: place({ 'x.nif': 'HX' }) })).manifest.packages).toEqual([]);
  });

  it('are with other bytes when the game file of their name has other bytes and another file is taken', async () => {
    expect((await built({ 'a.nif': 'HX', 'c.nif': 'HC' }, { game: place({ 'a.nif': 'HA', 'c.nif': 'HC' }) })).otherBytes).toEqual(['a.nif']);
  });

  describe('when the Steam install is not the game folder', () => {
    const heldAt = (root: string, files: Record<string, string>): GameFileTaken[] =>
      Object.entries(files).map(([path, hash]) => ({ root, path, hash: hashOf(hash), pathInFolder: path }));
    const steam: GamePlace = { root: '/game', steamRoot: '/steam', steamApp: 377160, depots: [{ id: '1', version: '11' }], depotProblems: [] };
    const named = { kind: 'gameFolder', host: { steam: { app: 377160, depots: { 1: '11' } } } };

    it('name Steam as the host of files the Steam install holds byte for byte, though the game folder holds the file too', async () => {
      const game: Game = { place: steam, files: [...heldAt('/game', { 'a.nif': 'HA' }), ...heldAt('/steam', { 'a.nif': 'HA' })] };

      expect((await built({ 'a.nif': 'HA' }, { game })).manifest.packages).toEqual([named]);
    });

    it('name no host when the game folder alone holds the bytes of a file taken', async () => {
      const game: Game = { place: steam, files: [...heldAt('/game', { 'a.nif': 'HA', 'b.nif': 'HB' }), ...heldAt('/steam', { 'a.nif': 'HA', 'b.nif': 'HX' })] };

      expect((await built({ 'a.nif': 'HA', 'b.nif': 'HB' }, { game })).manifest.packages).toEqual([{ kind: 'gameFolder' }]);
    });

    it('are with other bytes when the Steam install holds a file of their name with other bytes', async () => {
      const game: Game = { place: steam, files: heldAt('/steam', { 'a.nif': 'HX', 'c.nif': 'HC' }) };

      expect((await built({ 'a.nif': 'HA', 'c.nif': 'HC' }, { game })).otherBytes).toEqual(['a.nif']);
    });
  });

  describe('when the held manifest names a host for the game folder', () => {
    const heldHost = { steam: { app: 377160, depots: { 1: '12' } } };
    const heldGame = (files: Record<string, string>): Manifest => ({ ...EMPTY, packages: [{ kind: 'gameFolder', host: heldHost }], files: holding(files) });

    it('keeps it while the files taken keep their bytes, though the Steam install records other depots', async () => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: place({ 'a.nif': 'HA' }, { steamApp: 377160, depots: [{ id: '1', version: '13' }] }) }, heldGame({ 'a.nif': 'HA' }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: heldHost }]);
    });

    it.each([['unchanged', 'HA'], ['changed', 'HX']])('drops it when the game folder is no Steam install, the files taken %s', async (_case, heldHash) => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: place({ 'a.nif': 'HA' }) }, heldGame({ 'a.nif': heldHash }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder' }]);
    });

    it('takes the store of the Steam install when the files taken changed', async () => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: place({ 'a.nif': 'HA' }, { steamApp: 377160, depots: [{ id: '2', version: '13' }] }) }, heldGame({ 'a.nif': 'HX' }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 2: '13' } } } }]);
    });
  });
});
