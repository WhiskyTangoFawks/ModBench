import { describe, it, expect } from 'vitest';
import type { Mod, Separator } from '../instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import {
  buildFileConflictIndex, modOrigin, goToModCandidates, inFileOrderConflict, fileOrderConflictOf, outranksACopy, winsPath, RUNTIME_OUTPUT, type ConflictEntry,
} from '../fileConflictIndex';
import type { FileOrigin, OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { fileIn } from '../../test/fakeInstanceAdapter';

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

  it('lists each path in the order its winner wins, Overwrite\'s first, then each mod\'s in mod order', () => {
    const index = indexOver([mod('ModB'), mod('ModA')], { ModA: ['a.nif', 'shared.nif'], ModB: ['b.nif', 'shared.nif'] }, [fileIn('/overwrite', 'o.nif')]);

    expect([...index.files].map((entry) => entry.relativePath)).toEqual(['o.nif', 'b.nif', 'shared.nif', 'a.nif']);
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
    const folder = { relativePath: 'x', path: '/mods/ModA/x', excluded: false };
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

describe('whether a copy of a file is in a file order conflict', () => {
  it.each<[string, ConflictEntry | undefined, FileOrigin, boolean]>([
    ['is, for the winner of a path another enabled copy provides', entryOf(high, low), high, true],
    ['is, for a copy that loses to another enabled copy', entryOf(high, low), low, true],
    ['is, for a copy that loses to Overwrite', entryOf(RUNTIME_OUTPUT, low), low, true],
    ['is not, for a copy nothing else provides', entryOf(high), high, false],
    ['is not, for a copy that is no provider', entryOf(high, middle), low, false],
    ['is not, for a path no one provides', undefined, high, false],
  ])('%s', (_case, entry, own, expected) => {
    expect(inFileOrderConflict(entry, own)).toBe(expected);
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

describe('whether a copy of a file wins the path', () => {
  it.each<[string, ConflictEntry | undefined, FileOrigin, boolean]>([
    ['wins it as the winner', entryOf(high), high, true],
    ['does not when another copy is the winner', entryOf(high, low), low, false],
    ['does not for a path no one provides', undefined, high, false],
  ])('%s', (_case, entry, own, expected) => {
    expect(winsPath(entry, own)).toBe(expected);
  });
});

describe('whether a copy of a file outranks a copy', () => {
  it.each<[string, ConflictEntry | undefined, FileOrigin, boolean]>([
    ['outranks one as the winner over a lower copy', entryOf(high, middle, low), high, true],
    ['outranks one as a losing copy over a lower copy', entryOf(high, middle, low), middle, true],
    ['outranks none as the lowest copy', entryOf(high, middle, low), low, false],
    ['outranks none for a sole copy', entryOf(high), high, false],
    ['outranks none for a copy that is no provider', entryOf(high, middle), low, false],
    ['outranks none for a path no one provides', undefined, high, false],
  ])('%s', (_case, entry, own, expected) => {
    expect(outranksACopy(entry, own)).toBe(expected);
  });
});
