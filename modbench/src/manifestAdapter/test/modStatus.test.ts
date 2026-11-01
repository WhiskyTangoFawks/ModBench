import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { ManifestAt } from '../manifestFiles';
import type { HashedPath, StatusValues } from '../../repositoriesLib/statusValues';
import { manifestText } from '../manifestText';
import { manifestAt, packagesAskedAt, statusFrom, type Manifest, type ManifestPackage, type ModStatus } from '../manifestAdapter';

const HELLO = 'AAAAAAAAAAA=';
const EDITED = 'BBBBBBBBBBA=';
const PACK = 'CCCCCCCCCCA=';

let root: string;
let folder: string;
let entries: HashedPath[];
let notDownloaded: Set<string>;
let downloadedHash: Map<string, string>;
let gameFiles: HashedPath[] | undefined;
let repositoryHosted: boolean;
let exclude: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-mod-status-'));
  folder = join(root, 'mods', 'mod');
  await mkdir(folder, { recursive: true });
  entries = [];
  notDownloaded = new Set();
  downloadedHash = new Map();
  gameFiles = [];
  repositoryHosted = true;
  exclude = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function filesBelow(at: string): Promise<string[]> {
  const listed = await readdir(at, { recursive: true, withFileTypes: true }).catch(() => []);
  return listed.filter((entry) => entry.isFile()).map((entry) => relative(at, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

type ReadValues = Extract<StatusValues, { kind: 'read' }>;

async function valuesHashingEachFileAsItsText(manifest: ManifestAt, ignoresCase: boolean): Promise<ReadValues> {
  const asked = packagesAskedAt(manifest) ?? { installationFiles: [] };
  const files = new Map(await Promise.all((await filesBelow(folder)).filter((path) => path !== 'meta.ini').map(
    async (path) => [path, { path, excluded: false, read: { kind: 'read' as const, answer: { hash: await readFile(join(folder, path), 'utf8') } } }] as const,
  )));
  return {
    kind: 'read', folder: { files, exclude, ignoresCase },
    downloadedFiles: new Map(asked.installationFiles.map((name) => [name, {
      kind: 'read' as const, answer: notDownloaded.has(name) ? undefined : { hash: downloadedHash.get(name) ?? PACK, entries },
    }])),
    gameFiles, repositoryHosted,
  };
}

async function write(path: string, text: string, at = folder): Promise<void> {
  await mkdir(dirname(join(at, path)), { recursive: true });
  await writeFile(join(at, path), text);
}

const MOD_ZIP: ManifestPackage = { kind: 'installationFile', name: 'Mod.zip', size: 7, hash: PACK, host: { nexus: { game: 'fallout4', mod: 1, file: 2 } } };
const REPOSITORY: ManifestPackage = { kind: 'repository', name: 'Mod' };
const manifest = (files: Record<string, string | null>, over: Partial<Manifest> = {}): Manifest =>
  ({ packages: [MOD_ZIP], exclude: [], ignore: [], files: new Map(Object.entries(files)), ...over });

const manifested = (held: Manifest): Promise<void> => write('mod.manifest.json', manifestText(held));

async function statusWith(values: (read: ReadValues) => StatusValues = (read) => read, fileSystemIgnoresCase = false): Promise<ModStatus> {
  const manifest = await manifestAt(folder);
  return statusFrom({ name: 'mod', folder }, manifest, values(await valuesHashingEachFileAsItsText(manifest, fileSystemIgnoresCase)));
}

const status = (fileSystemIgnoresCase = false): Promise<ModStatus> => statusWith((read) => read, fileSystemIgnoresCase);

const nothing = (over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod: 'mod', packages: [], noManifest: false, differing: [], namedByNoLine: [], ignored: [], gone: [], notInPackage: [], otherBytes: [], noHost: [], packagesLacking: [], ...over });

const heldAs = (over: Partial<ModStatus> = {}): ModStatus => nothing({ manifestFile: join(folder, 'mod.manifest.json'), packages: [MOD_ZIP], ...over });

describe('a mod\'s status against its manifest', () => {
  it('has no manifest, and lists nothing, when its folder holds none', async () => {
    await write('mine.txt', 'mine');

    expect(await status()).toEqual(nothing({ noManifest: true }));
  });

  it('is unreadable, naming the line, and lists nothing, when its manifest cannot be read', async () => {
    await write('mine.txt', 'mine');
    await write('mod.manifest.json', '<<<<<<< HEAD\n');

    expect(await status()).toEqual(nothing({ unreadable: 'its manifest cannot be read at line 1' }));
  });

  it('is unreadable, naming both versions, when its manifest is of the format before version 1', async () => {
    await write('mod.manifest.json', '{\n"files": []\n}\n');

    expect(await status()).toEqual(nothing({ unreadable: 'its manifest is in a format before version 1, and Modbench reads only version 1' }));
  });

  it('reads a manifest an editor wrote with a byte order mark', async () => {
    await write('mod.manifest.json', `\uFEFF${manifestText(manifest({}))}`);

    expect(await status()).toEqual(heldAs());
  });

  it('reads and names the manifest a folder renamed outside Modbench holds under the name it had (source.md, Build, story 4)', async () => {
    await write('Old Name.manifest.json', manifestText(manifest({})));

    expect(await status()).toEqual(heldAs({ manifestFile: join(folder, 'Old Name.manifest.json') }));
  });

  it('names each file the manifest does not, but its metadata and its manifest in any case', async () => {
    await Promise.all([write('mine.txt', 'mine'), write('meta.ini', 'metadata'), write('a.nif', HELLO)]);
    await write('MOD.manifest.json', manifestText(manifest({ 'a.nif': HELLO })));
    entries = [{ path: 'a.nif', hash: HELLO }];

    expect(await status()).toEqual(nothing({ namedByNoLine: ['mine.txt'], manifestFile: join(folder, 'MOD.manifest.json'), packages: [MOD_ZIP] }));
  });

  it('lists a file its manifest ignores as ignored, neither differing nor named by no line, though its bytes are none the manifest records', async () => {
    await Promise.all([write('F4SE/Plugins/BetterConsole.mem', EDITED), write('logs/a.log', EDITED), write('a.nif', HELLO)]);
    entries = [{ path: 'a.nif', hash: HELLO }];
    await manifested(manifest({ 'a.nif': HELLO }, { ignore: ['F4SE/Plugins/BetterConsole.mem', 'logs'] }));

    expect(await status()).toEqual(heldAs({ ignored: ['F4SE/Plugins/BetterConsole.mem', 'logs/a.log'] }));
  });

  it('after a fresh clone, names every file its manifest names gone, and none differing or named by no line', async () => {
    entries = [{ path: 'a.nif', hash: HELLO }];
    await manifested(manifest({ 'a.nif': HELLO }));

    expect(await status()).toEqual(heldAs({ gone: ['a.nif'] }));
  });

  it.each([
    ['holds the bytes its manifest records', HELLO, []],
    ['was edited', EDITED, ['a.nif']],
  ])('says a file differs, or not, when it %s, whatever its package holds (Status, story 3)', async (_, written, differing) => {
    await write('a.nif', written);
    await manifested(manifest({ 'a.nif': HELLO }));

    expect((await status()).differing).toEqual(differing);
  });

  it.each([
    ['the folder excludes it and the manifest does not', ['a.nif'], [], ['a.nif.mohidden']],
    ['the manifest excludes it and the folder does not', [], ['a.nif'], ['a.nif']],
    ['both exclude it', ['a.nif'], ['a.nif'], []],
  ])('says a file differs when %s, by the path the folder holds it at', async (_, excludedOnDisk, excludedInManifest, differing) => {
    const onDisk = excludedOnDisk.length > 0 ? 'a.nif.mohidden' : 'a.nif';
    entries = [{ path: 'a.nif', hash: HELLO }];
    await write('a.nif', HELLO);
    exclude = excludedOnDisk;
    await manifested(manifest({ 'a.nif': HELLO }, { exclude: excludedInManifest }));
    const read = (values: ReadValues): ReadValues => {
      const file = values.folder.files.get('a.nif');
      return file === undefined ? values : { ...values, folder: { ...values.folder, files: new Map([[onDisk, { ...file, excluded: excludedOnDisk.length > 0 }]]) } };
    };

    expect((await statusWith(read)).differing).toEqual(differing);
  });

  it('reads the one of two files at the path it names that its exclusion fits, and names the other', async () => {
    await write('a.nif', HELLO);
    exclude = ['a.nif'];
    entries = [{ path: 'a.nif', hash: HELLO }];
    await manifested(manifest({ 'a.nif': HELLO }));
    const read = (values: ReadValues): ReadValues => ({ ...values, folder: { ...values.folder, files: new Map([
      ['a.nif.mohidden', { path: 'a.nif', excluded: true, read: { kind: 'read', answer: { hash: EDITED } } }],
      ['a.nif', { path: 'a.nif', excluded: false, read: { kind: 'read', answer: { hash: HELLO } } }],
    ]) } });

    expect(await statusWith(read)).toEqual(heldAs({ namedByNoLine: ['a.nif.mohidden'] }));
  });

  it('never checks a file a step makes, but names it gone when the folder lacks it', async () => {
    await write('made.dds', 'whatever the step wrote');
    await manifested(manifest({ 'made.dds': null, 'lacked.dds': null }, { packages: [REPOSITORY] }));

    expect(await status()).toEqual(heldAs({ packages: [REPOSITORY], gone: ['lacked.dds'] }));
  });

  it.each([
    [true, ['Meshes/A.nif'], [], []],
    [false, [], ['Meshes/A.nif'], ['meshes/a.nif']],
  ])('finds a file the manifest names in another case only where the file system does (ignoring case: %s)', async (ignoresCase, differing, namedByNoLine, gone) => {
    await write('Meshes/A.nif', EDITED);
    entries = [{ path: 'meshes/a.nif', hash: HELLO }];
    await manifested(manifest({ 'meshes/a.nif': HELLO }));

    const read = await status(ignoresCase);

    expect([read.differing, read.namedByNoLine, read.gone]).toEqual([differing, namedByNoLine, gone]);
  });

  describe('a file a clone cannot rebuild (Status, story 5)', () => {
    it.each([
      ['a package holds its bytes at another path', [{ path: '00 Core/meshes/a.nif', hash: HELLO }], [], []],
      ['a package holds a file of its name, its path in any case, with other bytes', [{ path: 'Meshes/A.NIF', hash: EDITED }], [], ['meshes/a.nif']],
      ['no package holds its bytes, though one holds a file of its base name at another path', [{ path: '00 Core/a.nif', hash: EDITED }], ['meshes/a.nif'], []],
    ])('says why when %s', async (_case, held, notInPackage, otherBytes) => {
      entries = held;
      await write('meshes/a.nif', HELLO);
      await manifested(manifest({ 'meshes/a.nif': HELLO }));

      expect(await status()).toEqual(heldAs({ notInPackage, otherBytes }));
    });

    it('reads the game folder as a package that holds the game files the folder\'s files may be', async () => {
      gameFiles = [{ path: 'a.nif', hash: HELLO }];
      await write('a.nif', HELLO);
      await manifested(manifest({ 'a.nif': HELLO }, { packages: [{ kind: 'gameFolder', host: { steam: { app: 1 } } }] }));

      expect(await status()).toEqual(heldAs({ packages: [{ kind: 'gameFolder', host: { steam: { app: 1 } } }] }));
    });

    it('names none while this machine lacks a package, which could hold it', async () => {
      notDownloaded.add('Mod.zip');
      await write('a.nif', HELLO);
      await manifested(manifest({ 'a.nif': HELLO }));

      expect(await status()).toEqual(heldAs({ packagesLacking: ["installation file 'Mod.zip' is missing"] }));
    });

    it('names none of a source mod\'s, whose build makes them', async () => {
      await write('a.esp', HELLO);
      await manifested(manifest({ 'a.esp': HELLO }, { packages: [REPOSITORY] }));

      expect(await status()).toEqual(heldAs({ packages: [REPOSITORY] }));
    });
  });

  it.each<[string, ManifestPackage, boolean, string[]]>([
    ['an installation file with no host', { kind: 'installationFile', name: 'Mod.zip', size: 7, hash: PACK }, true, ["installation file 'Mod.zip'"]],
    ['a game folder with no host', { kind: 'gameFolder' }, true, ['the game folder']],
    ['a repository that is no submodule', REPOSITORY, false, ["repository 'Mod'"]],
    ['a repository that is a submodule', REPOSITORY, true, []],
    ['an installation file on Nexus', MOD_ZIP, true, []],
  ])('names each package with no host (The manifest, story 5): %s', async (_case, pkg, hosted, noHost) => {
    repositoryHosted = hosted;
    await manifested(manifest({}, { packages: [pkg] }));

    expect((await status()).noHost).toEqual(noHost);
  });

  it.each([
    ['an installation file the downloads folder lacks', (): void => { notDownloaded.add('Mod.zip'); }, "installation file 'Mod.zip' is missing"],
    ['an installation file with other bytes', (): void => { downloadedHash.set('Mod.zip', EDITED); }, "installation file 'Mod.zip' has other bytes"],
    ['a game folder that is not found', (): void => { gameFiles = undefined; }, 'the game folder was not found'],
  ])('lists a package it names that this machine lacks: %s', async (_case, lackIt, lack) => {
    await manifested(manifest({}, { packages: [MOD_ZIP, { kind: 'gameFolder', host: { steam: { app: 1 } } }] }));
    lackIt();

    expect((await status()).packagesLacking).toEqual([lack]);
  });

  it('says why a downloaded file it names cannot be looked up', async () => {
    await manifested(manifest({}));
    const read = (values: ReadValues): ReadValues => ({ ...values, downloadedFiles: new Map([['Mod.zip', { kind: 'unreadable' as const, reason: 'EACCES' }]]) });

    expect((await statusWith(read)).packagesLacking).toEqual(["installation file 'Mod.zip' could not be read: EACCES"]);
  });

  it('is unreadable, saying why, when the values say a read of its folder rejected', async () => {
    await manifested(manifest({}));

    expect(await statusWith(() => ({ kind: 'unreadable', reason: 'EACCES: permission denied' }))).toEqual(nothing({ unreadable: 'a file could not be read: EACCES: permission denied' }));
  });

  it('is unreadable, saying why, when its folder cannot be read for its manifest', async () => {
    await write('not-a-folder', 'x', root);

    const { read } = await manifestAt(join(root, 'not-a-folder'));
    if (read === undefined || !('refused' in read)) throw new Error('expected a refusal');

    expect(read.refused).toMatch(/^a file could not be read: ENOTDIR/);
  });
});
