import { describe, expect, it } from 'vitest';
import type { InstallationFile } from '../../instanceAdapter/instanceAdapter';
import type { Manifest, NexusFile } from '../../manifestAdapter/manifestAdapter';
import { buildManifest, downloadedFileOf, downloadedFilesOf, type GameHeld, type GamePlaceHeld, type HashedModFile } from '../manifestBuilder';

const NEXUS: NexusFile = { game: 'fallout4', mod: 1, file: 2 };
const onNexus = (page: string): NexusFile | undefined => (page === 'nexus:1' ? NEXUS : undefined);

const download = (name: string, entries: Record<string, string>, over: Partial<InstallationFile> = {}): InstallationFile =>
  ({ path: `/downloads/${name}`, size: 10, hash: `hash of ${name}`, entries: Object.entries(entries).map(([path, hash]) => ({ path, hash })), ...over });

const mod = (files: Record<string, string>): HashedModFile[] => Object.entries(files).map(([path, hash]) => ({ path, hash }));

const place = (files: Record<string, string>, over: Partial<GamePlaceHeld> = {}, pathsInFolder: Record<string, string> = {}): GamePlaceHeld =>
  ({ files: Object.entries(files).map(([path, hash]) => ({ path, hash, pathInFolder: pathsInFolder[path] ?? path })), depots: [], ...over });

const gameOf = (...places: [GamePlaceHeld, ...GamePlaceHeld[]]): GameHeld => ({ places });

const built = (
  files: Record<string, string>, sources: { installationFile?: InstallationFile; game?: GameHeld; downloads?: InstallationFile[] } = {}, held?: Manifest, exclude: string[] = [],
) => buildManifest(
  {
    downloadedFiles: downloadedFilesOf(sources.downloads ?? [], onNexus), ...sources.installationFile ? { installationFile: downloadedFileOf(sources.installationFile, onNexus) } : {},
    ...sources.game ? { game: sources.game } : {},
  },
  mod(files), exclude, held);

const namesOf = (manifest: Manifest): string[] => manifest.packages.map((pkg) => ('name' in pkg ? pkg.name : pkg.kind));

describe('a mod\'s manifest from its files', () => {
  it('names nothing for a folder of metadata alone', () => {
    expect(built({}).manifest).toEqual({ packages: [], exclude: [], files: new Map() });
  });

  it('names each file with its hash, the installation file with its host on Nexus, and the paths the folder excludes', () => {
    const { manifest } = built({ 'a.nif': 'HA' }, { installationFile: download('Mod-1.7z', { 'a.nif': 'HA' }, { size: 7, page: 'nexus:1' }) }, undefined, ['a.nif']);

    expect(manifest).toEqual({
      packages: [{ kind: 'installationFile', name: 'Mod-1.7z', size: 7, hash: 'hash of Mod-1.7z', host: { nexus: NEXUS } }],
      exclude: ['a.nif'], files: new Map([['a.nif', 'HA']]),
    });
  });

  it('names an installation file whose page names no file on Nexus with no host', () => {
    expect(built({}, { installationFile: download('M.7z', {}, { page: 'nexus:mod-only' }) }).manifest.packages).toEqual([
      { kind: 'installationFile', name: 'M.7z', size: 10, hash: 'hash of M.7z' },
    ]);
  });

  it.each([
    ['file ID 0', { game: 'fallout4', mod: 4, file: 0 }],
    ['mod ID 0', { game: 'fallout4', mod: 0, file: 2 }],
    ['an ID that is no whole number', { game: 'fallout4', mod: 1, file: Number.NaN }],
  ])('names an installation file whose Nexus file has %s with no host', (_, nexus) => {
    expect(downloadedFileOf(download('M.7z', {}, { page: 'any' }), () => nexus).package).toEqual(
      { kind: 'installationFile', name: 'M.7z', size: 10, hash: 'hash of M.7z' },
    );
  });

  it('names the installation file though it gives no file, as the mod was installed from it', () => {
    expect(namesOf(built({ 'a.nif': 'HA' }, { installationFile: download('M.7z', {}) }).manifest)).toEqual(['M.7z']);
  });

  it('takes a file from wherever its package holds its bytes, as a FOMOD install moves files', () => {
    expect(built({ 'a.nif': 'HA' }, { installationFile: download('M.7z', { 'Data/a.nif': 'HA' }) }).sources.get('a.nif')).toEqual({ installationFile: 'M.7z', packagePath: 'Data/a.nif', hash: 'HA' });
  });

  it('takes a file at its own path before another path holding the same bytes', () => {
    expect(built({ 'b.nif': 'HA' }, { installationFile: download('M.7z', { 'a.nif': 'HA', 'b.nif': 'HA' }) }).sources.get('b.nif')).toEqual({ installationFile: 'M.7z', packagePath: 'b.nif', hash: 'HA' });
  });

  it('names each file no package holds the bytes of, apart from those a package holds a file of its name of (Status, story 5)', () => {
    const recorded = built({ 'meshes/A.nif': 'HX', 'z.txt': 'HZ', 'b.nif': 'HB' }, { installationFile: download('M.7z', { 'Meshes/a.nif': 'HA', 'b.nif': 'HB' }) });

    expect([recorded.notInPackage, recorded.otherBytes, recorded.manifest.files.get('z.txt')]).toEqual([['z.txt'], ['meshes/A.nif'], 'HZ']);
  });
});

