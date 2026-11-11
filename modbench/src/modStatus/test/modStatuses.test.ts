import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EntryRef, InstanceAdapter, ModFolder } from '../../instanceAdapter/instanceAdapter';
import { modValueOver } from '../../instanceAdapter/modValue';
import type { Manifest, ModStatus, PossibleHashes } from '../../manifestAdapter/manifestAdapter';
import { localFailure } from '../../wire/readFailed';
import { writeManifestIn } from '../../manifestAdapter/manifestAdapter';
import { buildFileOf, writeBuildFile } from '../../test/buildFiles';
import { ModStatuses, type StatusSource } from '../modStatuses';

let root: string;
let logged: string[];
let asked: string[];
let hashed: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-mod-statuses-'));
  logged = [];
  asked = [];
  hashed = [];
  installationFiles = new Map();
  heldWhole = new Set();
  heldByGit = new Map();
  listings = 0;
  whileListing = () => undefined;
  failingInstallationReads = 0;
  hashingContents = false;
  downloads = new Map();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reads: Parameters<typeof modValueOver>[0] = {
  filesIn: async (folder) => (await readdir(folder).catch(() => [])).filter((name) => !name.endsWith('.manifest.json')),
  fileStamp: () => Promise.resolve({ kind: 'unreadable', reason: 'ENOENT' }),
  originFileHash: async (path): ReturnType<typeof reads.originFileHash> => {
    hashed.push(path);
    return hashingContents ? { kind: 'read', answer: { hash: await readFile(path, 'utf8'), size: 0 } } : { kind: 'unreadable', reason: 'unhashed' };
  },
  exclusionMark: '.mohidden',
  downloadedFile: (name) => {
    const download = downloads.get(name);
    return Promise.resolve({ kind: 'read', answer: download && { ...download, path: name, size: 1 } });
  },
  gamePlaces: () => Promise.resolve([]),
  gameFilesTakenBy: () => Promise.resolve({ kind: 'read', answer: { gameFiles: [], notes: [] } }),
  submodule: () => Promise.resolve({ lacks: 'no submodule' }),
  sourceFolderTracked: () => Promise.resolve(false),
};

const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map() };

async function folderOf(name: string, files: Record<string, string> = {}): Promise<string> {
  const folder = join(root, 'mods', name);
  await mkdir(folder, { recursive: true });
  await Promise.all(Object.entries(files).map(([file, text]) => writeFile(join(folder, file), text)));
  return folder;
}

const file = (name: string) => ({ kind: 'installationFile' as const, name, size: 1, hash: 'AAAAAAAAAAA=' });

const folder = (kind: EntryRef['kind'], name: string, path: string, modName = name): ModFolder => ({ kind, name, path, modName });

const valueOf = (mods: EntryRef[], modFolders: ModFolder[], over: Partial<StatusSource> = {}): StatusSource =>
  ({ holdsRepository: true, mods, modFolders, entryKey: ({ name }) => name.toLowerCase(), paths: { sourceDirs: new Map() }, filesByMod: new Map(), ...over });

let heldWhole: ReadonlySet<string>;
let heldByGit: ReadonlyMap<string, readonly string[]>;
let listings: number;
let whileListing: () => void;
let failingInstallationReads: number;
let hashingContents: boolean;
let downloads: ReadonlyMap<string, { hash: string; entries: { path: string; hash: string }[] }>;
let installationFiles: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['installationFile']>>>;

const instance: Pick<InstanceAdapter, 'modValue' | 'installationFile' | 'foldersHeldWhole' | 'filesHeldByGit'> = {
  foldersHeldWhole: (folders) => Promise.resolve(new Set(folders.filter((folder) => heldWhole.has(folder)))),
  filesHeldByGit: (folders) => {
    listings += 1;
    whileListing();
    return Promise.resolve(new Map(folders.map((folder) => [folder, heldByGit.get(folder) ?? []])));
  },
  installationFile: (mod) => (failingInstallationReads-- > 0
    ? Promise.reject(new Error('the installation file could not be asked'))
    : Promise.resolve(installationFiles.get(mod) ?? { kind: 'read', answer: undefined })),
  modValue: (folder, wanted, held) => {
    asked.push(basename(folder));
    return modValueOver(reads, folder, wanted, held);
  },
};

