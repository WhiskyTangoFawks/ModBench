import { describe, it, expect, vi } from 'vitest';
import type { Mod, Separator } from '../instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import {
  buildFileConflictIndex, modOrigin, goToModCandidates, inFileOrderConflict, fileOrderConflictOf, outranksACopy, winsPath, RUNTIME_OUTPUT, type ConflictEntry,
} from '../fileConflictIndex';
import type { OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { OVERWRITE_ORIGIN } from '../loadOrderSnapshot';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { modFilesOf, sourceOver } from '../../test/mo2/adapterOver';
import { fileIn } from '../../test/fakeInstanceAdapter';

const modPath = (name: string, relativePath: string): string => `/mods/${name}/${relativePath}`;

const indexOver = (entries: ModlistEntry[], filesByMod: Record<string, string[]>, overwrite: OriginFile[] = []) =>
  buildFileConflictIndex(entries, overwrite, new Map(Object.entries(filesByMod).map(([name, paths]) => [name, {
    origin: name, folder: `/mods/${name}`, folders: [], notes: [], files: paths.map((path) => fileIn(`/mods/${name}`, path)),
  }])), () => {});

const SHARED = 'textures/shared/foo.dds';
const conflicting = { ModA: [SHARED], ModB: [SHARED, 'meshes/onlyB.nif'] };
const caseConflicting = { ModA: ['Textures/Foo.dds'], ModB: ['textures/foo.dds'], RootA: ['Foo.esp'], RootB: ['foo.ESP'] };

const answering = (names: readonly string[], answer: Omit<OriginFiles, 'origin'>): ReadonlyMap<string, OriginFiles> =>
  new Map(names.map((name) => [name, { origin: name, ...answer }]));

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('buildFileConflictIndex', () => {
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

  it('lists nested subdirectory relative paths through the index\'s iteration surface', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], conflicting);
    const paths = [...index.files].map((e) => e.relativePath);
    expect(paths).toContain('meshes/onlyB.nif');
    expect(paths).toContain('textures/shared/foo.dds');
  });

  it('excludes an enabled separator from the index — a separator is not a mod, even though it also carries `enabled`', () => {
    const index = indexOver([separator('Unassigned'), mod('ModA'), mod('ModB')], conflicting);
    expect(index.filesByMod.has('Unassigned')).toBe(false);
    expect(index.files.get('textures/shared/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModA'));
  });
});

describe('buildFileConflictIndex — Overwrite is the winning-most provider', () => {
  const overwriteCopy = { relativePath: 'textures/shared/foo.dds', path: '/instance/overwrite/textures/shared/foo.dds', sourcePath: '/instance/overwrite/textures/shared/foo.dds', excluded: false, excludedByName: false };

  it('wins a path over every mod that provides it, and is listed as a provider', () => {
    const index = indexOver([mod('ModA'), mod('ModB')], conflicting, [overwriteCopy]);

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winner).toBe(overwriteCopy.path);
    expect(entry?.winnerOrigin).toEqual({ kind: 'runtimeOutput' });
    expect(entry?.providers).toEqual([{ kind: 'runtimeOutput' }, modOrigin('ModA'), modOrigin('ModB')]);
  });

  it('is the sole provider of a path no mod ships', () => {
    const index = indexOver([mod('ModA')], conflicting, [{ relativePath: 'only.txt', path: '/o/only.txt', sourcePath: '/o/only.txt', excluded: false, excludedByName: false }]);
    expect(index.files.get('only.txt')).toMatchObject({ winnerOrigin: { kind: 'runtimeOutput' }, providers: [{ kind: 'runtimeOutput' }] });
  });

  it('keeps Overwrite out of every mod\'s own files', () => {
    const index = indexOver([mod('ModA')], conflicting, [overwriteCopy]);
    expect(index.filesByMod.has(OVERWRITE_ORIGIN)).toBe(false);
  });

  it('tells Overwrite from a mod folder named overwrite: that mod loses to Overwrite', () => {
    const entries = [mod(OVERWRITE_ORIGIN)];
    const sharing = { relativePath: 'a.dds', path: '/instance/overwrite/a.dds', sourcePath: '/instance/overwrite/a.dds', excluded: false, excludedByName: false };
    const index = buildFileConflictIndex(
      entries, [sharing], answering([OVERWRITE_ORIGIN], { folder: '/mods/overwrite', files: [{ relativePath: 'a.dds', path: '/mods/overwrite/a.dds', sourcePath: '/mods/overwrite/a.dds', excluded: false, excludedByName: false }], folders: [], notes: [] }), () => {},
    );
    expect(index.files.get('a.dds')?.winner).toBe(sharing.path);
    expect(index.files.get('a.dds')?.winnerOrigin).toEqual({ kind: 'runtimeOutput' });
    expect(index.files.get('a.dds')?.providers).toEqual([{ kind: 'runtimeOutput' }, modOrigin(OVERWRITE_ORIGIN)]);
  });
});

