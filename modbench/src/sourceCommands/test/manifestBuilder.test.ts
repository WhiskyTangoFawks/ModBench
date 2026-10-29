import { describe, expect, it } from 'vitest';
import type { InstallationFile } from '../../instanceAdapter/instanceAdapter';
import type { Manifest, ManifestFile } from '../../manifestAdapter/manifestAdapter';
import { buildManifest, downloadedFilesOf, type GameHeld, type GamePlaceHeld, type HashedModFile } from '../manifestBuilder';

const pinOf = (text: string): Promise<string> => Promise.resolve(`#${text.replaceAll('\n', '|')}`);

const EMPTY: Manifest = { packages: [], exclude: [], archives: [], steps: [], tools: [], files: [] };

const download = (name: string, entries: Record<string, string>, over: Partial<InstallationFile> = {}): InstallationFile =>
  ({ path: `/downloads/${name}`, size: 10, hash: `hash of ${name}`, entries: Object.entries(entries).map(([path, hash]) => ({ path, hash })), ...over });

const mod = (files: Record<string, string>): HashedModFile[] => Object.entries(files).map(([path, hash]) => ({ path, hash }));

const place = (files: Record<string, string>, depots: GamePlaceHeld['depots'] = [], pathsInFolder: Record<string, string> = {}): GamePlaceHeld =>
  ({ files: Object.entries(files).map(([path, hash]) => ({ path, hash, pathInFolder: pathsInFolder[path] ?? path })), depots });

const gameOf = (...places: [GamePlaceHeld, ...GamePlaceHeld[]]): GameHeld => ({ name: 'Fallout4', places });

const built = (
  files: Record<string, string>, sources: { installationFile?: InstallationFile; game?: GameHeld; downloads?: InstallationFile[] } = {}, held?: Manifest, version?: string,
) => buildManifest(
  { downloadedFiles: downloadedFilesOf(sources.downloads ?? []), ...sources.installationFile ? { installationFile: sources.installationFile } : {}, ...sources.game ? { game: sources.game } : {} },
  mod(files), version, held, pinOf);

const linesOf = async (...args: Parameters<typeof built>): Promise<readonly ManifestFile[]> => (await built(...args)).manifest.files;

describe('a mod\'s manifest from its files', () => {
  it('names nothing for a folder of metadata alone', async () => {
    expect((await built({})).manifest).toEqual(EMPTY);
  });

  it('names a file the installation file holds at its path by the short line, and the package as the installation file says it', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { installationFile: download('Mod-1.7z', { 'a.nif': 'HA' }, { size: 7, page: 'nexus:1' }) }, undefined, '1.2');

    expect(manifest).toEqual({
      ...EMPTY, version: '1.2', files: [{ path: 'a.nif', entry: { kind: 'held' } }],
      packages: [{ kind: 'installationFile', name: 'Mod-1.7z', size: 7, hash: 'hash of Mod-1.7z', page: 'nexus:1' }],
    });
  });

  it('records a version only when the mod has a package', async () => {
    expect([(await built({ 'a.nif': 'HA' }, {}, undefined, '1.2')).manifest.version, (await built({}, { installationFile: download('M.7z', {}) }, undefined, '1.2')).manifest.version]).toEqual([undefined, '1.2']);
  });

  it('names the path a package holds a file at when it is not the file\'s own, as a FOMOD install moves files', async () => {
    expect(await linesOf({ 'a.nif': 'HA' }, { installationFile: download('M.7z', { 'Data/a.nif': 'HA' }) })).toEqual([{ path: 'a.nif', entry: { kind: 'heldAt', path: 'Data/a.nif' } }]);
  });

  it('takes a file at its own path before another path holding the same bytes', async () => {
    expect(await linesOf({ 'b.nif': 'HA' }, { installationFile: download('M.7z', { 'a.nif': 'HA', 'b.nif': 'HA' }) })).toEqual([{ path: 'b.nif', entry: { kind: 'held' } }]);
  });

  it('records a file the package holds at its path with other bytes as such, and a file nothing holds as not held', async () => {
    const lines = await linesOf({ 'a.nif': 'HX', 'z.txt': 'HZ' }, { installationFile: download('M.7z', { 'a.nif': 'HA' }) });

    expect(lines).toEqual([{ path: 'a.nif', entry: { kind: 'otherBytes' } }, { path: 'z.txt', entry: { kind: 'notHeld' } }]);
  });

  it('records a file the mod adds beside the installation file\'s as not held, not as other bytes', async () => {
    expect(await linesOf({ 'textures/new.dds': 'HN' }, { installationFile: download('M.7z', { 'textures/old.dds': 'HO' }) })).toEqual([{ path: 'textures/new.dds', entry: { kind: 'notHeld' } }]);
  });

  it('lists the files in the order a manifest lists paths', async () => {
    expect((await linesOf({ 'b.nif': '1', 'B.nif': '2', 'a.nif': '3' })).map(({ path }) => path)).toEqual(['a.nif', 'B.nif', 'b.nif']);
  });
});