const statusesLogging = (): ModStatuses => new ModStatuses(instance, (line) => { logged.push(line); });

describe('Mod status, derived from each instance value (mod-status trace)', () => {
  it('derives each listed mod\'s status by its folder\'s mod name, and none for a separator, which has no manifest, or an entry with no folder', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    await writeManifestIn(mod, EMPTY);
    const separator = await folderOf('Tools_separator');
    const statuses = statusesLogging();

    statuses.derive(valueOf(
      [{ kind: 'mod', name: 'MODA' }, { kind: 'separator', name: 'Tools' }, { kind: 'mod', name: 'Folderless' }],
      [folder('mod', 'ModA', mod), folder('separator', 'Tools', separator, 'Tools_separator')],
    ));
    const derived = await statuses.current();

    expect([...derived.keys()]).toEqual(['ModA']);
    expect(derived.get('ModA')?.namedByNoLine).toEqual(['mine.txt']);
  });

  it('reads no file git holds as one its manifest does not name, with one listing of what git holds for every mod (Status, stories 1 and 3)', async () => {
    const [first, second] = [await folderOf('ModA', { 'mine.txt': '', 'config.ini': '' }), await folderOf('ModB', { 'b.ini': '' })];
    await writeManifestIn(first, EMPTY);
    await writeManifestIn(second, EMPTY);
    heldByGit = new Map([[first, ['config.ini']], [second, ['b.ini']]]);
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', first), folder('mod', 'ModB', second)]));
    const derived = await statuses.current();

    expect([derived.get('ModA')?.namedByNoLine, derived.get('ModB')?.namedByNoLine, listings]).toEqual([['mine.txt'], [], 1]);
  });

  it('carries each path its build file names that its source folder lacks, while it lacks it (Status, story 2)', async () => {
    const mod = await folderOf('ModA');
    await writeManifestIn(mod, EMPTY);
    const source = join(root, 'source', 'ModA');
    await mkdir(source, { recursive: true });
    await writeBuildFile(source, buildFileOf({ steps: [{ kind: 'compile', paths: ['Renamed.esp'] }] }));
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { sourceDirs: new Map([['ModA', source]]) } });
    const statuses = statusesLogging();

    statuses.derive(value);
    const lacking = (await statuses.current()).get('ModA')?.buildFile?.lacks;
    await mkdir(join(source, 'plugin-source', 'Renamed.esp'), { recursive: true });
    statuses.derive(value);

    expect([lacking, (await statuses.current()).get('ModA')?.buildFile?.lacks]).toEqual([[{ step: 'compile', path: 'Renamed.esp' }], []]);
  });

  it('carries the packages its manifest names', async () => {
    const mod = await folderOf('ModA');
    await writeManifestIn(mod, { ...EMPTY, packages: [file('A.7z'), { kind: 'gameFolder' }] });
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));

    expect((await statuses.current()).get('ModA')?.packages).toEqual([file('A.7z'), { kind: 'gameFolder' }]);
  });

  it('says why the installation file the mod manager names is missing or unreadable, with or without a manifest (Status, story 7)', async () => {
    const [withManifest, without] = [await folderOf('ModA'), await folderOf('ModB')];
    await writeManifestIn(withManifest, EMPTY);
    installationFiles = new Map([
      ['ModA', { kind: 'unreadable', reason: 'this machine does not hold A.7z, the file it is installed from' }],
      ['ModB', { kind: 'unreadable', reason: 'Modbench cannot tell what B.rar installs: 7z crashed' }],
    ]);
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', withManifest), folder('mod', 'ModB', without)]));
    const derived = await statuses.current();

    expect([derived.get('ModA')?.installationFileProblem, derived.get('ModB')?.installationFileProblem]).toEqual([
      'this machine does not hold A.7z, the file it is installed from', 'Modbench cannot tell what B.rar installs: 7z crashed',
    ]);
  });

  it('says nothing of an installation file the mod manager names that reads, or names none', async () => {
    const mod = await folderOf('ModA');
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));

    expect((await statuses.current()).get('ModA')?.installationFileProblem).toBeUndefined();
  });

  it('hashes no file of a mod whose folder holds no manifest', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
    await statuses.current();

    expect(hashed).toEqual([]);
  });

  describe('the files a package holds, by bytes or by name (publishing.md, What ships, story 2)', () => {
    const PACKAGE = file('S.7z');

    beforeEach(() => {
      hashingContents = true;
      downloads = new Map([['S.7z', { hash: PACKAGE.hash, entries: [{ path: 'copied.json', hash: 'same' }, { path: 'Data/Plugin.esp', hash: 'author' }] }]]);
    });

    it('holds the files of a source mod that its source folder\'s package holds by bytes or by file name, and not the rest, such as an archive the build packed', async () => {
      const mod = await folderOf('ModA', { 'copied.json': 'same', 'plugin.esp': 'built', 'made.dds': 'built', 'Packed - Main.ba2': 'built' });
      await writeManifestIn(mod, EMPTY);
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeManifestIn(source, { ...EMPTY, packages: [PACKAGE] });
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { sourceDirs: new Map([['ModA', source]]) } }));
      await statuses.current();

      expect([...statuses.heldByPackage('ModA')].sort()).toEqual(['copied.json', 'plugin.esp']);
    });

    it('says it changed when only its source folder\'s package arrives, which changes no status', async () => {
      const mod = await folderOf('ModA', { 'copied.json': 'same' });
      await writeManifestIn(mod, EMPTY);
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeManifestIn(source, { ...EMPTY, packages: [PACKAGE] });
      const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { sourceDirs: new Map([['ModA', source]]) } });
      const delivered = downloads;
      downloads = new Map();
      const statuses = statusesLogging();
      statuses.derive(value);
      await statuses.current();
      const heard = vi.fn();
      statuses.onDidChange(heard);

      downloads = delivered;
      statuses.derive(value);
      await statuses.current();

      expect([heard.mock.calls.length, [...statuses.heldByPackage('ModA')]]).toEqual([1, ['copied.json']]);
    });

    it('reads a source mod\'s folder once for its own manifest\'s packages and its source folder\'s', async () => {
      const mod = await folderOf('ModA', { 'copied.json': 'same' });
      await writeManifestIn(mod, EMPTY);
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeManifestIn(source, { ...EMPTY, packages: [PACKAGE] });
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { sourceDirs: new Map([['ModA', source]]) } }));
      await statuses.current();

      expect(asked).toEqual(['ModA']);
    });

    it('holds the files of another mod that its own folder\'s package holds by name, though the bytes differ', async () => {
      const mod = await folderOf('ModA', { 'copied.json': 'edited', 'made.dds': 'built' });
      await writeManifestIn(mod, { ...EMPTY, packages: [PACKAGE] });
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
      await statuses.current();

      expect([...statuses.heldByPackage('ModA')]).toEqual(['copied.json']);
    });

    it('holds nothing of a mod whose package this machine lacks, or that names none', async () => {
      downloads = new Map();
      const [lacking, bare] = [await folderOf('ModA', { 'copied.json': 'same' }), await folderOf('ModB', { 'copied.json': 'same' })];
      await writeManifestIn(lacking, { ...EMPTY, packages: [PACKAGE] });
      await writeManifestIn(bare, EMPTY);
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', lacking), folder('mod', 'ModB', bare)]));
      await statuses.current();

      expect([statuses.heldByPackage('ModA').size, statuses.heldByPackage('ModB').size]).toEqual([0, 0]);
    });
  });

  describe('the files no package holds (publishing.md, What ships, story 2)', () => {
    it('lists every file the reading holds of a mod whose folder holds no manifest, but git\'s own', async () => {
      const mod = await folderOf('ModA');
      const held = ['mine.txt', 'other.txt', '.git/HEAD'].map((relativePath) => ({ relativePath }));
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { filesByMod: new Map([['ModA', held]]) }));

      expect((await statuses.current()).get('ModA')?.unpackaged).toEqual(['mine.txt', 'other.txt']);
    });

    it('lists the files git holds of a folder it holds whole, and of one with a manifest, which no package holds', async () => {
      const [whole, manifested] = [await folderOf('ModA', { 'a.esp': '' }), await folderOf('ModB', { 'b.ini': '' })];
      await writeManifestIn(manifested, EMPTY);
      heldWhole = new Set([whole]);
      heldByGit = new Map([[whole, ['a.esp']], [manifested, ['b.ini']]]);
      const statuses = statusesLogging();

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', whole), folder('mod', 'ModB', manifested)]));
      const derived = await statuses.current();

      expect([derived.get('ModA')?.unpackaged, derived.get('ModB')?.unpackaged]).toEqual([['a.esp'], ['b.ini']]);
    });
  });

  it('reads a folder git holds whole as git\'s, with no manifest to judge it by and no file of it hashed (Status, story 1)', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    await writeManifestIn(mod, { ...EMPTY, files: new Map([['mine.txt', 'AAAAAAAAAAA=']]) });
    const bare = await folderOf('ModB', { 'mine.txt': '' });
    heldWhole = new Set([mod, bare]);
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', mod), folder('mod', 'ModB', bare)]));
    const derived = await statuses.current();

    expect([...derived.values()].map(({ heldWhole: held, noManifest, differing, gone }) => [held, noManifest, differing, gone])).toEqual([
      [true, false, [], []], [true, false, [], []],
    ]);
    expect([asked, hashed]).toEqual([[], []]);
  });


  it('still warns of the installation file the mod manager names for a folder git holds whole (Status, story 7)', async () => {
    const mod = await folderOf('ModA');
    heldWhole = new Set([mod]);
    installationFiles = new Map([['ModA', { kind: 'unreadable', reason: 'this machine does not hold A.7z, the file it is installed from' }]]);
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
    const held = (await statuses.current()).get('ModA');

    expect([held?.heldWhole, held?.installationFileProblem]).toEqual([true, 'this machine does not hold A.7z, the file it is installed from']);
  });

  it('keeps the last good statuses and says in one sentence why when git cannot say what it holds, once in the Output', async () => {
    const [first, second] = [await folderOf('ModA', { 'mine.txt': '' }), await folderOf('ModB', { 'mine.txt': '' })];
    let gitFails = false;
    const statuses = new ModStatuses({
      ...instance, foldersHeldWhole: (folders) => (gitFails ? Promise.reject(new Error('git is gone')) : instance.foldersHeldWhole(folders)),
    }, (line) => { logged.push(line); });
    const value = valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', first), folder('mod', 'ModB', second)]);
    statuses.derive(value);
    await statuses.current();
    gitFails = true;

    statuses.derive(value);
    await statuses.current();
    statuses.derive(value);
    await statuses.current();

    expect([statuses.of('ModA')?.noManifest, statuses.message(), logged]).toEqual([
      true, 'Showing the last good read: git could not say which folders it holds: git is gone.', ['[modList] Git could not say which folders it holds: git is gone'],
    ]);
  });

  it('marks every mod\'s status unreadable with the reason while git cannot say what it holds, and reads clean again once it can', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    let gitFails = true;
    const statuses = new ModStatuses({
      ...instance, foldersHeldWhole: (folders) => (gitFails ? Promise.reject(new Error('git is gone')) : instance.foldersHeldWhole(folders)),
    }, (line) => { logged.push(line); });
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]);

    statuses.derive(value);
    const failing = (await statuses.current()).get('ModA')?.unreadable;
    gitFails = false;
    statuses.derive(value);
    const recovered = (await statuses.current()).get('ModA');

    expect([failing, recovered?.unreadable, recovered?.noManifest, statuses.message()]).toEqual([
      'git could not say which folders it holds: git is gone', undefined, true, undefined,
    ]);
  });

  it.each([
    ['which folders it holds whole', { foldersHeldWhole: () => Promise.reject(new Error('git is gone')) }],
    ['which files it holds', { filesHeldByGit: () => Promise.reject(new Error('git is gone')) }],
  ])('says the statuses could not be read, not a last good read, when git fails at the first derive to say %s', async (_what, failing) => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    const statuses = new ModStatuses({ ...instance, ...failing }, (line) => { logged.push(line); });

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
    await statuses.current();

    expect([statuses.message(), statuses.of('ModA')]).toEqual(['The statuses could not be read: git could not say which folders it holds: git is gone.', undefined]);
  });

  it('derives no status while the instance holds no repository', async () => {
    const mod = await folderOf('ModA');
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { holdsRepository: false }));

    expect([(await statuses.current()).size, asked]).toEqual([0, []]);
  });

  it('derives a value handed after one that held no repository', async () => {
    const mod = await folderOf('ModA');
    const statuses = statusesLogging();
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]);

    statuses.derive({ ...value, holdsRepository: false });
    await statuses.current();
    statuses.derive(value);

    expect([...(await statuses.current()).keys()]).toEqual(['ModA']);
  });

  it('derives a value handed as a derivation ends', async () => {
    const [a, b] = [await folderOf('A'), await folderOf('B')];
    const statuses = statusesLogging();
    const handing = statuses.onDidChange(() => {
      handing.dispose();
      queueMicrotask(() => { statuses.derive(valueOf([{ kind: 'mod', name: 'B' }], [folder('mod', 'B', b)])); });
    });

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', a)]));
    await statuses.current();

    expect([...(await statuses.current()).keys()]).toEqual(['B']);
  });

  it('of the values handed while one derives, derives the latest alone next', async () => {
    const [a, b, c] = [await folderOf('A'), await folderOf('B'), await folderOf('C')];
    const statuses = statusesLogging();

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', a)]));
    statuses.derive(valueOf([{ kind: 'mod', name: 'B' }], [folder('mod', 'B', b)]));
    statuses.derive(valueOf([{ kind: 'mod', name: 'C' }], [folder('mod', 'C', c)]));

    expect([[...(await statuses.current()).keys()], asked]).toEqual([['C'], ['A', 'C']]);
  });

  it('settles once the value current when asked is derived, though values keep arriving', async () => {
    const [a, b] = [await folderOf('A'), await folderOf('B')];
    const statuses = statusesLogging();
    let arrived = 0;
    whileListing = () => {
      if (arrived++ < 3) queueMicrotask(() => { statuses.derive(valueOf([{ kind: 'mod', name: 'B' }], [folder('mod', 'B', b)])); });
    };

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', a)]));
    const settled = [...(await statuses.current()).keys()];
    await vi.waitFor(async () => {
      await statuses.current();
      expect(listings).toBe(4);
    });

    expect(settled).toEqual(['A']);
  });

  it('settles a value handed behind a derivation with the next derivation, which folds what arrived meanwhile', async () => {
    const [a, b, c] = [await folderOf('A'), await folderOf('B'), await folderOf('C')];
    const statuses = statusesLogging();
    let derivations = 0;
    whileListing = () => {
      if (++derivations === 2) queueMicrotask(() => { statuses.derive(valueOf([{ kind: 'mod', name: 'C' }], [folder('mod', 'C', c)])); });
    };

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', a)]));
    statuses.derive(valueOf([{ kind: 'mod', name: 'B' }], [folder('mod', 'B', b)]));
    const settled = [...(await statuses.current()).keys()];
    await vi.waitFor(async () => {
      await statuses.current();
      expect(listings).toBe(3);
    });

    expect(settled).toEqual(['B']);
  });

  it('rejects with why the derivation it waited for failed', async () => {
    const mod = await folderOf('A');
    const statuses = statusesLogging();
    failingInstallationReads = 1;

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', mod)]));

    await expect(statuses.current()).rejects.toThrow('the installation file could not be asked');
  });

  it('derives the value that waited behind a derivation that failed, and settles it', async () => {
    const [a, b] = [await folderOf('A'), await folderOf('B')];
    const statuses = statusesLogging();
    failingInstallationReads = 1;

    statuses.derive(valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', a)]));
    statuses.derive(valueOf([{ kind: 'mod', name: 'B' }], [folder('mod', 'B', b)]));

    expect([...(await statuses.current()).keys()]).toEqual(['B']);
  });

  it('says it changed when a status changes, and not when a value derives the same statuses', async () => {
    const mod = await folderOf('ModA');
    const statuses = statusesLogging();
    const heard = vi.fn();
    statuses.onDidChange(heard);
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]);

    statuses.derive(value);
    await statuses.current();
    statuses.derive(value);
    await statuses.current();
    await writeManifestIn(mod, EMPTY);
    statuses.derive(value);
    await statuses.current();

    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps an unreadable mod\'s last good status shown, names it on the message line once in the Output until it reads, and answers it as read', async () => {
    const mod = await folderOf('ModA');
    const statuses = statusesLogging();
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]);
    statuses.derive(value);
    await statuses.current();

    await writeFile(join(mod, 'ModA.manifest.json'), '<<<<<<< HEAD\n');
    statuses.derive(value);
    const read = (await statuses.current()).get('ModA');
    const whileUnreadable = [statuses.of('ModA')?.noManifest, statuses.message()];
    await writeFile(join(mod, 'ModA.manifest.json'), '<<<<<<< HEAD\n');
    statuses.derive(value);
    await statuses.current();
    await writeManifestIn(mod, EMPTY);
    statuses.derive(value);
    await statuses.current();

    const WHY = 'its manifest is not valid JSON at line 1: Unexpected token \'<\', "<<<<<<< HEAD\n" is not valid JSON';
    expect([read?.unreadable, ...whileUnreadable, statuses.message(), statuses.of('ModA')?.noManifest, logged]).toEqual([
      WHY, true, `Showing the last good read: the status of "ModA" could not be read: ${WHY}.`,
      undefined, false, [`[modList] The status of "ModA" could not be read: ${WHY}`],
    ]);
  });
});

