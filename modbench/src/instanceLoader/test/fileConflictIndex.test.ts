import { describe, it, expect } from 'vitest';
import type { Mod, Separator } from '../instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import {
  buildFileConflictIndex, foldPath, indexReusing, modOrigin, sliceReusing, stackReusing, copyStandingOf, FileConflictLookup, type StackedFile, goToModCandidates, fileOrderConflictOf, RUNTIME_OUTPUT, type ConflictEntry, type FileConflictIndex, type LoadedArchive,
} from '../fileConflictIndex';
import type { FileOrigin, OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { fileIn } from '../../test/fakeInstanceAdapter';
import { present } from '../../ports/present';
import { reachableObjects } from '../../test/reachableObjects';

const modPath = (name: string, relativePath: string): string => `/mods/${name}/${relativePath}`;

const indexOver = (entries: ModlistEntry[], filesByMod: Record<string, string[]>, overwrite: OriginFile[] = []) =>
  buildFileConflictIndex(entries, overwrite, new Map(Object.entries(filesByMod).map(([name, paths]) => [name, {
    origin: name, folder: `/mods/${name}`, folders: [], notes: [], files: paths.map((path) => fileIn(`/mods/${name}`, path)),
  }])));

const SHARED = 'textures/shared/foo.dds';
const conflicting = { ModA: [SHARED], ModB: [SHARED, 'meshes/onlyB.nif'] };
const caseConflicting = { ModA: ['Textures/Foo.dds'], ModB: ['textures/foo.dds'], RootA: ['Foo.esp'], RootB: ['foo.ESP'] };

const answering = (names: readonly string[], answer: Omit<OriginFiles, 'origin'>): ReadonlyMap<string, OriginFiles> =>
  new Map(names.map((name) => [name, { origin: name, ...answer }]));

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('the winner and providers of each path the mods ship', () => {
  it('resolves the winner for an overridden file to the first enabled mod, modlist.txt being winning-first', () => {
    const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];
    const index = indexOver(entries, conflicting);

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModA'));
    expect(entry?.winner).toBe(modPath('ModA', SHARED));
    expect(entry?.providers).toEqual([modOrigin('ModA'), modOrigin('ModB')]);
  });

  it('flips the winner when the mods are reordered', () => {
    const index = indexOver([mod('ModB'), mod('ModA')], conflicting);
    expect(index.files.get('textures/shared/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('excludes disabled mods from conflict resolution', () => {
    const index = indexOver([mod('ModA', false), mod('ModB')], conflicting);
    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.providers).toEqual([modOrigin('ModB')]);
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('lists a disabled mod\'s own files under filesByMod, as an enabled mod\'s are, apart from conflict resolution', () => {
    const index = indexOver([mod('ModA', false), mod('ModB')], conflicting);
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual(['textures/shared/foo.dds']);
    expect(index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort()).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });

  it('records a single-provider file with providers.length === 1', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], conflicting);
    const entry = index.files.get('meshes/onlyB.nif');
    expect(entry?.providers).toEqual([modOrigin('ModB')]);
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('excludes an enabled separator — a separator is not a mod, even though it also carries `enabled`', () => {
    const index = indexOver([separator('Unassigned'), mod('ModA'), mod('ModB')], conflicting);
    expect(index.filesByMod.has('Unassigned')).toBe(false);
    expect(index.files.get('textures/shared/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModA'));
  });
});

describe('Overwrite is the winning-most provider', () => {
  const overwriteCopy = fileIn('/instance/overwrite', 'textures/shared/foo.dds');

  it('wins a path over every mod that provides it, and is listed as a provider', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], conflicting, [overwriteCopy]);

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winner).toBe('/instance/overwrite/textures/shared/foo.dds');
    expect(entry?.winnerOrigin).toEqual({ kind: 'runtimeOutput' });
    expect(entry?.providers).toEqual([{ kind: 'runtimeOutput' }, modOrigin('ModA'), modOrigin('ModB')]);
  });

  it('is the sole provider of a path no mod ships', () => {
    const index = indexOver([mod('ModA')], conflicting, [fileIn('/o', 'only.txt')]);
    expect(index.files.get('only.txt')).toMatchObject({ winnerOrigin: { kind: 'runtimeOutput' }, providers: [{ kind: 'runtimeOutput' }] });
  });

  it('keeps Overwrite out of every mod\'s own files', () => {
    const index = indexOver([mod('ModA')], conflicting, [overwriteCopy]);
    expect(index.filesByMod.has(OVERWRITE_ORIGIN)).toBe(false);
  });

  it('tells Overwrite from a mod folder named overwrite: that mod loses to Overwrite', () => {
    const index = buildFileConflictIndex(
      [mod(OVERWRITE_ORIGIN)], [fileIn('/instance/overwrite', 'a.dds')],
      answering([OVERWRITE_ORIGIN], { folder: '/mods/overwrite', files: [fileIn('/mods/overwrite', 'a.dds')], folders: [], notes: [] }),
    );
    expect(index.files.get('a.dds')).toEqual({
      relativePath: 'a.dds', winner: '/instance/overwrite/a.dds', winnerOrigin: { kind: 'runtimeOutput' },
      providers: [{ kind: 'runtimeOutput' }, modOrigin(OVERWRITE_ORIGIN)],
    });
  });
});

