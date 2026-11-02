import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EntryRef, InstanceAdapter, ModFolder } from '../../instanceAdapter/instanceAdapter';
import { modValueOver } from '../../instanceAdapter/modValue';
import type { Manifest } from '../../manifestAdapter/manifestAdapter';
import { writeManifestIn } from '../../manifestAdapter/manifestAdapter';
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
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reads: Parameters<typeof modValueOver>[0] = {
  filesIn: async (folder) => (await readdir(folder).catch(() => [])).filter((name) => !name.endsWith('.manifest.json')),
  fileStamp: () => Promise.resolve({ kind: 'unreadable', reason: 'ENOENT' }),
  originFileHash: (path) => {
    hashed.push(path);
    return Promise.resolve({ kind: 'unreadable', reason: 'unhashed' });
  },
  exclusionMark: '.mohidden',
  downloadedFile: () => Promise.resolve({ kind: 'read', answer: undefined }),
  gamePlaces: () => Promise.resolve([]),
  flaggedHash: () => Promise.resolve(undefined),
  gameFilesTakenBy: () => Promise.resolve({ kind: 'read', answer: { gameFiles: [], notes: [] } }),
  submodule: () => Promise.resolve({ lacks: 'no submodule' }),
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
  ({ holdsRepository: true, mods, modFolders, entryKey: ({ name }) => name.toLowerCase(), ...over });

let installationFiles: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['installationFile']>>>;

const instance: Pick<InstanceAdapter, 'modValue' | 'installationFile'> = {
  installationFile: (mod) => Promise.resolve(installationFiles.get(mod) ?? { kind: 'read', answer: undefined }),
  modValue: (folder, wanted) => {
    asked.push(basename(folder));
    return modValueOver(reads, folder, wanted);
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
