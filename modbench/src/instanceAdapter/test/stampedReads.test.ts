import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { managerOver } from '../../test/mo2/adapterOver';
import { listDir, listDirByStamp, parsedBy, readTrustingKept } from '../files';
import { sortingRuleFilePaths } from '../mo2/layout';
import { CHECK_THE_DISK, type InstanceReading } from '../instanceAdapter';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

const forgetWhatEarlierTestsKeptOfFoldersNowGone = (): Promise<unknown> => readTrustingKept([], true, () => Promise.resolve());

const HOUR_MS = 3_600_000;
const listingsOf = (folder: string): number => vi.mocked(readdir).mock.calls.filter(([path]) => path === folder).length;
let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};
const namesOf = async (folder: string, list = listDirByStamp): Promise<string[]> => (await list(folder)).map((entry) => entry.name).sort();

describe('a folder listed and a file parsed by their stamps', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-stamped-'));
    await forgetWhatEarlierTestsKeptOfFoldersNowGone();
    vi.mocked(readdir).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };

  it('lists a folder every time when a writer lists it, so a temp folder is never kept', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root, listDir);
    await namesOf(root, listDir);
    expect(listingsOf(root)).toBe(2);
  });

  it('trusts within a re-read each folder it keeps without its stamp, and lists again the folder of a path the re-read is named', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root);
    await writeFile(join(root, 'b.esp'), '');
    await modifiedLater(root);
    vi.mocked(readdir).mockClear();

    const unnamed = await readTrustingKept([], false, () => namesOf(root));
    const named = await readTrustingKept([join(root, 'b.esp')], false, () => namesOf(root));

    expect(unnamed).toEqual({ answer: ['a.esp'], unheard: [] });
    expect(named).toEqual({ answer: ['a.esp', 'b.esp'], unheard: [] });
    expect(listingsOf(root)).toBe(1);
  });

  it.runIf(process.platform === 'win32')('lists again within a re-read the folder of a path named in another case, as VS Code\'s watcher spells a drive', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root);
    await writeFile(join(root, 'b.esp'), '');
    await modifiedLater(root);
    const spelledByTheWatcher = join(root, 'b.esp').toLowerCase();

    const { answer } = await readTrustingKept([spelledByTheWatcher], false, () => namesOf(root));

    expect(answer).toEqual(['a.esp', 'b.esp']);
  });

  it('parses again within a re-read a file the re-read is named', async () => {
    const path = join(root, 'meta.ini');
    await writeFile(path, 'one');
    settle();
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await writeFile(path, 'three');
    await modifiedLater(path);

    expect((await readTrustingKept([], false, () => textAt(path))).answer).toBe('one');
    expect((await readTrustingKept([path], false, () => textAt(path))).answer).toBe('three');
  });

  it('lists again within a re-read each folder kept below a folder the re-read is named', async () => {
    const below = join(root, 'Mod', 'textures');
    await mkdir(below, { recursive: true });
    settle();
    await namesOf(below);
    await writeFile(join(below, 'a.dds'), '');
    await modifiedLater(below);
    await namesOf(join(root, 'Mod'));

    const { answer } = await readTrustingKept([join(root, 'Mod')], false, () => namesOf(below));

    expect(answer).toEqual(['a.dds']);
  });

  it('lists again within a re-read each folder kept below a folder the re-read is named that it listed too recently to trust', async () => {
    const below = join(root, 'Mod', 'textures');
    await mkdir(below, { recursive: true });
    settle();
    await namesOf(below);
    await writeFile(join(below, 'a.dds'), '');
    await modifiedLater(below);
    vi.useRealTimers();
    await namesOf(join(root, 'Mod'));

    const { answer } = await readTrustingKept([join(root, 'Mod')], false, () => namesOf(below));

    expect(answer).toEqual(['a.dds']);
  });

  it('checks the disk by every stamp it keeps, answering each change as unheard but those of the paths it is named', async () => {
    const [heard, unheard] = [join(root, 'heard'), join(root, 'unheard')];
    await mkdir(heard);
    await mkdir(unheard);
    settle();
    await namesOf(heard);
    await namesOf(unheard);
    await writeFile(join(heard, 'new.esp'), '');
    await modifiedLater(heard);
    await writeFile(join(unheard, 'new.esp'), '');
    await modifiedLater(unheard);

    const checked = await readTrustingKept([join(heard, 'new.esp')], true, async () => [await namesOf(heard), await namesOf(unheard)]);

    expect(checked).toEqual({ answer: [['new.esp'], ['new.esp']], unheard: [unheard] });
  });

  it('answers as unheard a change to a file it last read too soon after a write to trust', async () => {
    const path = join(root, 'modlist.txt');
    await writeFile(path, '+A');
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await writeFile(path, '+B');
    await modifiedLater(path);

    expect(await readTrustingKept([], true, () => textAt(path))).toEqual({ answer: '+B', unheard: [path] });
  });

  it('forgets at a check of the disk, as a change no event named, a folder it kept that is gone', async () => {
    const gone = join(root, 'gone');
    await mkdir(gone);
    settle();
    await namesOf(gone);
    await rm(gone, { recursive: true });

    const { unheard } = await readTrustingKept([], true, () => Promise.resolve());

    expect(unheard).toEqual([gone]);
    await expect(readTrustingKept([], false, () => namesOf(gone))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the listing a read outside it made while a re-read was checking that folder\'s stamp', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root);
    await writeFile(join(root, 'b.esp'), '');
    await modifiedLater(root);
    let releaseTheCheck!: () => void;
    const checkHeld = new Promise<void>((resolve) => { releaseTheCheck = resolve; });
    vi.mocked(stat).mockImplementationOnce(async (...args) => { await checkHeld; return stat(...args); });

    const rereading = readTrustingKept([join(root, 'b.esp')], false, () => Promise.resolve());
    const outside = await namesOf(root);
    releaseTheCheck();
    await rereading;
    vi.mocked(readdir).mockClear();
    const { answer } = await readTrustingKept([], false, () => namesOf(root));

    expect([outside, answer, listingsOf(root)]).toEqual([['a.esp', 'b.esp'], ['a.esp', 'b.esp'], 0]);
  });

  it('rejects for a file that is gone, as a read of it does', async () => {
    const path = join(root, 'meta.ini');
    await writeFile(path, 'one');
    settle();
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await rm(path);
    await expect(textAt(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the MO2 reading of an instance nothing changed in', () => {
  let instance: string;

  beforeEach(() => {
    instance = cloneCorpusFixture();
    vi.mocked(readdir).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(instance, { recursive: true, force: true });
  });

  it('lists no mod folder again, and still shows a file added to one', async () => {
    const adapter = managerOver(instance);
    const first = await adapter.reading();
    const [name, files] = [...first.modFiles].find(([, listed]) => listed.files.length > 0) ?? ['', undefined];
    const folder = files?.folder ?? '';
    expect(name).not.toBe('');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading();
    vi.mocked(readdir).mockClear();
    await adapter.reading();
    expect(listingsOf(folder)).toBe(0);

    await mkdir(join(folder, 'added'), { recursive: true });
    await writeFile(join(folder, 'added', 'new.txt'), '');
    await modifiedLater(folder);
    const after = await adapter.reading();
    expect(after.modFiles.get(name)?.files.map((file) => file.relativePath)).toContain('added/new.txt');
  });

  it('has a read that a listener starts, called as the instance read follows a new mod folder, check each stamp', async () => {
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading();
    const folder = [...first.modFiles.values()].find((listed) => listed.files.length > 0)?.folder ?? '';
    await writeFile(join(folder, 'added.txt'), '');
    await modifiedLater(folder);
    const startedByTheListener: Promise<string[]>[] = [];
    adapter.subscribe(() => { startedByTheListener.push(namesOf(folder)); });
    await mkdir(join(instance, 'mods', 'New Mod'));

    await adapter.reading({ named: [], disk: false });

    expect(await Promise.all(startedByTheListener)).toEqual([await namesOf(folder, listDir)]);
    expect(await namesOf(folder, listDir)).toContain('added.txt');
  });

  it('shows a file added to a mod folder when a re-read is named it or the disk is checked, and tells the check found it unheard', async () => {
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading();
    const [name, files] = [...first.modFiles].find(([, listed]) => listed.files.length > 0) ?? ['', undefined];
    const folder = files?.folder ?? '';
    const added = join(folder, 'added.txt');
    await writeFile(added, '');
    await modifiedLater(folder);
    const filesOf = (reading: Pick<InstanceReading, 'modFiles'>): string[] | undefined => reading.modFiles.get(name)?.files.map((file) => file.relativePath);

    const unnamed = await adapter.reading({ named: [], disk: false });
    const checked = await adapter.reading(CHECK_THE_DISK);
    await writeFile(join(folder, 'named.txt'), '');
    await modifiedLater(folder);
    const named = await adapter.reading({ named: [join(folder, 'named.txt')], disk: false });

    expect(filesOf(unnamed)).not.toContain('added.txt');
    expect([filesOf(checked)?.includes('added.txt'), checked.unheardChanges]).toEqual([true, [folder]]);
    expect([filesOf(named)?.includes('named.txt'), named.unheardChanges]).toEqual([true, []]);
  });
});

describe('the files an MO2 reading parses', () => {
  const readsOf = (suffix: string): number => vi.mocked(readFile).mock.calls.filter(([path]) => typeof path === 'string' && path.endsWith(suffix)).length;

  it.each(['.7z.meta', 'Patch Mod/meta.ini', 'Default/modlist.txt', 'Default/plugins.txt'])('reads %s again only once its stamp changes', async (suffix) => {
    const instance = cloneCorpusFixture();
    try {
      const adapter = managerOver(instance);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
      await adapter.reading();
      vi.mocked(readFile).mockClear();
      await adapter.reading();
      expect(readsOf(suffix)).toBe(0);
    } finally {
      vi.useRealTimers();
      await rm(instance, { recursive: true, force: true });
    }
  });

  it('reads a sorting rule file again only once its stamp changes', async () => {
    const instance = cloneCorpusFixture();
    try {
      const { masterlist } = sortingRuleFilePaths(instance);
      await writeFile(masterlist, 'plugins: []');
      const adapter = managerOver(instance);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
      await adapter.reading();
      vi.mocked(readFile).mockClear();
      await adapter.reading();
      expect(readsOf('masterlist.yaml')).toBe(0);
    } finally {
      vi.useRealTimers();
      await rm(instance, { recursive: true, force: true });
    }
  });
});