describe('case-insensitive conflicts, as Proton/Wine folds case over case-sensitive ext4', () => {
  it('resolves case-variant paths from two mods to a single conflict entry with both providers', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], caseConflicting);

    expect([...index.files]).toHaveLength(1);
    const entry = index.files.get('Textures/Foo.dds');
    expect(entry?.providers).toEqual([modOrigin('ModA'), modOrigin('ModB')]);
    const entryOtherCasing = index.files.get('textures/foo.dds');
    expect(entryOtherCasing).toBe(entry);
  });

  it('finds a path spelled with backslashes as the path spelled with forward slashes, as the game reads either', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], caseConflicting);

    expect(index.files.get('Textures\\Foo.dds')).toBe(index.files.get('textures/foo.dds'));
  });

  it('picks the same winner by priority whether casing matches or varies', () => {
    const top = indexOver([mod('ModA'), mod('ModB')], caseConflicting);
    expect(top.files.get('textures/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModA'));

    const flipped = indexOver([mod('ModB'), mod('ModA')], caseConflicting);
    expect(flipped.files.get('textures/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('names a mod or Overwrite once among a path\'s providers, though it ships two case variants of it', () => {
    const index = buildFileConflictIndex(
      [mod('ModA'), mod('ModB')],
      [fileIn('/overwrite', 'Textures/Foo.dds'), fileIn('/overwrite', 'textures/foo.dds')],
      new Map([
        ['ModA', { origin: 'ModA', folder: '/mods', folders: [], notes: [], files: [fileIn('/mods/ModA', 'Textures/Foo.dds'), fileIn('/mods/ModA', 'textures/foo.dds')] }],
        ['ModB', { origin: 'ModB', folder: '/mods', folders: [], notes: [], files: [fileIn('/mods/ModB', 'textures/foo.dds')] }],
      ]),
    );

    expect(index.files.get('textures/foo.dds')).toMatchObject({
      winner: '/overwrite/Textures/Foo.dds', providers: [{ kind: 'runtimeOutput' }, modOrigin('ModA'), modOrigin('ModB')],
    });
  });

  it('keeps the winner\'s own original casing in relativePath and winner, regardless of lookup casing', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], caseConflicting);

    const entry = index.files.get('TEXTURES/FOO.DDS');
    expect(entry?.relativePath).toBe('Textures/Foo.dds');
    expect(entry?.winner).toBe(modPath('ModA', 'Textures/Foo.dds'));
  });

  it('folds a case-variant root-level plugin pair of two mods to one winner', () => {
    const index = indexOver([mod('RootA'), mod('RootB')], caseConflicting);

    expect([...index.files].map((entry) => entry.winner)).toEqual([modPath('RootA', 'Foo.esp')]);
  });
});

