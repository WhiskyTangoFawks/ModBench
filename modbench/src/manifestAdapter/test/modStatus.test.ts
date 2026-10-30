import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { manifestText } from '../manifestText';
import { metadataOf, metadataOverwritten, statusOf, statusesNow, type FolderReads, type Manifest, type ManifestFile, type ManifestPackage, type ModStatus } from '../manifestAdapter';

let root: string;
let folder: string;
let source: string;
let hashed: string[];
let entries: Map<string, ReadonlyMap<string, string>>;
let metadata: Awaited<ReturnType<FolderReads['modMetadata']>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-mod-status-'));
  folder = join(root, 'mods', 'mod');
  source = join(root, 'source', 'Mod');
  await mkdir(folder, { recursive: true });
  hashed = [];
  entries = new Map();
  metadata = { kind: 'read', answer: {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function filesBelow(at: string): Promise<string[]> {
  const listed = await readdir(at, { recursive: true, withFileTypes: true }).catch(() => []);
  return listed.filter((entry) => entry.isFile()).map((entry) => relative(at, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

const foundIgnoringCase = async (path: string): Promise<boolean> =>
  (await filesBelow(folder)).some((held) => held.toLowerCase() === relative(folder, path).toLowerCase());

const readsHashingAFileAsItsText = (fileSystemIgnoresCase = false): FolderReads => ({
  filesIn: async (at) => (await filesBelow(at)).filter((path) => path !== 'meta.ini'),
  fileStamp: async (path) => {
    const there = fileSystemIgnoresCase ? await foundIgnoringCase(path) : await stat(path).then(() => true, () => false);
    return there ? { kind: 'read', answer: undefined } : { kind: 'unreadable', reason: 'ENOENT' };
  },
  originFileHash: async (path) => {
    hashed.push(relative(folder, path));
    return { kind: 'read', answer: { hash: await readFile(path, 'utf8') } };
  },
  packageEntries: (hash) => Promise.resolve(entries.get(hash)),
  modMetadata: () => Promise.resolve(metadata),
});

async function write(path: string, text: string, at = folder): Promise<void> {
  await mkdir(dirname(join(at, path)), { recursive: true });
  await writeFile(join(at, path), text);
}

const MOD_ZIP: ManifestPackage = { kind: 'installationFile', name: 'Mod.zip', size: 7, hash: 'PACK1' };
const line = (path: string, entry: ManifestFile['entry'] = { kind: 'held' }, pkg?: string): ManifestFile => ({ path, entry, ...(pkg === undefined ? {} : { package: pkg }) });
const manifest = (files: ManifestFile[], over: Partial<Manifest> = {}): Manifest => ({ packages: [MOD_ZIP], exclude: [], archives: [], steps: [], tools: [], files, ...over });

function heldAsItSays({ packages: [first], version }: Manifest): void {
  const installationFile = first?.kind === 'installationFile' ? { name: first.name, ...(first.page === undefined ? {} : { page: first.page }) } : undefined;
  metadata = { kind: 'read', answer: { ...(version === undefined ? {} : { version }), ...(installationFile === undefined ? {} : { installationFile }) } };
}

async function manifested(held: Manifest): Promise<void> {
  heldAsItSays(held);
  await write('mod.manifest.json', manifestText(held));
}

async function manifestedFromSource(held: Manifest): Promise<void> {
  heldAsItSays(held);
  await write('mod.manifest.json', manifestText({ ...held, output: 'mod' }), source);
}

const status = (fileSystemIgnoresCase = false): Promise<ModStatus> => statusOf({ name: 'mod', folder }, readsHashingAFileAsItsText(fileSystemIgnoresCase));
const sourceModStatus = (): Promise<ModStatus> => statusOf({ name: 'mod', folder, sourceFolder: source }, readsHashingAFileAsItsText());

const nothing = (over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod: 'mod', noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false, ...over });

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

  it('reads a manifest an editor wrote with a byte order mark', async () => {
    const held = manifest([]);
    await manifested(held);
    await write('mod.manifest.json', `\uFEFF${manifestText(held)}`);

    expect(await status()).toEqual(nothing());
  });

  it('names each file no line names, but its metadata and its manifest in any case', async () => {
    await Promise.all([write('mine.txt', 'mine'), write('meta.ini', 'metadata'), write('a.nif', 'hello')]);
    heldAsItSays(manifest([]));
    await write('MOD.manifest.json', manifestText(manifest([line('a.nif')])));
    entries.set('PACK1', new Map([['a.nif', 'hello']]));

    expect(await status()).toEqual(nothing({ namedByNoLine: ['mine.txt'] }));
  });

  it('after a fresh clone, names every file its manifest names gone, and none differing or named by no line', async () => {
    await manifested(manifest([line('a.nif')]));

    expect(await status()).toEqual(nothing({ gone: ['a.nif'] }));
  });

  it.each([
    ['holds the bytes its package\'s entry holds', 'hello', 'PACK1', []],
    ['was edited', 'edited', 'PACK1', ['a.nif']],
    ['is pinned by a package whose entries the index lacks', 'hello', 'PACK2', ['a.nif']],
  ])('says a file differs, or not, when it %s', async (_, written, pinned, differing) => {
    entries.set('PACK1', new Map([['meshes/a.nif', 'hello']]));
    await write('a.nif', written);
    await manifested(manifest([line('a.nif', { kind: 'heldAt', path: 'meshes/a.nif' })], { packages: [{ ...MOD_ZIP, hash: pinned }] }));

    expect((await status()).differing).toEqual(differing);
  });

  it('says a file differs whose package\'s entries lack its path', async () => {
    entries.set('PACK1', new Map([['b.nif', 'hello']]));
    await write('a.nif', 'hello');
    await manifested(manifest([line('a.nif')]));

    expect((await status()).differing).toEqual(['a.nif']);
  });

  it('reads a file taken from a package other than the first against that package\'s entries', async () => {
    const zed: ManifestPackage = { kind: 'installationFile', name: 'Zed.7z', size: 7, hash: 'ZED' };
    entries.set('ZED', new Map([['b.nif', 'hello']]));
    await write('b.nif', 'hello');
    await manifested(manifest([line('b.nif', { kind: 'held' }, 'Zed.7z')], { packages: [MOD_ZIP, zed] }));

    expect((await status()).differing).toEqual([]);
  });

  it('hashes no file whose line its package does not fix', async () => {
    await Promise.all([write('a.nif', 'edited'), write('b.nif', 'added'), write('mine.txt', 'mine')]);
    await manifested(manifest([line('a.nif', { kind: 'otherBytes' }), line('b.nif', { kind: 'notHeld' })]));

    const read = await status();

    expect([read, hashed]).toEqual([nothing({ notInPackage: ['b.nif'], otherBytes: ['a.nif'], namedByNoLine: ['mine.txt'] }), []]);
  });

  it('names a file a step makes no gap and never differing, but gone when the folder lacks it', async () => {
    await write('made.dds', 'whatever the step wrote');
    await manifested(manifest(
      [line('made.dds', { kind: 'madeByStep' }), line('lacked.dds', { kind: 'madeByStep' })],
      { steps: [{ task: 'Optimise textures', args: [] }] },
    ));

    expect(await status()).toEqual(nothing({ gone: ['lacked.dds'] }));
  });

  it('names no file an archive of its manifest packs gone, though no loose copy is there', async () => {
    await manifested(manifest([line('b.nif')], { archives: [{ path: 'Mod - Main.ba2', files: ['B.nif'] }] }));

    expect((await status()).gone).toEqual([]);
  });

  it.each([
    [true, ['Meshes/A.nif'], [], []],
    [false, [], ['Meshes/A.nif'], ['meshes/a.nif']],
  ])('finds a file a line names in another case only where the file system does (ignoring case: %s)', async (ignoresCase, differing, namedByNoLine, gone) => {
    await write('Meshes/A.nif', 'edited');
    entries.set('PACK1', new Map([['meshes/a.nif', 'hello']]));
    await manifested(manifest([line('meshes/a.nif')]));

    const read = await status(ignoresCase);

    expect([read.differing, read.namedByNoLine, read.gone]).toEqual([differing, namedByNoLine, gone]);
  });

  it.each([[true, false], [false, true]])('says a source mod has no host only when its repository is no submodule (submodule: %s)', async (isSubmodule, noHost) => {
    await write('a.esp', 'hello');
    await manifestedFromSource(manifest([line('a.esp')], { packages: [{ kind: 'sourceRepository', name: 'Mod', isSubmodule }] }));

    expect((await sourceModStatus()).noHost).toBe(noHost);
  });

  it('reads a source mod\'s manifest in its repository, not one in its folder', async () => {
    await Promise.all([write('a.esp', 'hello'), write('notes.txt', 'mine')]);
    await manifested(manifest([line('notes.txt')]));
    await manifestedFromSource(manifest([line('a.esp')], { packages: [{ kind: 'sourceRepository', name: 'Mod', isSubmodule: true }] }));

    const read = await sourceModStatus();

    expect([read.noManifest, read.namedByNoLine]).toEqual([false, ['notes.txt']]);
  });

  it('says a source mod whose folder its build has not made lacks every file its manifest names', async () => {
    await rm(folder, { recursive: true });
    await manifestedFromSource(manifest([line('a.esp')], { packages: [{ kind: 'sourceRepository', name: 'Mod', isSubmodule: true }] }));

    expect(await sourceModStatus()).toEqual(nothing({ gone: ['a.esp'] }));
  });

  it('has no manifest when its repository holds none', async () => {
    await manifested(manifest([line('a.esp')]));
    await mkdir(source, { recursive: true });

    expect((await sourceModStatus()).noManifest).toBe(true);
  });

  it.each([
    ['holds two', async () => {
      await write('A.manifest.json', manifestText({ ...manifest([]), output: 'A' }), source);
      await write('B.manifest.json', manifestText({ ...manifest([]), output: 'B' }), source);
    }, 'its repository holds two manifests, \'A.manifest.json\' and \'B.manifest.json\''],
    ['names no output', () => write('Mod.manifest.json', manifestText(manifest([])), source), 'its manifest names no output folder'],
    ['is not named for its output', () => write('Other.manifest.json', manifestText({ ...manifest([]), output: 'mod' }), source),
      'its manifest \'Other.manifest.json\' is not named for its output folder \'mod\''],
  ])('is unreadable when a source mod\'s repository %s', async (_, arrange, why) => {
    await arrange();

    expect(await sourceModStatus()).toEqual(nothing({ unreadable: why }));
  });

  it('is unreadable, saying why, when its metadata cannot be read', async () => {
    await manifested(manifest([]));
    metadata = { kind: 'unreadable', reason: 'access denied' };

    expect(await status()).toEqual(nothing({ unreadable: 'its metadata could not be read: access denied' }));
  });

  it('is unreadable, saying why, when its folder cannot be listed', async () => {
    await manifested(manifest([]));
    const listing: FolderReads = { ...readsHashingAFileAsItsText(), filesIn: () => Promise.reject(new Error('EACCES: permission denied')) };

    expect(await statusOf({ name: 'mod', folder }, listing)).toEqual(nothing({ unreadable: 'a file could not be read: EACCES: permission denied' }));
  });

  it('read now, finds each mod\'s folder and a source mod\'s repository as the adapter answers them, and none for a mod its name gives no folder', async () => {
    await manifestedFromSource(manifest([line('a.esp')], { packages: [{ kind: 'sourceRepository', name: 'Mod', isSubmodule: true }] }));
    const reads = {
      ...readsHashingAFileAsItsText(),
      modFolderPath: (mod: string) => Promise.resolve(mod === 'mod' ? folder : undefined),
      sourceMods: () => Promise.resolve({ folderOf: (mod: string) => (mod === 'mod' ? source : undefined) }),
    };

    expect(await statusesNow(reads, ['mod', 'Nameless'])).toEqual([nothing({ gone: ['a.esp'] })]);
  });

  describe('its metadata against its manifest\'s, where updating the manifest would write another', () => {
    type Says = { version?: string; installationFile?: { name: string; page?: string } };
    const says = (version?: string, file?: [string, string?]): Says =>
      ({ ...(version === undefined ? {} : { version }), ...(file === undefined ? {} : { installationFile: { name: file[0], ...(file[1] === undefined ? {} : { page: file[1] }) } }) });

    it.each([
      [says('1.0'), says('1.0'), false],
      [says('1.0'), says('2.0'), true],
      [says(), says('2.0'), true],
      [says(undefined, ['a.7z', 'nexus:1']), says(undefined, ['a.7z', 'nexus:1']), false],
      [says(undefined, ['a.7z', 'nexus:1']), says(undefined, ['a.7z', 'nexus:2']), true],
      [says(undefined, ['a.7z']), says(undefined, ['a.7z', 'nexus:1']), true],
      [says(undefined, ['a.7z', 'nexus:1']), says(undefined, ['a.7z']), true],
      [says(undefined, ['old.7z']), says(undefined, ['new.7z']), true],
      [says(undefined, ['a.7z']), says(), true],
      [says(), says(undefined, ['a.7z']), true],
      [says(), says(), false],
      [says('1.0', ['a.7z']), says(undefined, ['a.7z']), true],
      [says('1.0'), says(), false],
    ])('held %j against the manifest\'s %j differs: %s', async (held, manifests, differs) => {
      const file = manifests.installationFile;
      const packages: ManifestPackage[] = file !== undefined
        ? [{ kind: 'installationFile', name: file.name, size: 1, hash: 'hash', ...(file.page === undefined ? {} : { page: file.page }) }]
        : manifests.version !== undefined ? [{ kind: 'gameFolder', name: 'Fallout4', hash: 'hash', depots: [] }] : [];
      await manifested(manifest([], { packages, ...(manifests.version === undefined ? {} : { version: manifests.version }) }));
      metadata = { kind: 'read', answer: held };

      expect((await status()).metadataDiffers).toBe(differs);
    });
  });
});

describe('metadata a restore writes over what the metadata holds', () => {
  type Says = { version?: string; installationFile?: { name: string; page?: string } };
  const says = (version?: string, file?: [string, string?]): Says =>
    ({ ...(version === undefined ? {} : { version }), ...(file === undefined ? {} : { installationFile: { name: file[0], ...(file[1] === undefined ? {} : { page: file[1] }) } }) });

  it.each([
    [says('1.0'), says('1.0'), false],
    [says('1.0'), says('2.0'), true],
    [says(), says('2.0'), false],
    [says('1.0'), says(), false],
    [says(undefined, ['a.7z', 'nexus:1']), says(undefined, ['a.7z', 'nexus:2']), true],
    [says(undefined, ['a.7z']), says(undefined, ['a.7z', 'nexus:1']), false],
    [says(undefined, ['a.7z', 'nexus:1']), says(undefined, ['a.7z']), false],
    [says(undefined, ['old.7z']), says(undefined, ['new.7z']), true],
    [says(), says(undefined, ['a.7z']), false],
    [says(undefined, ['a.7z']), says(), false],
  ])('held %j, the manifest saying %j, is overwritten: %s', (held, manifests, overwritten) => {
    expect(metadataOverwritten(held, manifests)).toBe(overwritten);
  });

  it('is the version and the first package\'s installation file and its page, as the manifest holds them', () => {
    const packages: ManifestPackage[] = [{ kind: 'installationFile', name: 'a.7z', size: 1, hash: 'hash', page: 'nexus:1' }, { kind: 'gameFolder', name: 'Fallout4', hash: 'pin', depots: [] }];

    expect(metadataOf(manifest([], { version: '2.0', packages }))).toEqual({ version: '2.0', installationFile: { name: 'a.7z', page: 'nexus:1' } });
  });
});