describe('a mod\'s files that the installation file lacks', () => {
  it('are taken from another downloaded file holding their bytes, naming it as a package after the installation file', () => {
    const { manifest } = built({ 'a.nif': 'HA', 'b.nif': 'HB' }, { installationFile: download('Own.7z', { 'a.nif': 'HA' }), downloads: [download('Other.7z', { 'b.nif': 'HB' })] });

    expect(namesOf(manifest)).toEqual(['Own.7z', 'Other.7z']);
  });

  it('are taken from a second download when the installation file holds their path with other bytes', () => {
    const recorded = built({ 'a.nif': 'HA' }, { installationFile: download('Own.7z', { 'a.nif': 'HX' }), downloads: [download('Other.7z', { 'a.nif': 'HA' })] });

    expect([namesOf(recorded.manifest), recorded.otherBytes]).toEqual([['Own.7z', 'Other.7z'], []]);
  });

  it('are taken, with no installation file, from each downloaded file in the order they first serve, preferring one already a package', () => {
    const { manifest } = built({ 'a.nif': 'H', 'b.nif': 'H2' }, { downloads: [download('Z.7z', { 'a.nif': 'H', 'b.nif': 'H2' }), download('A.7z', { 'a.nif': 'H' })] });

    expect(namesOf(manifest)).toEqual(['A.7z', 'Z.7z']);
  });

  it('are taken from the first by hash of two downloaded files of one name', () => {
    const { manifest } = built({ 'a.nif': 'HA' }, { downloads: [download('M.7z', { 'a.nif': 'HX' }, { hash: 'zzz' }), download('M.7z', { 'a.nif': 'HA' }, { hash: 'aaa' })] });

    expect(manifest.packages).toEqual([expect.objectContaining({ hash: 'aaa' })]);
  });

  it('are taken from the game folder before a downloaded file', () => {
    expect(namesOf(built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' })), downloads: [download('Other.7z', { 'a.nif': 'HA' })] }).manifest)).toEqual(['gameFolder']);
  });
});

describe('a mod\'s files that the game folder holds', () => {
  it('are named by the game folder, from the game file handed for their path though another holds the same bytes', () => {
    const recorded = built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'Data/zz.nif': 'HA', 'Data/a.nif': 'HA' }, {}, { 'Data/zz.nif': 'zz.nif', 'Data/a.nif': 'a.nif' })) });

    expect([recorded.manifest.packages, recorded.sources.get('a.nif')]).toEqual([[{ kind: 'gameFolder' }], { packagePath: 'Data/a.nif', hash: 'HA' }]);
  });

  it('name no package when the game holds none of the mod\'s files', () => {
    expect(built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'x.nif': 'HX' })) }).manifest.packages).toEqual([]);
  });

  it('are with other bytes when the game file of their name has other bytes and another file is taken', () => {
    expect(built({ 'a.nif': 'HX', 'c.nif': 'HC' }, { game: gameOf(place({ 'a.nif': 'HA', 'c.nif': 'HC' })) }).otherBytes).toEqual(['a.nif']);
  });

  it('name Steam as the game folder\'s host, with the depots of the places the files are taken from and of no other', () => {
    const steam = { steamApp: 377160, depots: [{ id: '1', version: 'a' }] };
    const { manifest } = built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' }, steam), place({}, { depots: [{ id: '2', version: 'b' }] })) });

    expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 1: 'a' } } } }]);
  });

  it('are taken from the place holding the most, then from the one Steam installed, as a link makes two places hold them', () => {
    const steam = { steamApp: 377160, depots: [{ id: '1', version: 'a' }] };
    const { manifest } = built({ 'a.nif': 'HA', 'b.nif': 'HB' }, { game: gameOf(place({ 'a.nif': 'HA', 'b.nif': 'HB' }), place({ 'a.nif': 'HA', 'b.nif': 'HB' }, steam)) });

    expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 1: 'a' } } } }]);
  });

  describe('when the held manifest names the game folder\'s host', () => {
    const heldHost = { steam: { app: 377160, depots: { 1: 'v' } } };
    const heldGame = (files: Record<string, string>): Manifest => ({ packages: [{ kind: 'gameFolder', host: heldHost }], exclude: [], files: new Map(Object.entries(files)) });

    it('keeps it while the files taken keep their bytes, though the places record other depots', () => {
      const { manifest } = built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' }, { steamApp: 377160, depots: [{ id: '1', version: 'w' }] })) }, heldGame({ 'a.nif': 'HA' }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: heldHost }]);
    });

    it('keeps it when no place records a store, as a copy of the game does, though the files taken changed', () => {
      const { manifest } = built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' })) }, heldGame({ 'a.nif': 'HX' }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: heldHost }]);
    });

    it('takes the store the places record when the files taken changed', () => {
      const { manifest } = built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' }, { steamApp: 377160, depots: [{ id: '2', version: 'w' }] })) }, heldGame({ 'a.nif': 'HX' }));

      expect(manifest.packages).toEqual([{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 2: 'w' } } } }]);
    });
  });
});