describe('what the reading holds: the walk is the adapter\'s', () => {
  it('takes no excluded file as a provider, in a mod or Overwrite, and keeps it among its mod\'s files', () => {
    const excluded = { relativePath: 'Hidden.esp', path: '/mods/ModA/Hidden.esp', sourcePath: '/mods/ModA/Hidden.esp', excluded: true, markedExcluded: true, includedPath: 'Hidden.esp' };
    const kept = fileIn('/mods/ModA', 'Kept.esp');
    const overwritten = { relativePath: 'Hidden.esp', path: '/overwrite/Hidden.esp', sourcePath: '/overwrite/Hidden.esp', excluded: true, markedExcluded: true, includedPath: 'Hidden.esp' };
    const index = buildFileConflictIndex(
      [mod('ModA')], [overwritten], answering(['ModA'], { folder: '/mods/ModA', files: [excluded, kept], folders: [], notes: [] }),
    );

    expect([...index.files].map((entry) => entry.relativePath)).toEqual(['Kept.esp']);
    expect(index.filesByMod.get('ModA')).toEqual([excluded, kept]);
  });

  it('keeps each file where the adapter says it sits and is read from, and each folder where it sits', () => {
    const linked = { relativePath: 'x/linked.dds', path: '/mods/ModA/x/linked.dds', sourcePath: '/shared/real.dds', excluded: false, markedExcluded: false, includedPath: 'x/linked.dds' };
    const folder = { relativePath: 'x', path: '/mods/ModA/x', includedPath: 'x', excluded: false };
    const index = buildFileConflictIndex(
      [mod('ModA')], [], answering(['ModA'], { folder: '/mods/ModA', files: [linked], folders: [folder], notes: [] }),
    );

    expect(index.files.get('x/linked.dds')?.winner).toBe('/shared/real.dds');
    expect(index.filesByMod.get('ModA')).toEqual([linked]);
    expect(index.foldersByMod.get('ModA')).toEqual([folder]);
  });
});

const entryOf = (...providers: ConflictEntry['providers']): ConflictEntry => ({
  relativePath: 'textures/a.dds', winner: '/w', winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers,
});
const high = modOrigin('High');
const middle = modOrigin('Middle');
const low = modOrigin('Low');
const folderNamedOverwrite = modOrigin('overwrite');

describe('the origins go to mod can name for a copy of a file', () => {
  it.each<[string, ConflictEntry | undefined, FileOrigin, FileOrigin[]]>([
    ['the winning copy, for a copy that loses', entryOf(high, middle, low), middle, [high]],
    ['every copy the winning copy wins over, in the order the index lists them', entryOf(high, middle, low), high, [middle, low]],
    ['Overwrite, as the winner of a mod copy it wins over', entryOf(RUNTIME_OUTPUT, low), low, [RUNTIME_OUTPUT]],
    ['Overwrite, told from a mod folder named overwrite', entryOf(RUNTIME_OUTPUT, folderNamedOverwrite), folderNamedOverwrite, [RUNTIME_OUTPUT]],
    ['nothing, for a copy nothing else provides', entryOf(high), high, []],
    ['nothing, for a copy that is no provider', entryOf(high, middle), low, []],
    ['nothing, for a path no one provides', undefined, high, []],
  ])('is %s', (_case, entry, own, expected) => {
    expect(goToModCandidates(entry, own)).toEqual(expected);
  });
});

describe('whether a copy of a file wins or loses its file order conflict', () => {
  it.each<[string, ConflictEntry | undefined, FileOrigin, string]>([
    ['wins, for the winner of a path another copy provides', entryOf(high, low), high, 'wins'],
    ['wins, for Overwrite over a mod copy', entryOf(RUNTIME_OUTPUT, high), RUNTIME_OUTPUT, 'wins'],
    ['loses, for a provider that is not the winner', entryOf(high, low), low, 'loses'],
    ['loses, for a mod copy Overwrite wins over', entryOf(RUNTIME_OUTPUT, high), high, 'loses'],
    ['is none, for a copy no other copy conflicts with', entryOf(high), high, 'none'],
    ['is none, for a copy that is no provider', entryOf(high, middle), low, 'none'],
    ['is none, for a path no one provides', undefined, high, 'none'],
  ])('%s', (_case, entry, own, expected) => {
    expect(fileOrderConflictOf(entry, own)).toBe(expected);
  });
});

const listing = (name: string, paths: string[]): OriginFiles =>
  ({ origin: name, folder: `/mods/${name}`, folders: [], notes: [], files: paths.map((path) => fileIn(`/mods/${name}`, path)) });

const byPath = (a: { relativePath: string }, b: { relativePath: string }): number => foldPath(a.relativePath).localeCompare(foldPath(b.relativePath));

