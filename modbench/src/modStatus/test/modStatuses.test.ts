import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EntryRef, FileRead, InstanceAdapter, ModFolder } from '../../instanceAdapter/instanceAdapter';
import { modValueOver } from '../../instanceAdapter/modValue';
import type { FlaggedRead, Manifest, ManifestPackage, ModStatus } from '../../manifestAdapter/manifestAdapter';
import { writeManifestIn } from '../../manifestAdapter/manifestAdapter';
import { buildFileOf, writeBuildFile } from '../../test/buildFiles';
import type { ArchiveEntries } from '../archiveEntries';
import { ModStatuses, statusReadsFile, type HashEntries, type StatusSource } from '../modStatuses';

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
  entryHashes = new Map();
  hashedEntries = [];
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
  gamePlace: () => Promise.resolve(undefined),
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
  ({
    holdsRepository: true, flaggedHashes: new Map(), mods, modFolders, entryKey: ({ name }) => name.toLowerCase(), paths: { sourceDirs: new Map(), downloadsDir: '/downloads' },
    filesByMod: new Map(), archiveContents: new Map(), gameName: 'Fallout4', gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' }, ...over,
  });

let heldWhole: ReadonlySet<string>;
let heldByGit: ReadonlyMap<string, readonly string[]>;
let listings: number;
let whileListing: () => void;
let failingInstallationReads: number;
let hashingContents: boolean;
let entryHashes: ReadonlyMap<string, FileRead<string>>;
let hashedEntries: string[];
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

const hashEntries: HashEntries = (_gameName, archive, entries) => {
  hashedEntries.push(...entries);
  return Promise.resolve(entries.map((entry) => entryHashes.get(`${basename(archive)}/${entry}`) ?? { kind: 'unreadable', reason: `${entry} is not in ${basename(archive)}` }));
};

const statusesLogging = (): ModStatuses => new ModStatuses(instance, (line) => { logged.push(line); }, hashEntries);