describe('a plugin its manifest flags (Status, story 8)', () => {
  const PACKAGE = file('S.7z');
  const FLAGS = { Small: true };
  const COPY = 'AAAAAAAAAAA=';
  const OTHER = 'BBBBBBBBBBA=';

  beforeEach(() => {
    hashingContents = true;
    downloads = new Map([['S.7z', { hash: PACKAGE.hash, entries: [{ path: 'Mod.esp', hash: COPY }] }]]);
  });

  async function statusWith(possible: PossibleHashes): Promise<ModStatus | undefined> {
    const mod = await folderOf('ModA', { 'Mod.esp': 'flagged bytes' });
    await writeManifestIn(mod, { ...EMPTY, packages: [PACKAGE], flags: new Map([['Mod.esp', FLAGS]]), files: new Map([['Mod.esp', COPY]]) });
    const statuses = new ModStatuses(instance, (line) => { logged.push(line); }, possible);
    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
    return (await statuses.current()).get('ModA');
  }

  const answering = (hashes: string[]): PossibleHashes => (files) => Promise.resolve(files.map(({ path }) => ({ path, hashes })));

  it('holds its bytes when mEdit says it could have held the manifest\'s hash before its flags, as the file mEdit was asked about', async () => {
    const asked: Parameters<PossibleHashes>[0][] = [];

    const status = await statusWith((files) => { asked.push(files); return answering([OTHER, COPY])(files); });

    expect([status?.differing, status?.unreadable, asked]).toEqual([[], undefined, [[{ path: join(root, 'mods', 'ModA', 'Mod.esp'), flags: FLAGS }]]]);
  });

  it('differs when mEdit says it could not have held the manifest\'s hash', async () => {
    expect((await statusWith(answering([OTHER])))?.differing).toEqual(['Mod.esp']);
  });

  it('is unreadable, saying why, and never differing, when mEdit cannot say', async () => {
    const status = await statusWith(() => Promise.resolve(localFailure('mEdit is not running')));

    expect([status?.differing, status?.unreadable]).toEqual([[], expect.stringContaining('mEdit is not running') as string]);
  });
});