describe('a lookup changed from the one before it', () => {
  const entryAt = (path: string, winner = 'A'): ConflictEntry => ({ relativePath: path, winner: `/mods/${winner}/${path}`, winnerOrigin: modOrigin(winner), providers: [modOrigin(winner)] });
  const lookupOf = (entries: ConflictEntry[]): FileConflictLookup => {
    const lookup = new FileConflictLookup();
    for (const entry of entries) lookup.set(entry);
    return lookup;
  };
  const pathsUpTo = (count: number): string[] => Array.from({ length: count }, (_, at) => `meshes/${at}.nif`);

  it('holds what a lookup built afresh holds, and leaves the one before it as it was', () => {
    const paths = pathsUpTo(1100);
    const added = pathsUpTo(1400).slice(1100);
    const was = lookupOf(paths.map((path) => entryAt(path)));
    const now = was.changed(new Map<string, ConflictEntry | undefined>([
      ...paths.slice(0, 300).map((path) => [path, undefined] as const),
      ...[...paths.slice(300, 600), ...added].map((path) => [path, entryAt(path, 'B')] as const),
    ]));

    const afresh = lookupOf([...paths.slice(600).map((path) => entryAt(path)), ...[...paths.slice(300, 600), ...added].map((path) => entryAt(path, 'B'))]);
    expect([...now].sort(byPath)).toEqual([...afresh].sort(byPath));
    expect([...was].sort(byPath)).toEqual([...lookupOf(paths.map((path) => entryAt(path)))].sort(byPath));
  });

  it('holds no more than an empty lookup once every path it held is taken out', () => {
    const paths = pathsUpTo(1100);
    const emptied = lookupOf(paths.map((path) => entryAt(path))).changed(new Map(paths.map((path) => [path, undefined])));

    expect(reachableObjects(emptied).size).toBe(reachableObjects(new FileConflictLookup()).size);
  });

  it('answers itself for a change that leaves every path as it holds it', () => {
    const was = lookupOf(pathsUpTo(20).map((path) => entryAt(path)));

    expect(was.changed(new Map([['meshes/absent.nif', undefined], ['meshes/7.nif', was.get('meshes/7.nif')]]))).toBe(was);
  });
});

describe('a slice of the index', () => {
  const ESP = ({ relativePath }: OriginFile): boolean => relativePath.endsWith('.esp');

  it('stays the object it was while the files it takes do, whatever else a listing changed', () => {
    const slice = sliceReusing(ESP);
    const was = listing('A', ['a.esp', 'a.nif']);
    const first = slice([mod('A')], [], new Map([['A', was]]));

    expect(slice([mod('A')], [], new Map([['A', { ...was, files: [...was.files, fileIn('/mods/A', 'b.nif')] }]]))).toBe(first);
  });

  it('indexes a file it takes once a listing gains one', () => {
    const slice = sliceReusing(ESP);
    const was = listing('A', ['a.esp']);
    slice([mod('A')], [], new Map([['A', was]]));

    expect(slice([mod('A')], [], new Map([['A', { ...was, files: [...was.files, fileIn('/mods/A', 'b.esp')] }]])).index.files.get('b.esp')?.winnerOrigin).toEqual(modOrigin('A'));
  });
});

