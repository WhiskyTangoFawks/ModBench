import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, link, lstat, mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { adapterOver, managerOver } from '../../test/mo2/adapterOver';
import { listDir, listDirByStamp, parsedBy, readTrustingKept, textByStamp } from '../files';
import { sortingRuleFilePaths } from '../mo2/layout';
import { programsOf } from '../../tables/gamePaths';
import { expectKind } from '../../test/expectKind';
import { CHECK_THE_DISK, type GameFolder, type InstanceReading, type Reread } from '../instanceAdapter';
const programReads = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  programReads.mockImplementation(actual.open);
  return {
    ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat), lstat: vi.fn(actual.lstat),
    access: vi.fn(actual.access), open: programReads,
  };
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

    expect(unnamed).toMatchObject({ answer: ['a.esp'], unheard: [] });
    expect(named).toMatchObject({ answer: ['a.esp', 'b.esp'], unheard: [] });
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

  it('parses again within a re-read each file kept below a folder the re-read is named, the folder never listed', async () => {
    const path = join(root, 'Mod', 'meta.ini');
    await mkdir(join(root, 'Mod'));
    await writeFile(path, 'one');
    settle();
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await writeFile(path, 'three');
    await modifiedLater(path);

    expect((await readTrustingKept([join(root, 'Mod')], false, () => textAt(path))).answer).toBe('three');
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

    expect(checked).toMatchObject({ answer: [['new.esp'], ['new.esp']], unheard: [unheard] });
  });

  it('answers as unheard a change to a file it last read too soon after a write to trust', async () => {
    const path = join(root, 'modlist.txt');
    await writeFile(path, '+A');
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await writeFile(path, '+B');
    await modifiedLater(path);

    expect(await readTrustingKept([], true, () => textAt(path))).toMatchObject({ answer: '+B', unheard: [path] });
  });

  describe('on a file system that leaves a folder\'s stamp as it was for an entry added', () => {
    afterEach(async () => {
      const { stat: realStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(stat).mockImplementation(realStat);
    });

    const addedUnderAHeldStamp = async (): Promise<void> => {
      const { stat: realStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await writeFile(join(root, 'a.esp'), '');
      settle();
      const held = await realStat(root, { bigint: true });
      vi.mocked(stat).mockImplementation(async (...args) => (args[0] === root ? held : realStat(...args)));
      await namesOf(root);
      await writeFile(join(root, 'b.esp'), '');
    };

    it('lists the folder again at a check of the disk', async () => {
      await addedUnderAHeldStamp();

      const unnamed = await readTrustingKept([], false, () => namesOf(root));
      const checked = await readTrustingKept([], true, () => namesOf(root));

      expect([unnamed.answer, checked.answer]).toEqual([['a.esp'], ['a.esp', 'b.esp']]);
    });

    it('lists the folder again within a re-read named the entry added', async () => {
      await addedUnderAHeldStamp();

      const { answer } = await readTrustingKept([join(root, 'b.esp')], false, () => namesOf(root));

      expect(answer).toEqual(['a.esp', 'b.esp']);
    });
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

  it.each([
    ['a check', (path: string): Promise<unknown> => readTrustingKept([path], false, () => Promise.resolve())],
    ['a read', (path: string): Promise<unknown> => textByStamp(path).catch(() => undefined)],
  ])('compares a text read again with none %s found gone, so the same text back is a change', async (_by, findGone) => {
    const path = join(root, 'modlist.txt');
    await writeFile(path, '+A');
    await textByStamp(path);
    await rm(path);
    await findGone(path);
    await writeFile(path, '+A');
    await modifiedLater(path);

    expect((await readTrustingKept([path], false, () => textByStamp(path))).unchanged).toEqual(new Set());
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

  it('lists no mod folder again in a reading named nothing, and lists each again at a check of the disk, which shows a file added to one', async () => {
    const adapter = managerOver(instance);
    const first = await adapter.reading();
    const [name, files] = [...first.modFiles].find(([, listed]) => listed.files.length > 0) ?? ['', undefined];
    const folder = files?.folder ?? '';
    expect(name).not.toBe('');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading();
    vi.mocked(readdir).mockClear();
    await adapter.reading({ named: [], disk: false });
    expect(listingsOf(folder)).toBe(0);

    await mkdir(join(folder, 'added'), { recursive: true });
    await writeFile(join(folder, 'added', 'new.txt'), '');
    await modifiedLater(folder);
    const after = await adapter.reading();
    expect(after.modFiles.get(name)?.files.map((file) => file.relativePath)).toContain('added/new.txt');
  });

  it('has a read that a listener starts, called as the instance read follows a new profile folder, check each stamp', async () => {
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading();
    const folder = [...first.modFiles.values()].find((listed) => listed.files.length > 0)?.folder ?? '';
    await writeFile(join(folder, 'added.txt'), '');
    await modifiedLater(folder);
    const startedByTheListener: Promise<string[]>[] = [];
    adapter.subscribe(() => { startedByTheListener.push(namesOf(folder)); });
    await mkdir(join(instance, 'profiles', 'New Profile'));

    await adapter.reading({ named: [join(instance, 'profiles', 'New Profile')], disk: false });

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

  it('hands each fact of a re-read that found nothing changed as the object it was, the notes for the Output aside', async () => {
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading(CHECK_THE_DISK);

    const again = new Map(Object.entries(await adapter.reading({ named: [], disk: false })));

    const notes = new Set(['orderNotes', 'archiveListNotes', 'linkNotes', 'unheardChanges', 'unchangedFiles']);
    expect(Object.entries(first).filter(([fact, held]) => !notes.has(fact) && again.get(fact) !== held).map(([fact]) => fact)).toEqual([]);
  });

  it('names unchanged a file rewritten with its own bytes', async () => {
    const adapter = managerOver(instance);
    const modlist = join(instance, 'profiles', 'Default', 'modlist.txt');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading(CHECK_THE_DISK);
    await writeFile(modlist, await readFile(modlist));
    await modifiedLater(modlist);

    expect((await adapter.reading({ named: [modlist], disk: false })).unchangedFiles).toEqual([modlist]);
  });

  it('takes a file\'s stamp again, within a reading, only where a re-read is named it or checks the disk, and outside one each time', async () => {
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const file = [...(await adapter.reading()).modFiles.values()].flatMap((listed) => listed.files)[0]?.sourcePath ?? '';
    const stampAt = async (reread: Reread): Promise<unknown> => (await adapter.reading(reread)).trustingKept(() => adapter.fileStamp(file));
    const before = await stampAt(CHECK_THE_DISK);
    await modifiedLater(file);

    const unnamed = await stampAt({ named: [], disk: false });
    const named = await stampAt({ named: [file], disk: false });
    await modifiedLater(file);
    const outside = await adapter.fileStamp(file);
    await modifiedLater(file);
    const checked = await stampAt(CHECK_THE_DISK);

    expect(unnamed).toEqual(before);
    expect(named).not.toEqual(before);
    expect(outside).not.toEqual(named);
    expect(checked).not.toEqual(outside);
  });

  it('reads .gitmodules again, within a reading, only where a re-read is named it', async () => {
    execFileSync('git', ['init', '-q', instance]);
    const file = join(instance, '.gitmodules');
    const entry = (name: string): string => `[submodule "${name}"]\n\tpath = source/${name}\n\turl = https://example.com/${name}.git\n`;
    await writeFile(file, entry('A'));
    const adapter = managerOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const uncloned = async (reread: Reread): Promise<string[]> =>
      (await (await adapter.reading(reread)).trustingKept(() => adapter.unclonedSubmodules())).map(({ name }) => name);
    const first = await uncloned(CHECK_THE_DISK);
    await writeFile(file, entry('A') + entry('B'));
    await modifiedLater(file);

    const unnamed = await uncloned({ named: [], disk: false });
    const named = await uncloned({ named: [file], disk: false });

    expect([first, unnamed, named]).toEqual([['A'], ['A'], ['A', 'B']]);
  });

  describe('with a game folder', () => {
    let game: string;
    let gameFolder: GameFolder;
    const IO = [vi.mocked(readdir), vi.mocked(readFile), vi.mocked(stat), vi.mocked(lstat), vi.mocked(access), programReads];

    beforeEach(async () => {
      game = await mkdtemp(join(tmpdir(), 'medit-kept-game-'));
      gameFolder = { kind: 'found', root: game, dataFolder: join(game, 'Data') };
      const programs = programsOf('Fallout4');
      await mkdir(join(game, 'Data', 'Strings'), { recursive: true });
      await mkdir(join(game, 'Data', 'Textures'));
      await Promise.all([
        ...[programs?.game ?? '', programs?.extenderLoader ?? ''].map((program) => writeFile(join(game, program), 'MZ')),
        ...['Fallout4.esm', 'Fallout4 - Textures1.ba2', 'Strings/Fallout4_en.STRINGS', 'Textures/a.dds'].map((file) => writeFile(join(game, 'Data', file), '')),
      ]);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    });

    afterEach(() => rm(game, { recursive: true, force: true }));

    const pathsThereTakenBesideTheNamedFile = async (named: string): Promise<string[]> => {
      const adapter = adapterOver(instance, { gameFolder });
      await adapter.reading(CHECK_THE_DISK);
      await adapter.reading(CHECK_THE_DISK);
      for (const io of IO) io.mockClear();
      await adapter.reading({ named: [named], disk: false });
      const touched = IO.flatMap((io) => io.mock.calls.flatMap((call: unknown[]) => (typeof call[0] === 'string' ? [call[0]] : [])));
      return touched.filter((path) => path !== named && path !== dirname(named) && existsSync(path));
    };

    it('reads, lists and stats nothing of a repository with a source mod but the file a re-read is named and its folder', async () => {
      execFileSync('git', ['init', '-q', instance]);
      await mkdir(join(instance, 'source', 'Patch Mod'), { recursive: true });
      await writeFile(join(instance, 'source', 'Patch Mod', 'build.json'), '{}');

      expect(await pathsThereTakenBesideTheNamedFile(join(instance, 'mods', 'Patch Mod', 'Patch Mod.esp'))).toEqual([]);
    });

    it('reads, lists and stats nothing of an instance with a publisher\'s configuration but the file a re-read is named, its folder, and each folder along a tag\'s path', async () => {
      await writeFile(join(instance, 'compiler_settings.json'), JSON.stringify({ Profile: 'Default', Include: ['mods/Patch Mod/Patch Mod.esp'] }));

      expect(await pathsThereTakenBesideTheNamedFile(join(instance, 'mods', 'Patch Mod', 'Patch Mod.esp'))).toEqual([instance, join(instance, 'mods')]);
    });

    it('shows a publisher tag\'s path made at the instance root, which no watch hears, at a re-read named another file', async () => {
      await writeFile(join(instance, 'compiler_settings.json'), JSON.stringify({ Include: ['tools/x.txt'] }));
      const adapter = adapterOver(instance, { gameFolder });
      const pathProblems = async (reread: Reread): Promise<number> =>
        expectKind((await adapter.reading(reread)).publisherConfiguration, 'read').pathProblems.filter(({ tag }) => tag.name === 'Include').length;
      const before = await pathProblems(CHECK_THE_DISK);
      await mkdir(join(instance, 'tools'));
      await writeFile(join(instance, 'tools', 'x.txt'), '');
      await modifiedLater(instance);

      const after = await pathProblems({ named: [join(instance, 'mods', 'Patch Mod', 'Patch Mod.esp')], disk: false });

      expect([before, after]).toEqual([1, 0]);
    });

    it('reads the Creation Club list a mod deploys from a folder in it, which no watch hears, at a re-read named another file', async () => {
      const deployedFrom = join(instance, 'mods', 'Patch Mod', 'Root');
      await writeFile(join(game, 'Fallout4.ccc'), 'a.esl\r\n');
      await mkdir(deployedFrom);
      const adapter = adapterOver(instance, { gameFolder });
      const listed = async (reread: Reread): Promise<readonly string[]> => (await adapter.reading(reread)).creationClubList;
      const before = await listed(CHECK_THE_DISK);
      await writeFile(join(deployedFrom, 'Fallout4.ccc'), 'b.esl\r\n');
      await modifiedLater(deployedFrom);

      const after = await listed({ named: [join(instance, 'mods', 'Harder VATS', 'x.esp')], disk: false });

      expect([before, after]).toEqual([['a.esl'], ['b.esl']]);
    });

    it('finds at a check of the disk a Data folder file a link elsewhere made a deployed one, which no stamp shows', async () => {
      const adapter = adapterOver(instance, { gameFolder });
      const plugins = async (reread: Reread): Promise<ReadonlySet<string>> => expectKind((await adapter.reading(reread)).dataFolderPlugins, 'listed').names;
      await plugins(CHECK_THE_DISK);
      await link(join(game, 'Data', 'Fallout4.esm'), join(game, 'Fallout4.esm'));

      const unnamed = await plugins({ named: [], disk: false });
      const checked = await plugins(CHECK_THE_DISK);

      expect([...unnamed]).toEqual(['Fallout4.esm']);
      expect([...checked]).toEqual([]);
    });
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