describe('buildFileConflictIndex — case-insensitive conflicts, as Proton/Wine folds case over case-sensitive ext4', () => {
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
    const variant = (root: string, relativePath: string) => ({ relativePath, path: `${root}/${relativePath}`, sourcePath: `${root}/${relativePath}`, excluded: false, excludedByName: false });
    const index = buildFileConflictIndex(
      [mod('ModA'), mod('ModB')],
      [variant('/overwrite', 'Textures/Foo.dds'), variant('/overwrite', 'textures/foo.dds')],
      new Map([
        ['ModA', { origin: 'ModA', folder: '/mods', folders: [], notes: [], files: [variant('/mods/ModA', 'Textures/Foo.dds'), variant('/mods/ModA', 'textures/foo.dds')] }],
        ['ModB', { origin: 'ModB', folder: '/mods', folders: [], notes: [], files: [variant('/mods/ModB', 'textures/foo.dds')] }],
      ]),
      () => {},
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

describe('buildFileConflictIndex — what the reading holds: the walk is the adapter\'s, and a note for a skipped entry is an Output line, never a silent skip', () => {
  it('logs each entry the listing skipped, naming its mod', () => {
    const log = vi.fn();

    buildFileConflictIndex([mod('ModA')], [], answering(['ModA'], { folder: '/mods/ModA', files: [], folders: [], notes: ['broken link "/mods/ModA/x.dds", skipped'] }), log);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ModA.*broken link "\/mods\/ModA\/x\.dds", skipped/));
  });

  it('takes no excluded file as a provider, in a mod or Overwrite, and keeps it among its mod\'s files', () => {
    const excluded = { relativePath: 'Hidden.esp', path: '/mods/ModA/Hidden.esp', sourcePath: '/mods/ModA/Hidden.esp', excluded: true, excludedByName: true };
    const kept = { relativePath: 'Kept.esp', path: '/mods/ModA/Kept.esp', sourcePath: '/mods/ModA/Kept.esp', excluded: false, excludedByName: false };
    const overwritten = { relativePath: 'Hidden.esp', path: '/overwrite/Hidden.esp', sourcePath: '/overwrite/Hidden.esp', excluded: true, excludedByName: true };
    const index = buildFileConflictIndex(
      [mod('ModA')], [overwritten], answering(['ModA'], { folder: '/mods/ModA', files: [excluded, kept], folders: [], notes: [] }), () => {},
    );

    expect([...index.files].map((entry) => entry.relativePath)).toEqual(['Kept.esp']);
    expect(index.filesByMod.get('ModA')).toEqual([excluded, kept]);
  });

  it('keeps each file where the adapter says it sits and is read from, and each folder where it sits', () => {
    const linked = { relativePath: 'x/linked.dds', path: '/mods/ModA/x/linked.dds', sourcePath: '/shared/real.dds', excluded: false, excludedByName: false };
    const folder = { relativePath: 'x', path: '/mods/ModA/x', excluded: false };
    const index = buildFileConflictIndex(
      [mod('ModA')], [], answering(['ModA'], { folder: '/mods/ModA', files: [linked], folders: [folder], notes: [] }), () => {},
    );

    expect(index.files.get('x/linked.dds')?.winner).toBe('/shared/real.dds');
    expect(index.filesByMod.get('ModA')).toEqual([linked]);
    expect(index.foldersByMod.get('ModA')).toEqual([folder]);
  });
});

const litrInstance = process.env.MEDIT_LITR_INSTANCE ?? '';
const litrProfile = 'Life in the Ruins';

describe.skipIf(litrInstance === '')('buildFileConflictIndex — real LitR instance (opt-in), proving the override-order direction against a real MO2 instance rather than synthetic fixtures', () => {
  const fixName = 'Pipboy Arm Fix for Grafs Assaultron Armor';
  const baseName = "Graf's Assaultron Armor";
  const contested = [
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavyf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavym.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumm.nif',
  ];

  it('a fix patch positioned above the mod it fixes wins the meshes they both ship, a real conflict that is an oracle independent of this codebase\'s own logic', async () => {
    const litr = sourceOver(litrInstance);
    const entries = await litr.modOrder(litrProfile);
    const fixEntry = entries.find((e) => e.kind === 'mod' && e.name === fixName);
    const baseEntry = entries.find((e) => e.kind === 'mod' && e.name === baseName);
    if (!fixEntry?.enabled || !baseEntry?.enabled) {
      throw new Error(
        `LitR fixture assumption broken: expected both "${fixName}" and "${baseName}" present and enabled in modlist.txt`,
      );
    }

    const index = buildFileConflictIndex(entries, [], await modFilesOf(litr, entries), () => {});
    for (const relativePath of contested) {
      const entry = index.files.get(relativePath);
      expect(entry?.providers).toEqual([modOrigin(fixName), modOrigin(baseName)]);
      expect(entry?.winnerOrigin).toEqual(modOrigin(fixName));
    }
  });
});

const entryOf = (...providers: ConflictEntry['providers']): ConflictEntry => ({
  relativePath: 'textures/a.dds', winner: '/w', winnerOrigin: providers[0] ?? RUNTIME_OUTPUT, providers,
});
const high = modOrigin('High');
const middle = modOrigin('Middle');
const low = modOrigin('Low');

describe('the origins go to mod can name for a copy of a file', () => {
  it('is the winning copy for a copy that loses', () => {
    expect(goToModCandidates(entryOf(high, middle, low), middle)).toEqual([high]);
  });

  it('is every copy the winning copy wins over, in the order the index lists them', () => {
    expect(goToModCandidates(entryOf(high, middle, low), high)).toEqual([middle, low]);
  });

  it('is Overwrite as the winner of a mod copy it wins over', () => {
    expect(goToModCandidates(entryOf(RUNTIME_OUTPUT, low), low)).toEqual([RUNTIME_OUTPUT]);
  });

  it('is nothing for a copy nothing else provides, a copy that is no provider, and a path no one provides', () => {
    expect(goToModCandidates(entryOf(high), high)).toEqual([]);
    expect(goToModCandidates(entryOf(high, middle), low)).toEqual([]);
    expect(goToModCandidates(undefined, high)).toEqual([]);
  });

  it('tells a mod folder named overwrite from Overwrite', () => {
    const folderNamedOverwrite = modOrigin('overwrite');
    expect(goToModCandidates(entryOf(RUNTIME_OUTPUT, folderNamedOverwrite), folderNamedOverwrite)).toEqual([RUNTIME_OUTPUT]);
  });
});

describe('whether a copy of a file is in a file order conflict', () => {
  it('is, for a copy another enabled copy or Overwrite also provides, winning or losing', () => {
    expect(inFileOrderConflict(entryOf(high, low), high)).toBe(true);
    expect(inFileOrderConflict(entryOf(high, low), low)).toBe(true);
    expect(inFileOrderConflict(entryOf(RUNTIME_OUTPUT, low), low)).toBe(true);
  });

  it('is not, for a copy nothing else provides, a copy that is no provider, and a path no one provides', () => {
    expect(inFileOrderConflict(entryOf(high), high)).toBe(false);
    expect(inFileOrderConflict(entryOf(high, middle), low)).toBe(false);
    expect(inFileOrderConflict(undefined, high)).toBe(false);
  });
});

describe('whether a copy of a file wins or loses its file order conflict', () => {
  it('wins, for the winner of a path another copy provides, and loses, for a provider that is not', () => {
    expect(fileOrderConflictOf(entryOf(high, low), high)).toBe('wins');
    expect(fileOrderConflictOf(entryOf(RUNTIME_OUTPUT, high), RUNTIME_OUTPUT)).toBe('wins');
    expect(fileOrderConflictOf(entryOf(high, low), low)).toBe('loses');
    expect(fileOrderConflictOf(entryOf(RUNTIME_OUTPUT, high), high)).toBe('loses');
  });

  it('is none, for a copy no other copy conflicts with, and a path no one provides', () => {
    expect(fileOrderConflictOf(entryOf(high), high)).toBe('none');
    expect(fileOrderConflictOf(entryOf(high, middle), low)).toBe('none');
    expect(fileOrderConflictOf(undefined, high)).toBe('none');
  });
});

describe('whether a copy of a file wins the path or outranks a copy', () => {
  it('wins the path when it is the winner, and not when another copy is', () => {
    expect(winsPath(entryOf(high), high)).toBe(true);
    expect(winsPath(entryOf(high, low), low)).toBe(false);
    expect(winsPath(undefined, high)).toBe(false);
  });

  it('outranks a copy when a lower copy provides the path, winning the path or not', () => {
    expect(outranksACopy(entryOf(high, middle, low), high)).toBe(true);
    expect(outranksACopy(entryOf(high, middle, low), middle)).toBe(true);
    expect(outranksACopy(entryOf(high, middle, low), low)).toBe(false);
  });

  it('outranks none for a sole copy, a copy that is no provider, and a path no one provides', () => {
    expect(outranksACopy(entryOf(high), high)).toBe(false);
    expect(outranksACopy(entryOf(high, middle), low)).toBe(false);
    expect(outranksACopy(undefined, high)).toBe(false);
  });
});