describe('the index kept current as a reading changes', () => {
  interface Reading { entries: ModlistEntry[]; overwrite: OriginFile[]; modFiles: Map<string, OriginFiles> }
  const reading = (): Reading => ({
    entries: [mod('A'), mod('B'), mod('C')],
    overwrite: [],
    modFiles: new Map([['A', listing('A', ['a.nif', SHARED])], ['B', listing('B', ['b.nif', SHARED])], ['C', listing('C', ['c.nif', SHARED])]]),
  });
  const indexOf = (build: typeof buildFileConflictIndex, { entries, overwrite, modFiles }: Reading) => build(entries, overwrite, modFiles);
  const contentOf = ({ files, ...index }: FileConflictIndex) => ({ files: [...files].sort(byPath), mods: [...index.filesByMod.keys()], ...index });
  const withListing = (name: string, paths: string[]) => (was: Reading): Reading => ({ ...was, modFiles: new Map(was.modFiles).set(name, listing(name, paths)) });

  it.each<[string, (was: Reading) => Reading]>([
    ['a mod\'s listing gains a file', withListing('B', ['b.nif', SHARED, 'b2.nif'])],
    ['the winning mod\'s listing lacks the path', withListing('A', ['a.nif'])],
    ['a losing mod\'s listing lacks the path', withListing('B', ['b.nif'])],
    ['a mod gains a case variant of a path it holds', withListing('C', ['c.nif', SHARED, SHARED.toUpperCase()])],
    ['a mod\'s copy of a path is excluded', (was) => ({ ...was, modFiles: new Map(was.modFiles).set('A', { ...listing('A', ['a.nif']), files: [fileIn('/mods/A', 'a.nif'), { ...fileIn('/mods/A', SHARED), excluded: true }] }) })],
    ['a mod is disabled', (was) => ({ ...was, entries: [mod('A', false), mod('B'), mod('C')] })],
    ['a mod moves to the winning end', (was) => ({ ...was, entries: [mod('C'), mod('A'), mod('B')] })],
    ['two mods swap places', (was) => ({ ...was, entries: [mod('B'), mod('A'), mod('C')] })],
    ['the mod order is reversed', (was) => ({ ...was, entries: [mod('C'), mod('B'), mod('A')] })],
    ['a mod is removed', (was) => ({ ...was, entries: [mod('A'), mod('C')] })],
    ['a mod is added', (was) => ({ ...withListing('D', [SHARED])(was), entries: [mod('D'), ...was.entries] })],
    ['Overwrite\'s files change', (was) => ({ ...was, overwrite: [fileIn('/overwrite', SHARED)] })],
  ])('indexes what an index built afresh does when %s', (_case, change) => {
    const build = indexReusing();
    const was = reading();
    indexOf(build, was);
    const now = change(was);

    expect(contentOf(indexOf(build, now))).toEqual(contentOf(indexOf(buildFileConflictIndex, now)));
  });

  it('keeps each entry a change to one mod\'s files leaves as it was the object it was', () => {
    const build = indexReusing();
    const was = reading();
    const first = indexOf(build, was);
    const changed = { ...present(was.modFiles.get('C'), 'C\'s listing'), files: listing('C', ['c.nif', SHARED, 'c2.nif']).files };
    const next = indexOf(build, { ...was, modFiles: new Map(was.modFiles).set('C', changed) });

    expect(next.filesByMod.get('A')).toBe(first.filesByMod.get('A'));
    expect(next.filesByMod.get('B')).toBe(first.filesByMod.get('B'));
    expect(next.foldersByMod).toBe(first.foldersByMod);
    expect(next.files.get('a.nif')).toBe(first.files.get('a.nif'));
    expect(next.files.get('b.nif')).toBe(first.files.get('b.nif'));
    expect(next.files.get(SHARED)).toBe(first.files.get(SHARED));
  });

  it('keeps each entry of a path the mod that moved does not provide the object it was', () => {
    const build = indexReusing();
    const was = reading();
    const first = indexOf(build, was);
    const next = indexOf(build, { ...was, entries: [mod('C'), mod('A'), mod('B')] });

    expect(next.files.get('a.nif')).toBe(first.files.get('a.nif'));
    expect(next.files.get('b.nif')).toBe(first.files.get('b.nif'));
    expect(next.files.get(SHARED)?.winnerOrigin).toEqual(modOrigin('C'));
  });

  it('answers the same files when the listing that changed holds the same files', () => {
    const build = indexReusing();
    const was = reading();
    const first = indexOf(build, was);
    const folders = [{ relativePath: 'new', path: '/mods/B/new', includedPath: 'new', excluded: false }];
    const next = indexOf(build, { ...was, modFiles: new Map(was.modFiles).set('B', { ...present(was.modFiles.get('B'), 'B\'s listing'), folders }) });

    expect(next.files).toBe(first.files);
    expect(next.foldersByMod).not.toBe(first.foldersByMod);
  });

  it('answers the index it built when the mods, their order and every listing are the same', () => {
    const build = indexReusing();
    const was = reading();
    const first = indexOf(build, was);

    expect(indexOf(build, { ...reading(), overwrite: was.overwrite, modFiles: new Map(was.modFiles) })).toBe(first);
  });
});

