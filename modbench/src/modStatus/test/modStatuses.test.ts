import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryRef, ModFolder } from '../../instanceAdapter/instanceAdapter';
import type { FolderReads, Manifest } from '../../manifestAdapter/manifestAdapter';
import { writeManifestIn } from '../../manifestAdapter/manifestAdapter';
import { ModStatuses, type StatusSource } from '../modStatuses';

let root: string;
let logged: string[];
let asked: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-mod-statuses-'));
  logged = [];
  asked = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reads: FolderReads = {
  filesIn: async (folder) => (await readdir(folder).catch(() => [])).filter((name) => !name.endsWith('.manifest.json')),
  fileStamp: () => Promise.resolve({ kind: 'unreadable', reason: 'ENOENT' }),
  originFileHash: () => Promise.resolve({ kind: 'unreadable', reason: 'unhashed' }),
  packageEntries: () => Promise.resolve(undefined),
  modMetadata: (mod) => {
    asked.push(mod);
    return Promise.resolve({ kind: 'read', answer: {} });
  },
};

const EMPTY: Manifest = { packages: [], exclude: [], archives: [], steps: [], tools: [], files: [] };

async function folderOf(name: string, files: Record<string, string> = {}): Promise<string> {
  const folder = join(root, 'mods', name);
  await mkdir(folder, { recursive: true });
  await Promise.all(Object.entries(files).map(([file, text]) => writeFile(join(folder, file), text)));
  return folder;
}

const folder = (kind: EntryRef['kind'], name: string, path: string, modName = name): ModFolder => ({ kind, name, path, modName });

const valueOf = (mods: EntryRef[], modFolders: ModFolder[], over: Partial<StatusSource> = {}): StatusSource =>
  ({ holdsRepository: true, mods, modFolders, entryKey: ({ name }) => name.toLowerCase(), paths: { sourceDirs: new Map() }, ...over });

const statusesLogging = (): ModStatuses => new ModStatuses(reads, (line) => { logged.push(line); });

describe('Mod status, derived from each instance value (mod-status trace)', () => {
  it('derives each listed mod\'s and separator\'s status by its folder\'s mod name, a source mod\'s from its repository, and none for an entry with no folder', async () => {
    const mod = await folderOf('ModA', { 'mine.txt': '' });
    await writeManifestIn(mod, EMPTY);
    const separator = await folderOf('Tools_separator');
    const built = await folderOf('Built');
    const source = join(root, 'source', 'Built');
    await mkdir(source, { recursive: true });
    await writeManifestIn(source, { ...EMPTY, output: 'Built' });
    const statuses = statusesLogging();

    statuses.derive(valueOf(
      [{ kind: 'mod', name: 'MODA' }, { kind: 'separator', name: 'Tools' }, { kind: 'mod', name: 'Built' }, { kind: 'mod', name: 'Folderless' }],
      [folder('mod', 'ModA', mod), folder('separator', 'Tools', separator, 'Tools_separator'), folder('mod', 'Built', built)],
      { paths: { sourceDirs: new Map([['Built', source]]) } },
    ));
    const derived = await statuses.current();

    expect([...derived.keys()]).toEqual(['ModA', 'Tools_separator', 'Built']);
    expect([derived.get('ModA')?.namedByNoLine, derived.get('Tools_separator')?.noManifest, derived.get('Built')?.noManifest]).toEqual([['mine.txt'], true, false]);
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
    await writeFile(join(mod, 'ModA.manifest.json'), '<<<<<<< HEAD\n\n');
    statuses.derive(value);
    await statuses.current();
    await writeManifestIn(mod, EMPTY);
    statuses.derive(value);
    await statuses.current();

    expect([read?.unreadable, ...whileUnreadable, statuses.message(), statuses.of('ModA')?.noManifest, logged]).toEqual([
      'its manifest cannot be read at line 1', true, 'Showing the last good read: the status of "ModA" could not be read: its manifest cannot be read at line 1.',
      undefined, false, ['The status of "ModA" could not be read: its manifest cannot be read at line 1'],
    ]);
  });
});