describe('a mod\'s files that the installation file lacks', () => {
  it('are taken from another downloaded file holding their bytes, naming it as a package after the installation file', async () => {
    const { manifest } = await built(
      { 'a.nif': 'HA', 'b.nif': 'HB' }, { installationFile: download('Own.7z', { 'a.nif': 'HA' }), downloads: [download('Other.7z', { 'b.nif': 'HB' })] });

    expect([manifest.packages.map((pkg) => (pkg.kind === 'installationFile' ? pkg.name : '')), manifest.files]).toEqual([
      ['Own.7z', 'Other.7z'], [{ path: 'a.nif', entry: { kind: 'held' } }, { path: 'b.nif', entry: { kind: 'held' }, package: 'Other.7z' }],
    ]);
  });

  it('are recorded with other bytes, naming the package, when a second package serving another file holds their path with other bytes', async () => {
    const lines = await linesOf(
      { 'a.nif': 'HA', 'b.nif': 'HX', 'c.nif': 'HC' }, { installationFile: download('Own.7z', { 'a.nif': 'HA' }), downloads: [download('Other.7z', { 'b.nif': 'HB', 'c.nif': 'HC' })] });

    expect(lines).toEqual([
      { path: 'a.nif', entry: { kind: 'held' } }, { path: 'b.nif', entry: { kind: 'otherBytes' }, package: 'Other.7z' }, { path: 'c.nif', entry: { kind: 'held' }, package: 'Other.7z' },
    ]);
  });

  it('are taken, with no installation file, from each downloaded file in the order they first serve, preferring one already a package', async () => {
    const { manifest } = await built(
      { 'a.nif': 'H', 'b.nif': 'H2' }, { downloads: [download('Z.7z', { 'a.nif': 'H', 'b.nif': 'H2' }), download('A.7z', { 'a.nif': 'H' })] });

    expect(manifest.files).toEqual([{ path: 'a.nif', entry: { kind: 'held' } }, { path: 'b.nif', entry: { kind: 'held' }, package: 'Z.7z' }]);
    expect(manifest.packages.map((pkg) => (pkg.kind === 'installationFile' ? pkg.name : ''))).toEqual(['A.7z', 'Z.7z']);
  });

  it('are taken from the first by hash of two downloaded files of one name', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { downloads: [download('M.7z', { 'a.nif': 'HX' }, { hash: 'zzz' }), download('M.7z', { 'a.nif': 'HA' }, { hash: 'aaa' })] });

    expect([manifest.packages, manifest.files]).toEqual([[expect.objectContaining({ hash: 'aaa' })], [{ path: 'a.nif', entry: { kind: 'held' } }]]);
  });

  it('are taken from the game folder before a downloaded file', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' })), downloads: [download('Other.7z', { 'a.nif': 'HA' })] });

    expect(manifest.packages).toEqual([{ kind: 'gameFolder', name: 'Fallout4', hash: '#a.nif|HA|', depots: [] }]);
  });
});