describe('the copies of each file, stacked as the game stacks them', () => {
  const FILE = 'meshes/shared.nif';
  const archive = (name: string, archiveName: string, files: string[] | undefined) => ({ origin: modOrigin(name), archive: modPath(name, archiveName), files });
  const loose = (name: string) => ({ origin: modOrigin(name), at: { kind: 'loose', path: modPath(name, FILE) } });
  const archived = (name: string, archiveName: string) =>
    ({ origin: modOrigin(name), at: { kind: 'archived', gameRelease: 'Fallout4', archive: modPath(name, archiveName), file: FILE } });
  const stacked = (filesByMod: Record<string, string[]>, archives: ReturnType<typeof archive>[]) =>
    stackReusing()(indexOver(Object.keys(filesByMod).map((name) => mod(name)), filesByMod), archives, 'Fallout4');

  it('puts every loose copy above every archived copy, whatever the mod order', () => {
    const stack = stacked({ A: ['A.ba2'], B: [FILE] }, [archive('A', 'A.ba2', [FILE])]);

    expect(stack.get(FILE)?.copies).toEqual([loose('B'), archived('A', 'A.ba2')]);
  });

  it('stacks archived copies in the order the game loads their archives, the last loaded winning', () => {
    const stack = stacked({ A: ['A.ba2'], B: ['B.ba2'] }, [archive('A', 'A.ba2', [FILE]), archive('B', 'B.ba2', [FILE])]);

    expect(stack.get(FILE)?.copies).toEqual([archived('B', 'B.ba2'), archived('A', 'A.ba2')]);
  });

  it('takes one copy from each origin, the one the game would get of its own', () => {
    const stack = stacked({ A: [FILE, 'A.ba2', 'A - Extra.ba2'], B: ['B.ba2'] }, [
      archive('A', 'A.ba2', [FILE]), archive('A', 'A - Extra.ba2', [FILE]), archive('B', 'B.ba2', [FILE]),
    ]);

    expect(stack.get(FILE)?.copies).toEqual([loose('A'), archived('B', 'B.ba2')]);
  });

  it('holds no copy of a loaded archive under its own name, the files it holds standing for it', () => {
    const stack = stacked({ A: ['A.ba2'], B: ['B.ba2'] }, [archive('A', 'A.ba2', [FILE]), archive('B', 'B.ba2', [FILE])]);

    expect([...stack].map(({ relativePath }) => relativePath)).toEqual([FILE]);
  });

  it('holds no copy of an archive the game does not load, which gives the game no file', () => {
    const stack = stacked({ A: ['A.ba2'] }, []);

    expect([...stack]).toEqual([]);
  });

  it('keeps a copy of a loaded archive it cannot read under its own name, what it holds being unknown', () => {
    const stack = stacked({ A: ['A.ba2'] }, [archive('A', 'A.ba2', undefined)]);

    expect([...stack].map(({ relativePath }) => relativePath)).toEqual(['A.ba2']);
  });

  it('finds an archived copy of a loose file whatever its case', () => {
    const stack = stacked({ A: [FILE], B: ['B.ba2'] }, [archive('B', 'B.ba2', [FILE.toUpperCase()])]);

    expect(stack.get(FILE)?.copies.map(({ origin }) => origin)).toEqual([modOrigin('A'), modOrigin('B')]);
  });

  it('keeps each loose copy at the path its origin holds it at, whatever the case of the file\'s name', () => {
    const stack = stacked({ A: ['Textures/Shared.dds'], B: ['textures/shared.DDS'] }, []);

    expect(stack.get('textures/shared.dds')?.copies.map(({ at }) => at)).toEqual([
      { kind: 'loose', path: modPath('A', 'Textures/Shared.dds') }, { kind: 'loose', path: modPath('B', 'textures/shared.DDS') },
    ]);
  });

  it('keeps Overwrite\'s copy apart from the copy of a mod named overwrite (ADR-0012)', () => {
    const stack = stackReusing()(indexOver([mod('overwrite')], { overwrite: [FILE] }, [fileIn('/overwrite', FILE)]), [], 'Fallout4');

    expect(stack.get(FILE)?.copies.map(({ at }) => at)).toEqual([
      { kind: 'loose', path: `/overwrite/${FILE}` }, { kind: 'loose', path: modPath('overwrite', FILE) },
    ]);
  });

  interface Stacking { entries: ModlistEntry[]; overwrite: OriginFile[]; modFiles: Map<string, OriginFiles>; loaded: LoadedArchive[] }
  const stacking = (): Stacking => ({
    entries: [mod('A'), mod('B'), mod('C')],
    overwrite: [],
    modFiles: new Map([['A', listing('A', [FILE, 'A.ba2', 'a.nif'])], ['B', listing('B', ['B.ba2', 'b.nif'])], ['C', listing('C', [FILE, 'C.ba2'])]]),
    loaded: [archive('A', 'A.ba2', [FILE, 'other.nif']), archive('B', 'B.ba2', [FILE, 'other.nif']), archive('C', 'C.ba2', ['c.nif'])],
  });
  const withFiles = (name: string, paths: string[]) => (was: Stacking): Stacking => ({ ...was, modFiles: new Map(was.modFiles).set(name, listing(name, paths)) });
  const withLoaded = (...loaded: LoadedArchive[]) => (was: Stacking): Stacking => ({ ...was, loaded });
  const stackWith = (index: typeof buildFileConflictIndex, stack: ReturnType<typeof stackReusing>, { entries, overwrite, modFiles, loaded }: Stacking) =>
    stack(index(entries, overwrite, modFiles), loaded, 'Fallout4');

  it.each<[string, (was: Stacking) => Stacking]>([
    ['the winning loose copy goes, and its mod\'s archived copy shows', withFiles('A', ['A.ba2', 'a.nif'])],
    ['a mod gains a loose copy of a path an archive holds', withFiles('B', ['B.ba2', 'b.nif', 'other.nif'])],
    ['a mod gains a case variant of a loose path', withFiles('C', [FILE.toUpperCase(), 'C.ba2'])],
    ['a mod is disabled', (was) => ({ ...was, entries: [mod('A', false), mod('B'), mod('C')] })],
    ['a mod moves to the winning end', (was) => ({ ...was, entries: [mod('C'), mod('A'), mod('B')] })],
    ['a mod is added', (was) => ({ ...withFiles('D', [FILE])(was), entries: [mod('D'), ...was.entries] })],
    ['Overwrite gains a copy', (was) => ({ ...was, overwrite: [fileIn('/overwrite', 'other.nif')] })],
    ['an archive is loaded', (was) => withLoaded(...was.loaded, archive('B', 'B - Extra.ba2', ['other.nif']))(withFiles('B', ['B.ba2', 'B - Extra.ba2', 'b.nif'])(was))],
    ['the game loads one archive fewer', (was) => withLoaded(...was.loaded.slice(1))(was)],
    ['an archive cannot be read', (was) => withLoaded(archive('A', 'A.ba2', undefined), ...was.loaded.slice(1))(was)],
    ['an archive holds other files', (was) => withLoaded(archive('A', 'A.ba2', ['other.nif', 'c.nif']), ...was.loaded.slice(1))(was)],
    ['the archives load in another order', (was) => withLoaded(...[...was.loaded].reverse())(was)],
  ])('stacks what a stack built afresh does when %s', (_case, change) => {
    const [index, stack] = [indexReusing(), stackReusing()];
    const was = stacking();
    stackWith(index, stack, was);
    const now = change(was);

    expect([...stackWith(index, stack, now)].sort(byPath)).toEqual([...stackWith(buildFileConflictIndex, stackReusing(), now)].sort(byPath));
  });

  it('keeps the copies of each file a change leaves as they were the objects they were', () => {
    const [index, stack] = [indexReusing(), stackReusing()];
    const was = stacking();
    const first = stackWith(index, stack, was);
    const next = stackWith(index, stack, withLoaded(archive('A', 'A.ba2', [FILE, 'other.nif', 'a2.nif']), ...was.loaded.slice(1))(withFiles('A', ['A.ba2', 'a.nif'])(was)));

    expect(next.get('b.nif')).toBe(first.get('b.nif'));
    expect(next.get('c.nif')).toBe(first.get('c.nif'));
    expect(next.get('other.nif')).toBe(first.get('other.nif'));
  });

  it('answers the stack it built while the index and what every archive holds are the same', () => {
    const build = stackReusing();
    const index = indexOver([mod('A')], { A: ['A.ba2'] });
    const first = build(index, [archive('A', 'A.ba2', [FILE])], 'Fallout4');

    expect(build(index, [archive('A', 'A.ba2', [FILE])], 'Fallout4')).toBe(first);
    expect(build(index, [archive('A', 'A.ba2', [FILE, 'other.nif'])], 'Fallout4')).not.toBe(first);
  });
});

