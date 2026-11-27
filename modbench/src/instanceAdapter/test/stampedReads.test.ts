import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, link, lstat, mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceOnDisk } from './instanceOnDisk';
import { programsOf } from '../../tables/gamePaths';
import { expectKind } from '../../test/expectKind';
import { CHECK_THE_DISK, type GameFolder, type InstanceAdapter, type InstanceReading, type Mod, type OriginFile, type Reread } from '../instanceAdapter';
import { onWindows } from '../../test/platform';
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

const HOUR_MS = 3_600_000;
const real = (): Promise<typeof import('node:fs/promises')> => vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const listingsOf = (folder: string): number => vi.mocked(readdir).mock.calls.filter(([path]) => path === folder).length;
let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};
const NOTES = new Set(['orderNotes', 'archiveListNotes', 'linkNotes', 'unheardChanges', 'unchangedFiles', 'contentsFound']);
const factsMoved = <R extends object>(landed: R, again: R): string[] => {
  const now = new Map(Object.entries(again));
  return Object.entries(landed).filter(([fact, held]) => !NOTES.has(fact) && now.get(fact) !== held).map(([fact]) => fact);
};

describe('a mod\'s folder listed and its meta parsed by their stamps, as a reading of the instance reads them', () => {
  let root: string;
  let adapter: InstanceAdapter;
  const mod = (name: string): string => join(root, 'mods', name);
  const meta = (): string => join(mod('Mod'), 'meta.ini');

  beforeEach(async () => {
    root = await instanceOnDisk({
      'profiles/Default/modlist.txt': '+Mod\n+Heard\n+Unheard\n',
      'mods/Mod/meta.ini': '[General]\nversion=1\n', 'mods/Mod/textures/a.dds': '', 'mods/Heard/a.esp': '', 'mods/Unheard/a.esp': '',
    });
    adapter = adapterOver(root);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(stat).mockImplementation((await real()).stat);
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };
  const versionIn = (reading: Pick<InstanceReading, 'mods'>): string | undefined => reading.mods.find((entry): entry is Mod => entry.kind === 'mod' && entry.name === 'Mod')?.version;
  const filesOf = (reading: Pick<InstanceReading, 'modFiles'>, name = 'Mod'): string[] =>
    (reading.modFiles.get(name)?.files ?? []).map(({ relativePath }) => relativePath).sort();
  const UNNAMED: Reread = { named: [], disk: false };
  const named = (...paths: string[]): Reread => ({ named: paths, disk: false });
  const metaWritten = async (version: string): Promise<void> => {
    await writeFile(meta(), `[General]\nversion=${version}\n`);
    await modifiedLater(meta());
  };

  onWindows.it('lists again within a re-read the folder of a path named in another case, as VS Code\'s watcher spells a drive', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await writeFile(join(mod('Mod'), 'b.esp'), '');
    await modifiedLater(mod('Mod'));

    expect(filesOf(await adapter.reading(named(join(mod('Mod'), 'b.esp').toLowerCase())))).toContain('b.esp');
  });

  it('parses again within a re-read a file the re-read is named', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await metaWritten('3');

    expect([versionIn(await adapter.reading(UNNAMED)), versionIn(await adapter.reading(named(meta())))]).toEqual(['1', '3']);
  });

  it('parses again within a re-read each file kept below a folder the re-read is named, the folder never listed', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await metaWritten('3');

    expect(versionIn(await adapter.reading(named(mod('Mod'))))).toBe('3');
  });

  it('lists again within a re-read each folder kept below a folder the re-read is named', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await writeFile(join(mod('Mod'), 'textures', 'b.dds'), '');
    await modifiedLater(join(mod('Mod'), 'textures'));

    expect(filesOf(await adapter.reading(named(mod('Mod'))))).toEqual(['textures/a.dds', 'textures/b.dds']);
  });

  it('checks the disk by every stamp it keeps, answering each change as unheard but those of the paths it is named', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await Promise.all(['Heard', 'Unheard'].map((name) => writeFile(join(mod(name), 'new.esp'), '')));
    await modifiedLater(mod('Heard'));
    await modifiedLater(mod('Unheard'));

    const checked = await adapter.reading({ named: [join(mod('Heard'), 'new.esp')], disk: true });

    expect([filesOf(checked, 'Heard'), filesOf(checked, 'Unheard'), checked.unheardChanges]).toEqual([['a.esp', 'new.esp'], ['a.esp', 'new.esp'], [mod('Unheard')]]);
  });

  it('answers as unheard a change to a file it last read too soon after a write to trust', async () => {
    const modlist = join(root, 'profiles', 'Default', 'modlist.txt');
    await adapter.reading(CHECK_THE_DISK);
    await writeFile(modlist, '+Heard\n');
    await modifiedLater(modlist);

    const checked = await adapter.reading(CHECK_THE_DISK);

    expect([checked.mods.map(({ name }) => name), checked.unheardChanges]).toEqual([['Heard'], [modlist]]);
  });

  describe('on a file system that leaves a folder\'s stamp as it was for an entry added', () => {
    const addedUnderAHeldStamp = async (): Promise<void> => {
      settle();
      const { stat: realStat } = await real();
      const held = await realStat(mod('Mod'), { bigint: true });
      vi.mocked(stat).mockImplementation(async (...args) => (args[0] === mod('Mod') ? held : realStat(...args)));
      await adapter.reading(CHECK_THE_DISK);
      await writeFile(join(mod('Mod'), 'b.esp'), '');
    };

    it('lists the folder again at a check of the disk', async () => {
      await addedUnderAHeldStamp();

      expect([filesOf(await adapter.reading(UNNAMED)), filesOf(await adapter.reading(CHECK_THE_DISK))])
        .toEqual([['textures/a.dds'], ['b.esp', 'textures/a.dds']]);
    });

    it('lists the folder again within a re-read named the entry added', async () => {
      await addedUnderAHeldStamp();

      expect(filesOf(await adapter.reading(named(join(mod('Mod'), 'b.esp'))))).toEqual(['b.esp', 'textures/a.dds']);
    });
  });

  it('forgets at a check of the disk, as a change no event named, a folder it kept that is gone', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await rm(join(mod('Mod'), 'textures'), { recursive: true });

    const checked = await adapter.reading(CHECK_THE_DISK);

    expect([filesOf(checked), checked.unheardChanges]).toEqual([[], expect.arrayContaining([join(mod('Mod'), 'textures')])]);
  });

  it('reads a file that is gone as gone, as a read of it does', async () => {
    settle();
    await adapter.reading(CHECK_THE_DISK);
    await rm(meta());

    expect(versionIn(await adapter.reading(named(meta())))).toBeUndefined();
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
    const adapter = adapterOver(instance);
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
    const adapter = adapterOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading();
    const folder = [...first.modFiles.values()].find((listed) => listed.files.length > 0)?.folder ?? '';
    await writeFile(join(folder, 'added.txt'), '');
    await modifiedLater(folder);
    const startedByTheListener: Promise<readonly string[]>[] = [];
    adapter.subscribe(() => { startedByTheListener.push(adapter.filesIn(folder)); });
    await mkdir(join(instance, 'profiles', 'New Profile'));

    await adapter.reading({ named: [join(instance, 'profiles', 'New Profile')], disk: false });

    expect(await Promise.all(startedByTheListener)).toEqual([expect.arrayContaining(['added.txt'])]);
  });

  it('shows a file added to a mod folder when a re-read is named it or the disk is checked, and tells the check found it unheard', async () => {
    const adapter = adapterOver(instance);
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
    const adapter = adapterOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const first = await adapter.reading(CHECK_THE_DISK);

    const again = await adapter.reading({ named: [], disk: false }, first);

    expect(factsMoved(first, again)).toEqual([]);
  });

  it.each([
    ['modlist.txt', '+Another Mod\n'],
    ['plugins.txt', '*Another.esp\n'],
  ])('hands each fact as the landed reading holds it once %s is back as it was, whatever a reading between found', async (file, line) => {
    const adapter = adapterOver(instance);
    const path = join(instance, 'profiles', 'Default', file);
    const text = await readFile(path, 'utf8');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const landed = await adapter.reading(CHECK_THE_DISK);
    await writeFile(path, text + line);
    await modifiedLater(path);
    await adapter.reading({ named: [path], disk: false });
    await writeFile(path, text);
    await modifiedLater(path);

    const again = await adapter.reading({ named: [path], disk: false }, landed);

    expect(factsMoved(landed, again)).toEqual([]);
  });

  it('names unchanged a file nothing wrote, its stamp old enough to trust', async () => {
    const adapter = adapterOver(instance);
    const modlist = join(instance, 'profiles', 'Default', 'modlist.txt');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading(CHECK_THE_DISK);
    const landed = await adapter.reading(CHECK_THE_DISK);

    expect((await adapter.reading({ named: [modlist], disk: false }, landed)).unchangedFiles).toEqual([modlist]);
  });

  it('names unchanged a file rewritten with its own bytes', async () => {
    const adapter = adapterOver(instance);
    const modlist = join(instance, 'profiles', 'Default', 'modlist.txt');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const landed = await adapter.reading(CHECK_THE_DISK);
    await writeFile(modlist, await readFile(modlist));
    await modifiedLater(modlist);

    expect((await adapter.reading({ named: [modlist], disk: false }, landed)).unchangedFiles).toEqual([modlist]);
  });

  it.each<[string, (adapter: InstanceAdapter, modlist: string) => Promise<unknown>]>([
    ['a reading between them', (adapter, modlist) => adapter.reading({ named: [modlist], disk: false })],
    ['a reading that then failed', async (adapter, modlist) => {
      const plugins = join(dirname(modlist), 'plugins.txt');
      const text = await readFile(plugins);
      await rm(plugins);
      await mkdir(plugins);
      await expect(adapter.reading({ named: [modlist, plugins], disk: false })).rejects.toThrow(/EISDIR/);
      await rm(plugins, { recursive: true });
      await writeFile(plugins, text);
    }],
    ['a read outside a reading', (adapter) => adapter.modOrder()],
  ])('finds a file unchanged only against the landed reading it is handed, never against %s', async (_between, readTheNewText) => {
    const adapter = adapterOver(instance);
    const modlist = join(instance, 'profiles', 'Default', 'modlist.txt');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const landed = await adapter.reading(CHECK_THE_DISK);
    await writeFile(modlist, `${await readFile(modlist, 'utf8')}+Another Mod\n`);
    await modifiedLater(modlist);
    await readTheNewText(adapter, modlist);
    await writeFile(modlist, await readFile(modlist));
    await modifiedLater(modlist);

    expect((await adapter.reading({ named: [modlist], disk: false }, landed)).unchangedFiles).toEqual([]);
  });

  it('hands the files of a mod walked again, its stamp too fresh to trust, as the landed reading holds them', async () => {
    const adapter = adapterOver(instance);
    await writeFile(join(instance, 'mods', 'Harder VATS', 'fresh.txt'), '');
    const landed = await adapter.reading();

    const again = await adapter.reading(CHECK_THE_DISK, landed);

    expect(again.modFiles).toBe(landed.modFiles);
  });

  it('hands the folders and each file of a mod a file was added to as the landed reading holds them', async () => {
    const folder = join(instance, 'mods', 'Harder VATS');
    await mkdir(join(folder, 'meshes'));
    await writeFile(join(folder, 'meshes', 'a.nif'), '');
    const adapter = adapterOver(instance);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    const landed = await adapter.reading(CHECK_THE_DISK);
    const listed = landed.modFiles.get('Harder VATS');
    const added = join(folder, 'added.txt');
    await writeFile(added, '');
    await modifiedLater(folder);

    const now = (await adapter.reading({ named: [added], disk: false }, landed)).modFiles.get('Harder VATS');

    expect(now?.files.map((file) => file.relativePath)).toContain('added.txt');
    expect(listed?.folders).not.toEqual([]);
    expect(now?.folders).toBe(listed?.folders);
    expect(now?.files.filter((file) => listed?.files.includes(file))).toHaveLength(listed?.files.length ?? -1);
  });

  it('hands a file whose link names another file as a new object, and each other file as the landed reading holds it', async () => {
    const folder = join(instance, 'mods', 'Harder VATS');
    const [first, second, linked] = [join(instance, 'first.txt'), join(instance, 'second.txt'), join(folder, 'linked.txt')];
    await Promise.all([writeFile(first, ''), writeFile(second, '')]);
    await symlink(first, linked);
    const adapter = adapterOver(instance);
    const landed = await adapter.reading(CHECK_THE_DISK);
    await rm(linked);
    await symlink(second, linked);

    const filesOf = (reading: Pick<InstanceReading, 'modFiles'>): readonly OriginFile[] => reading.modFiles.get('Harder VATS')?.files ?? [];
    const [before, now] = [filesOf(landed), filesOf(await adapter.reading(CHECK_THE_DISK, landed))];

    expect(now.find(({ path }) => path === linked)?.sourcePath).toBe(second);
    expect(now.filter((file) => before.includes(file))).toHaveLength(before.length - 1);
  });

  it('hands each mod\'s files as the landed reading holds them while another reading overlaps it', async () => {
    const adapter = adapterOver(instance);
    const landed = await adapter.reading(CHECK_THE_DISK);

    const [again] = await Promise.all([adapter.reading({ named: [], disk: false }, landed), adapter.reading()]);

    expect(again.modFiles).toBe(landed.modFiles);
  });

  it('takes a file\'s stamp again, within a reading, only where a re-read is named it or checks the disk, and outside one each time', async () => {
    const adapter = adapterOver(instance);
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
    const adapter = adapterOver(instance);
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
      return touched.filter((path) => path !== named && path !== dirname(named));
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

    it.each([
      ['read', JSON.stringify({ Profile: 'Default', Include: ['mods/Patch Mod/Patch Mod.esp'] }), JSON.stringify({ Profile: 'Default' })],
      ['unreadable', '{ "Profile": ', '{ "Include": ['],
    ])('hands the publisher\'s configuration, %s, as the landed reading holds it once its settings are back as they were, whatever a reading between found', async (_kind, text, between) => {
      const settings = join(instance, 'compiler_settings.json');
      await writeFile(settings, text);
      const adapter = adapterOver(instance, { gameFolder });
      const landed = await adapter.reading(CHECK_THE_DISK);
      await writeFile(settings, between);
      await modifiedLater(settings);
      await adapter.reading({ named: [settings], disk: false });
      await writeFile(settings, text);
      await modifiedLater(settings);

      expect((await adapter.reading({ named: [settings], disk: false }, landed)).publisherConfiguration).toBe(landed.publisherConfiguration);
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
      const adapter = adapterOver(instance);
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
      const masterlist = join(instance, 'masterlist.yaml');
      await writeFile(masterlist, 'plugins: []');
      const adapter = adapterOver(instance);
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