describe('Mod status (mod-status trace)', () => {
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
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) } });
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

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) } }));
      await statuses.current();

      expect([...statuses.heldByPackage('ModA')].sort()).toEqual(['copied.json', 'plugin.esp']);
    });

    it('says it changed when only its source folder\'s package arrives, which changes no status', async () => {
      const mod = await folderOf('ModA', { 'copied.json': 'same' });
      await writeManifestIn(mod, EMPTY);
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeManifestIn(source, { ...EMPTY, packages: [PACKAGE] });
      const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) } });
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

      statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) } }));
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

    describe('the entries of an archive no package holds, by bytes or by name', () => {
      const ARCHIVE = 'Packed - Main.ba2';

      const statusesOf = async (entries: ArchiveEntries, packages: readonly ManifestPackage[] = [PACKAGE]) => {
        const mod = await folderOf('ModA', { [ARCHIVE]: 'built' });
        await writeManifestIn(mod, EMPTY);
        const source = join(root, 'source', 'ModA');
        await mkdir(source, { recursive: true });
        await writeManifestIn(source, { ...EMPTY, packages: [...packages] });
        const sourcePath = join(mod, ARCHIVE);
        const statuses = statusesLogging();
        statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], {
          paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) },
          filesByMod: new Map([['ModA', [{ relativePath: ARCHIVE, sourcePath }]]]),
          archiveContents: new Map([[sourcePath, entries]]),
        }));
        await statuses.current();
        return statuses;
      };

      const entriesOf = async (entries: ArchiveEntries, packages?: readonly ManifestPackage[]) =>
        (await statusesOf(entries, packages)).entriesNoPackageHolds('ModA').get(ARCHIVE);

      it('holds no entry of an archive whose every entry a package holds by file name, and hashes none', async () => {
        expect(await entriesOf({ kind: 'read', answer: ['textures/COPIED.json', 'meshes/plugin.esp'] })).toEqual({ kind: 'read', answer: [] });
        expect(hashedEntries).toEqual([]);
      });

      it('hashes only the entries no package holds by name, and holds one a package holds by bytes under another name', async () => {
        entryHashes = new Map([['Packed - Main.ba2/textures/renamed.json', { kind: 'read', answer: 'same' }]]);

        expect(await entriesOf({ kind: 'read', answer: ['textures/copied.json', 'textures/renamed.json'] })).toEqual({ kind: 'read', answer: [] });
        expect(hashedEntries).toEqual(['textures/renamed.json']);
      });

      it('names each entry no package holds', async () => {
        entryHashes = new Map([['Packed - Main.ba2/textures/made.dds', { kind: 'read', answer: 'built' }]]);

        expect(await entriesOf({ kind: 'read', answer: ['textures/copied.json', 'textures/made.dds'] })).toEqual({ kind: 'read', answer: ['textures/made.dds'] });
      });

      it('says why when the archive cannot be read', async () => {
        expect(await entriesOf({ kind: 'unreadable', reason: 'not a BA2' })).toEqual({ kind: 'unreadable', reason: 'not a BA2' });
      });

      it('holds the last good status, and names no entry, while mEdit has not said what an archive holds', async () => {
        const statuses = await statusesOf({ kind: 'unanswered' });

        expect([statuses.entriesNoPackageHolds('ModA').size, (await statuses.current()).get('ModA')?.unreadable])
          .toEqual([0, `mEdit has not said what '${ARCHIVE}' holds`]);
      });

      it('keeps its status while mEdit has not said what an archive holds, when no package holds a file to judge its entries by', async () => {
        const statuses = await statusesOf({ kind: 'unanswered' }, []);

        expect((await statuses.current()).get('ModA')?.unreadable).toBeUndefined();
      });

      it('hashes nothing while no package holds a file, since none can hold an entry', async () => {
        expect(await entriesOf({ kind: 'read', answer: ['textures/a.dds'] }, [])).toEqual({ kind: 'read', answer: ['textures/a.dds'] });
        expect(hashedEntries).toEqual([]);
      });

      it('says why when an entry cannot be hashed', async () => {
        expect(await entriesOf({ kind: 'read', answer: ['textures/made.dds'] })).toEqual({ kind: 'unreadable', reason: 'textures/made.dds is not in Packed - Main.ba2' });
      });
    });

    describe('the installation file the mod manager names', () => {
      const installedWith = (entries: { path: string; hash: string }[]): Awaited<ReturnType<InstanceAdapter['installationFile']>> =>
        ({ kind: 'read', answer: { path: join('downloads', 'D.7z'), size: 1, hash: PACKAGE.hash, entries } });

      const heldAfter = async (): Promise<{ held: string[]; sourceFolder: string[] }> => {
        const mod = await folderOf('ModA', { 'plugin.esp': 'built' });
        await writeManifestIn(mod, EMPTY);
        const source = join(root, 'source', 'ModA');
        await mkdir(source, { recursive: true });
        await writeManifestIn(source, EMPTY);
        const statuses = statusesLogging();
        statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], { paths: { downloadsDir: '/downloads', sourceDirs: new Map([['ModA', source]]) } }));
        await statuses.current();
        return { held: [...statuses.heldByPackage('ModA')], sourceFolder: await readdir(source) };
      };

      it('holds a file it holds by file name, and writes no package for it into the manifest', async () => {
        installationFiles = new Map([['ModA', installedWith([{ path: 'Data/Plugin.esp', hash: 'author' }])]]);

        expect(await heldAfter()).toEqual({ held: ['plugin.esp'], sourceFolder: ['ModA.manifest.json'] });
      });

      it.each([
        ['unreadable', { kind: 'unreadable', reason: 'EACCES' } as const],
        ['named by no one', { kind: 'read', answer: undefined } as const],
      ])('holds nothing while it is %s', async (_case, installation) => {
        installationFiles = new Map([['ModA', installation]]);

        expect((await heldAfter()).held).toEqual([]);
      });
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
      const held = ['mine.txt', 'other.txt', '.git/HEAD'].map((relativePath) => ({ relativePath, sourcePath: relativePath }));
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

    it('leaves a mod\'s own manifest out of the files git holds, whole folder or not', async () => {
      const [whole, manifested] = [await folderOf('ModA', { 'a.esp': '' }), await folderOf('ModB', { 'b.ini': '' })];
      await writeManifestIn(manifested, EMPTY);
      heldWhole = new Set([whole]);
      heldByGit = new Map([[whole, ['a.esp', 'ModA.manifest.json']], [manifested, ['b.ini', 'ModB.manifest.json']]]);
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
    }, (line) => { logged.push(line); }, hashEntries);
    const value = valueOf([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], [folder('mod', 'ModA', first), folder('mod', 'ModB', second)]);
    statuses.derive(value);
    await statuses.current();
    gitFails = true;

    statuses.derive(value);
    await statuses.current();
    statuses.derive(value);
    await statuses.current();

    expect([statuses.of('ModA')?.noManifest, statuses.lastGoodReasons(), logged]).toEqual([
      true, ['git could not say which folders it holds: git is gone.'], ['[modList] Git could not say which folders it holds: git is gone'],
    ]);
  });

  it('marks every mod\'s status unreadable with the reason while git cannot say what it holds, and reads clean again once it can', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    let gitFails = true;
    const statuses = new ModStatuses({
      ...instance, foldersHeldWhole: (folders) => (gitFails ? Promise.reject(new Error('git is gone')) : instance.foldersHeldWhole(folders)),
    }, (line) => { logged.push(line); }, hashEntries);
    const value = valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]);

    statuses.derive(value);
    const failing = (await statuses.current()).get('ModA')?.unreadable;
    gitFails = false;
    statuses.derive(value);
    const recovered = (await statuses.current()).get('ModA');

    expect([failing, recovered?.unreadable, recovered?.noManifest, statuses.lastGoodReasons()]).toEqual([
      'git could not say which folders it holds: git is gone', undefined, true, [],
    ]);
  });

  it.each([
    ['which folders it holds whole', { foldersHeldWhole: () => Promise.reject(new Error('git is gone')) }],
    ['which files it holds', { filesHeldByGit: () => Promise.reject(new Error('git is gone')) }],
  ])('says the statuses could not be read, not a last good read, when git fails at the first derive to say %s', async (_what, failing) => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    const statuses = new ModStatuses({ ...instance, ...failing }, (line) => { logged.push(line); }, hashEntries);

    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)]));
    await statuses.current();

    expect([statuses.unreadMessage(), statuses.of('ModA')]).toEqual(['The statuses could not be read: git could not say which folders it holds: git is gone.', undefined]);
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

  it.each([
    ['a file of a mod\'s folder', '/instance/mods/A/a.dds', true],
    ['a file of its source folder', '/instance/source/A/plugin-source/A.esp/records.yaml', true],
    ['an installation file', '/downloads/A.7z', true],
    ['a game file', '/game/Data/Fallout4.esm', true],
    ['the repository git answers from', '/instance/.git', true],
    ['the plugin order', '/instance/profiles/Default/plugins.txt', false],
    ['a file of a folder whose name a mod\'s folder\'s begins', '/instance/mods/AB/a.dds', false],
  ])('reads %s: %s, %s', (_what, path, read) => {
    const value = valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', '/instance/mods/A')], { paths: { sourceDirs: new Map([['A', '/instance/source/A']]), downloadsDir: '/downloads' } });

    expect(statusReadsFile(path, value)).toBe(read);
  });

  it('on Windows, reads a file of a mod\'s folder the watcher names in another case and with the other separator', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const value = valueOf([{ kind: 'mod', name: 'A' }], [folder('mod', 'A', 'C:/Instance/mods/A')]);

      expect(statusReadsFile('c:\\instance\\MODS\\A\\a.dds', value)).toBe(true);
    } finally {
      if (real !== undefined) Object.defineProperty(process, 'platform', real);
    }
  });

  describe('derives again only the mods a change touches', () => {
    it.each<{ change: string; changed: (value: StatusSource, b: string) => [StatusSource, { named: string[]; disk: boolean }]; derived: string[] }>([
      { change: 'a change that names a file of one mod', changed: (value, b) => [value, { named: [join(b, 'b.dds')], disk: false }], derived: ['B'] },
      {
        change: 'one mod\'s own files listed anew', derived: ['B'],
        changed: (value, b) => [{ ...value, filesByMod: new Map([['A', value.filesByMod.get('A') ?? []], ['B', [{ relativePath: 'c.dds', sourcePath: join(b, 'c.dds') }]]]) }, { named: [join(b, 'c.dds')], disk: false }],
      },
      {
        change: 'what an archive of one mod holds', derived: ['B'],
        changed: (value, b) => [{ ...value, archiveContents: new Map([[join(b, 'B.ba2'), { kind: 'unanswered' }]]) }, { named: [], disk: false }],
      },
      {
        change: 'what an archive a link puts outside its mod\'s folder holds', derived: ['B'],
        changed: (value) => [{ ...value, archiveContents: new Map([['/elsewhere/B.ba2', { kind: 'unanswered' }]]) }, { named: [], disk: false }],
      },
      {
        change: 'what an archive in no one mod\'s folders holds', derived: ['A', 'B'],
        changed: (value) => [{ ...value, archiveContents: new Map([['/elsewhere/X.ba2', { kind: 'unanswered' }]]) }, { named: [], disk: false }],
      },
      { change: 'a change to a fact of every mod', changed: (value) => [{ ...value, gameName: 'Skyrim' }, { named: [], disk: false }], derived: ['A', 'B'] },
      { change: 'a check of the disk', changed: (value) => [value, { named: [], disk: true }], derived: ['A', 'B'] },
      { change: 'a change that names a file of no one mod, as an installation file is', changed: (value) => [value, { named: ['/downloads/A.7z'], disk: false }], derived: ['A', 'B'] },
    ])('$change: $derived', async ({ changed, derived }) => {
      const [a, b] = [await folderOf('A'), await folderOf('B')];
      const statuses = statusesLogging();
      const value = valueOf([{ kind: 'mod', name: 'A' }, { kind: 'mod', name: 'B' }], [folder('mod', 'A', a), folder('mod', 'B', b)], {
        filesByMod: new Map([
          ['A', [{ relativePath: 'a.dds', sourcePath: join(a, 'a.dds') }]],
          ['B', [{ relativePath: 'b.dds', sourcePath: join(b, 'b.dds') }, { relativePath: 'B.ba2', sourcePath: '/elsewhere/B.ba2' }]],
        ]),
      });
      statuses.derive(value);
      await statuses.current();
      asked.length = 0;

      statuses.derive(...changed(value, b));
      const keys = [...(await statuses.current()).keys()];

      expect([[...asked].sort(), keys]).toEqual([derived, ['A', 'B']]);
    });

    it('reads the files of the mod a change names alone, whatever the size of the modlist', async () => {
      const [a, b] = [await folderOf('A'), await folderOf('B')];
      const read: string[] = [];
      class Reading<V> extends Map<string, V> {
        override get(mod: string): V | undefined {
          read.push(mod);
          return super.get(mod);
        }
      }
      const filesByMod = new Reading([['A', [{ relativePath: 'a.dds', sourcePath: join(a, 'a.dds') }]], ['B', [{ relativePath: 'b.dds', sourcePath: join(b, 'b.dds') }]]]);
      const statuses = statusesLogging();
      const value = valueOf([{ kind: 'mod', name: 'A' }, { kind: 'mod', name: 'B' }], [folder('mod', 'A', a), folder('mod', 'B', b)], { filesByMod });
      statuses.derive(value);
      await statuses.current();
      read.length = 0;

      statuses.derive(value, { named: [join(b, 'b.dds')], disk: false });
      await statuses.current();

      expect([...new Set(read)]).toEqual(['B']);
    });

    it('places a change against the mods\' folders at one cost on a small and a large modlist', async () => {
      const placings = async (count: number): Promise<number> => {
        let placed = 0;
        const names = Array.from({ length: count }, (_, n) => `M${n}`);
        const folders = await Promise.all(names.map((name) => folderOf(name)));
        const counted = names.map((name, n): ModFolder => {
          const { path, ...rest } = folder('mod', name, folders[n] ?? '');
          return { ...rest, get path() { placed++; return path; } };
        });
        const value = valueOf(names.map((name) => ({ kind: 'mod', name })), counted, { entryKey: ({ name }) => { placed++; return name.toLowerCase(); } });
        const statuses = statusesLogging();
        statuses.derive(value);
        await statuses.current();
        placed = 0;

        statuses.derive({ ...value }, { named: [join(folders[0] ?? '', 'a.dds'), '/instance/profiles/Default/plugins.txt'], disk: false });
        await statuses.current();
        return placed;
      };

      expect(await placings(60)).toBe(await placings(3));
    });

    it('derives every mod after a derivation that failed', async () => {
      const [a, b] = [await folderOf('A'), await folderOf('B')];
      const statuses = statusesLogging();
      const value = valueOf([{ kind: 'mod', name: 'A' }, { kind: 'mod', name: 'B' }], [folder('mod', 'A', a), folder('mod', 'B', b)]);
      failingInstallationReads = 1;
      statuses.derive(value);
      await statuses.current().catch(() => undefined);

      statuses.derive(value, { named: [join(b, 'b.dds')], disk: false });

      expect([...(await statuses.current()).keys()]).toEqual(['A', 'B']);
    });

    it('derives every mod after git could not say what it holds', async () => {
      const [a, b] = [await folderOf('A'), await folderOf('B')];
      let gitFails = true;
      const statuses = new ModStatuses({
        ...instance, foldersHeldWhole: (folders) => (gitFails ? Promise.reject(new Error('git is gone')) : instance.foldersHeldWhole(folders)),
      }, (line) => { logged.push(line); }, hashEntries);
      const value = valueOf([{ kind: 'mod', name: 'A' }, { kind: 'mod', name: 'B' }], [folder('mod', 'A', a), folder('mod', 'B', b)]);
      statuses.derive(value);
      await statuses.current();
      gitFails = false;

      statuses.derive(value, { named: [join(b, 'b.dds')], disk: false });

      expect([...(await statuses.current()).values()].map(({ unreadable }) => unreadable)).toEqual([undefined, undefined]);
    });
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
    const whileUnreadable = [statuses.of('ModA')?.noManifest, statuses.lastGoodReasons()];
    await writeFile(join(mod, 'ModA.manifest.json'), '<<<<<<< HEAD\n');
    statuses.derive(value);
    await statuses.current();
    await writeManifestIn(mod, EMPTY);
    statuses.derive(value);
    await statuses.current();

    const WHY = 'its manifest is not valid JSON at line 1: Unexpected token \'<\', "<<<<<<< HEAD\n" is not valid JSON';
    expect([read?.unreadable, ...whileUnreadable, statuses.lastGoodReasons(), statuses.of('ModA')?.noManifest, logged]).toEqual([
      WHY, true, [`the status of "ModA" could not be read: ${WHY}.`],
      [], false, [`[modList] The status of "ModA" could not be read: ${WHY}`],
    ]);
  });
});