describe('how an origin\'s copies stand against the others\' (mods.md, Indicators)', () => {
  const everyPath = (stack: ReturnType<ReturnType<typeof stackReusing>>): string[] => [...stack].map(({ relativePath }) => relativePath);

  it('is Redundant for a mod whose loaded archive loses every file it holds', () => {
    const FILE = 'meshes/shared.nif';
    const index = indexOver([mod('A'), mod('B')], { A: ['A.ba2', FILE], B: ['B.ba2'] });
    const stack = stackReusing()(index, [{ origin: modOrigin('B'), archive: modPath('B', 'B.ba2'), files: [FILE] }], 'Fallout4');

    expect([copyStandingOf(stack, modOrigin('A'), everyPath(stack)).redundant, copyStandingOf(stack, modOrigin('B'), everyPath(stack)).redundant]).toEqual([false, true]);
  });

  it('is Redundant for a mod whose every other file loses, an archive the game does not load keeping it from nothing', () => {
    const FILE = 'meshes/shared.nif';
    const index = indexOver([mod('A'), mod('B')], { A: ['A.ba2', FILE], B: [FILE, 'B.ba2'] });
    const stack = stackReusing()(index, [], 'Fallout4');

    expect([copyStandingOf(stack, modOrigin('A'), everyPath(stack)).redundant, copyStandingOf(stack, modOrigin('B'), everyPath(stack)).redundant]).toEqual([false, true]);
  });

  type Kind = 'loose' | 'archived';
  type Stacks = Record<string, ReadonlyArray<readonly [Kind, string]>>;
  const standing = (stacks: Stacks, own: string) => {
    const stack = new FileConflictLookup<StackedFile>();
    for (const [relativePath, copies] of Object.entries(stacks)) {
      stack.set({
        relativePath,
        copies: copies.map(([kind, name]) => ({
          origin: modOrigin(name),
          at: kind === 'loose' ? { kind, path: modPath(name, relativePath) } : { kind, gameRelease: 'Fallout4', archive: modPath(name, 'x.ba2'), file: relativePath },
        })),
      });
    }
    return copyStandingOf(stack, modOrigin(own), Object.keys(stacks));
  };
  const NONE = {
    overwritesLooseFiles: false, overwrittenLooseFiles: false, overwritesArchiveWithLooseFiles: false, archiveOverwrittenByLooseFiles: false,
    overwritesAnotherArchiveFile: false, overwrittenByAnotherArchiveFile: false, redundant: false,
  };

  it.each<[string, Stacks, string, Partial<typeof NONE>]>([
    ['a loose copy over a loose copy', { a: [['loose', 'A'], ['loose', 'B']] }, 'A', { overwritesLooseFiles: true }],
    ['a loose copy under a loose copy', { a: [['loose', 'A'], ['loose', 'B']] }, 'B', { redundant: true }],
    ['a loose copy over an archived copy', { a: [['loose', 'A'], ['archived', 'B']] }, 'A', { overwritesArchiveWithLooseFiles: true }],
    ['an archived copy under a loose copy', { a: [['loose', 'A'], ['archived', 'B']] }, 'B', { redundant: true }],
    ['an archived copy over an archived copy', { a: [['archived', 'A'], ['archived', 'B']] }, 'A', { overwritesAnotherArchiveFile: true }],
    ['an archived copy under an archived copy', { a: [['archived', 'A'], ['archived', 'B']] }, 'B', { redundant: true }],
    ['a copy nobody else has', { a: [['loose', 'A']] }, 'A', {}],
    ['a copy of a mod with no copy there', { a: [['loose', 'A'], ['loose', 'B']] }, 'C', {}],
    ['a loose copy under a loose copy of one file and over one of another', { a: [['loose', 'A'], ['loose', 'B']], b: [['loose', 'B'], ['loose', 'A']] }, 'B',
      { overwritesLooseFiles: true, overwrittenLooseFiles: true }],
    ['an archived copy under a loose copy of one file and over an archived copy of another', { a: [['loose', 'A'], ['archived', 'B']], b: [['archived', 'B'], ['archived', 'C']] }, 'B',
      { archiveOverwrittenByLooseFiles: true, overwritesAnotherArchiveFile: true }],
    ['an archived copy under an archived copy of one file and over one of another', { a: [['archived', 'A'], ['archived', 'B']], b: [['archived', 'B'], ['archived', 'A']] }, 'B',
      { overwritesAnotherArchiveFile: true, overwrittenByAnotherArchiveFile: true }],
  ])('%s', (_case, stacks, own, held) => {
    expect(standing(stacks, own)).toEqual({ ...NONE, ...held });
  });

  it('is Redundant only when every file the mod could get loses, and carries no losing badge then', () => {
    expect(standing({ won: [['loose', 'B'], ['loose', 'A']], lost: [['loose', 'A'], ['loose', 'B']] }, 'B')).toEqual({ ...NONE, overwritesLooseFiles: true, overwrittenLooseFiles: true });
  });
});