describe('a mod\'s files that the game folder holds', () => {
  it('are named by the game folder, pinned by the path and hash of each file it takes, with the entries the pin fixes', async () => {
    const result = await built({ 'meshes/b.nif': 'HB', 'a.dds': 'HA' }, { game: gameOf(place({ 'Data/b.nif': 'HB', 'a.dds': 'HA' }, [], { 'Data/b.nif': 'meshes/b.nif' })) });

    expect(result.gamePackage).toEqual({ hash: '#a.dds|HA|meshes/b.nif|HB|', entries: new Map([['a.dds', 'HA'], ['Data/b.nif', 'HB']]) });
    expect(result.manifest.files).toEqual([{ path: 'a.dds', entry: { kind: 'held' } }, { path: 'meshes/b.nif', entry: { kind: 'heldAt', path: 'Data/b.nif' } }]);
  });

  it('name no package when the game holds none of the mod\'s files', async () => {
    expect([(await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'x.nif': 'HX' })) })).manifest.packages, (await built({}, { game: gameOf(place({})) })).gamePackage]).toEqual([[], undefined]);
  });

  it('are recorded with other bytes, when the game file at their path has other bytes and another file is taken', async () => {
    expect(await linesOf({ 'a.nif': 'HX', 'c.nif': 'HC' }, { game: gameOf(place({ 'a.nif': 'HA', 'c.nif': 'HC' })) })).toEqual([
      { path: 'a.nif', entry: { kind: 'otherBytes' } }, { path: 'c.nif', entry: { kind: 'held' } },
    ]);
  });

  it('are recorded as not held when no package holds their path', async () => {
    expect(await linesOf({ 'a.nif': 'HX' }, { game: gameOf(place({ 'a.nif': 'HA' })) })).toEqual([{ path: 'a.nif', entry: { kind: 'notHeld' } }]);
  });

  it('are all taken, from every place of the game, under the one package', async () => {
    const { manifest } = await built({ 'a.nif': 'HA', 'b.nif': 'HB' }, { game: gameOf(place({ 'a.nif': 'HA' }), place({ 'b.nif': 'HB' })) });

    expect([manifest.packages.length, manifest.files]).toEqual([1, [{ path: 'a.nif', entry: { kind: 'held' } }, { path: 'b.nif', entry: { kind: 'held' } }]]);
  });

  it('name the depots of the places the files are taken from, and of no place nothing is taken from', async () => {
    const steam = [{ id: '1', version: 'a' }];
    const gog = [{ id: '2', version: 'b' }];
    const { manifest } = await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' }, steam), place({}, gog)) });

    expect(manifest.packages).toEqual([expect.objectContaining({ depots: steam })]);
  });

  it('are taken from the place holding the most, then from the one with depots', async () => {
    const withDepots = [{ id: '1', version: 'a' }];
    const { manifest } = await built({ 'a.nif': 'HA', 'b.nif': 'HB' }, {
      game: gameOf(place({ 'a.nif': 'HA' }), place({ 'a.nif': 'HA', 'b.nif': 'HB' }, withDepots)),
    });

    expect(manifest.packages).toEqual([expect.objectContaining({ depots: withDepots })]);
  });

  it('are taken from a later place that holds a file the first lacks', async () => {
    const second = [{ id: '2', version: 'b' }];
    const { manifest } = await built({ 'a.nif': 'HA', 'b.nif': 'HB' }, { game: gameOf(place({ 'a.nif': 'HA' }, [{ id: '1', version: 'a' }]), place({ 'b.nif': 'HB' }, second)) });

    expect(manifest.packages).toEqual([expect.objectContaining({ depots: [{ id: '1', version: 'a' }, ...second] })]);
  });
});

describe('a mod whose manifest is held', () => {
  const step = { task: 'Optimise', args: [] as string[] };
  const held: Manifest = {
    ...EMPTY, output: 'Mod', exclude: ['x'], archives: [{ path: 'Mod.ba2', files: ['a.nif'] }], steps: [step], tools: [{ task: 'Optimise', page: 'p' }],
    files: [{ path: 'made.dds', entry: { kind: 'madeByStep' } }, { path: 'old.nif', entry: { kind: 'held' } }],
  };

  it('keeps its output, exclusions, archives, steps and tools as written', async () => {
    const { manifest } = await built({ 'a.nif': 'HA' }, {}, held);

    expect(manifest).toMatchObject({ output: 'Mod', exclude: ['x'], archives: held.archives, steps: [step], tools: held.tools });
  });

  it('keeps each file a step makes, there or not, and hashes it into no package', async () => {
    const { manifest } = await built({ 'a.nif': 'HA', 'made.dds': 'HM' }, { installationFile: download('M.7z', { 'made.dds': 'HM' }) }, held);

    expect(manifest.files).toEqual([{ path: 'a.nif', entry: { kind: 'notHeld' } }, { path: 'made.dds', entry: { kind: 'madeByStep' } }]);
  });

  describe('naming the game folder', () => {
    const depots = [{ id: '1', version: 'v' }];
    const heldGame = (hash: string, kept = depots): Manifest => ({ ...EMPTY, packages: [{ kind: 'gameFolder', name: 'Fallout4', hash, depots: kept }] });

    it('keeps its depots when the files taken are the same, though the places record none', async () => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' })) }, heldGame('#a.nif|HA|'));

      expect(manifest.packages).toEqual([expect.objectContaining({ depots })]);
    });

    it('keeps its depots when the places record none, as a copy of the game does, though the files taken changed', async () => {
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' })) }, heldGame('#other'));

      expect(manifest.packages).toEqual([expect.objectContaining({ depots })]);
    });

    it('takes the depots the places record when the files taken changed', async () => {
      const now = [{ id: '2', version: 'w' }];
      const { manifest } = await built({ 'a.nif': 'HA' }, { game: gameOf(place({ 'a.nif': 'HA' }, now)) }, heldGame('#other'));

      expect(manifest.packages).toEqual([expect.objectContaining({ depots: now })]);
    });
  });
});