describe('a plugin its manifest flags (Status, story 8)', () => {
  const PACKAGE = file('S.7z');
  const FLAGS = { Small: true };
  const COPY = 'AAAAAAAAAAA=';
  const OTHER = 'BBBBBBBBBBA=';
  const LINKED = '/where/it/is/read/Mod.esp';

  beforeEach(() => {
    hashingContents = true;
    downloads = new Map([['S.7z', { hash: PACKAGE.hash, entries: [{ path: 'Mod.esp', hash: COPY }] }]]);
  });

  async function statusWith(flagged: () => FlaggedRead): Promise<ModStatus | undefined> {
    const mod = await folderOf('ModA', { 'Mod.esp': 'flagged bytes' });
    await writeManifestIn(mod, { ...EMPTY, packages: [PACKAGE], flags: new Map([['Mod.esp', FLAGS]]), files: new Map([['Mod.esp', COPY]]) });
    const statuses = statusesLogging();
    statuses.derive(valueOf([{ kind: 'mod', name: 'ModA' }], [folder('mod', 'ModA', mod)], {
      filesByMod: new Map([['ModA', [{ relativePath: 'Mod.esp', sourcePath: LINKED }]]]), flaggedHashes: new Map([[LINKED, flagged()]]),
    }));
    return (await statuses.current()).get('ModA');
  }

  it('holds its bytes when mEdit says it could have held the manifest\'s hash before its flags', async () => {
    const status = await statusWith(() => ({ kind: 'read', answer: [OTHER, COPY] }));

    expect([status?.differing, status?.unreadable]).toEqual([[], undefined]);
  });

  it('differs when mEdit says it could not have held the manifest\'s hash', async () => {
    expect((await statusWith(() => ({ kind: 'read', answer: [OTHER] })))?.differing).toEqual(['Mod.esp']);
  });

  it.each([
    ['mEdit has not answered', { kind: 'unanswered' as const }, 'has not said'],
    ['mEdit could not read the file', { kind: 'unreadable' as const, reason: 'EACCES' }, 'EACCES'],
  ])('is unreadable, saying why, and never differing, while %s', async (_what, read, why) => {
    const status = await statusWith(() => read);

    expect([status?.differing, status?.unreadable?.includes(why)]).toEqual([[], true]);
  });
});
