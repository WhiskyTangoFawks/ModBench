import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { Mod, Separator, ModlistEntry } from '../instance';
import {
  buildFileConflictIndex, modOrigin, rootLevelWinners, foldPath, goToModCandidates, RUNTIME_OUTPUT, type ConflictEntry,
} from '../fileConflictIndex';
import { computeModStatuses } from '../statusChecker';
import type { InstanceAdapter, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { OVERWRITE_ORIGIN } from '../loadOrderSnapshot';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { adapterOver } from '../../test/mo2/adapterOver';

const fixtureRoot = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'conflict-instance');
const caseFixtureRoot = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'case-conflict-instance');
const fixture = adapterOver(fixtureRoot);
const caseFixture = adapterOver(caseFixtureRoot);

const answering = (answer: Omit<OriginFiles, 'origin'>): Pick<InstanceAdapter, 'originFiles'> => ({
  originFiles: (origin) => Promise.resolve({ origin: origin.kind === 'mod' ? origin.name : 'overwrite', ...answer }),
});

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the first enabled mod, modlist.txt being winning-first', async () => {
    const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];
    const index = await buildFileConflictIndex(entries, [], fixture, () => {});

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModA'));
    expect(entry?.winner).toBe(join(fixtureRoot, 'mods', 'ModA', 'textures', 'shared', 'foo.dds'));
    expect(entry?.providers).toEqual([modOrigin('ModA'), modOrigin('ModB')]);
  });

  it('flips the winner when the mods are reordered', async () => {
    const index = await buildFileConflictIndex([mod('ModB'), mod('ModA')], [], fixture, () => {});
    expect(index.files.get('textures/shared/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('excludes disabled mods from conflict resolution', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], [], fixture, () => {});
    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.providers).toEqual([modOrigin('ModB')]);
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('lists a disabled mod\'s own files under filesByMod, as an enabled mod\'s are, apart from conflict resolution', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], [], fixture, () => {});
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual(['textures/shared/foo.dds']);
    expect(index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort()).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });

  it('records a single-provider file with providers.length === 1', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], fixture, () => {});
    const entry = index.files.get('meshes/onlyB.nif');
    expect(entry?.providers).toEqual([modOrigin('ModB')]);
    expect(entry?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('lists nested subdirectory relative paths through the index\'s iteration surface', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], fixture, () => {});
    const paths = [...index.files].map((e) => e.relativePath);
    expect(paths).toContain('meshes/onlyB.nif');
    expect(paths).toContain('textures/shared/foo.dds');
  });

  it('groups each mod\'s own files under filesByMod', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], fixture, () => {});
    const modBFiles = index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort();
    expect(modBFiles).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });

  it('excludes an enabled separator from the index — a separator is not a mod, even though it also carries `enabled`', async () => {
    const index = await buildFileConflictIndex([separator('Unassigned'), mod('ModA'), mod('ModB')], [], fixture, () => {});
    expect(index.filesByMod.has('Unassigned')).toBe(false);
    expect(index.files.get('textures/shared/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModA'));
  });
});

describe('buildFileConflictIndex — Overwrite is the winning-most provider', () => {
  const overwriteCopy = { relativePath: 'textures/shared/foo.dds', path: '/instance/overwrite/textures/shared/foo.dds', sourcePath: '/instance/overwrite/textures/shared/foo.dds', excluded: false };

  it('wins a path over every mod that provides it, and is listed as a provider', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [overwriteCopy], fixture, () => {});

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winner).toBe(overwriteCopy.path);
    expect(entry?.winnerOrigin).toEqual({ kind: 'runtimeOutput' });
    expect(entry?.providers).toEqual([{ kind: 'runtimeOutput' }, modOrigin('ModA'), modOrigin('ModB')]);
  });

  it('is the sole provider of a path no mod ships', async () => {
    const index = await buildFileConflictIndex([mod('ModA')], [{ relativePath: 'only.txt', path: '/o/only.txt', sourcePath: '/o/only.txt', excluded: false }], fixture, () => {});
    expect(index.files.get('only.txt')).toMatchObject({ winnerOrigin: { kind: 'runtimeOutput' }, providers: [{ kind: 'runtimeOutput' }] });
  });

  it('keeps Overwrite out of every mod\'s own files', async () => {
    const index = await buildFileConflictIndex([mod('ModA')], [overwriteCopy], fixture, () => {});
    expect(index.filesByMod.has(OVERWRITE_ORIGIN)).toBe(false);
  });

  it('badges a mod whose file Overwrite wins as conflicting, never as overriding', async () => {
    const entries = [mod('ModA'), mod('ModB')];
    const index = await buildFileConflictIndex(entries, [overwriteCopy], fixture, () => {});
    expect(computeModStatuses(entries, index).get('ModA')?.status).toEqual({ kind: 'conflicts', count: 1 });
  });

  it('tells Overwrite from a mod folder named overwrite: that mod loses to Overwrite', async () => {
    const entries = [mod(OVERWRITE_ORIGIN)];
    const sharing = { relativePath: 'a.dds', path: '/instance/overwrite/a.dds', sourcePath: '/instance/overwrite/a.dds', excluded: false };
    const index = await buildFileConflictIndex(
      entries, [sharing], answering({ folder: '/mods/overwrite', files: [{ relativePath: 'a.dds', path: '/mods/overwrite/a.dds', sourcePath: '/mods/overwrite/a.dds', excluded: false }], folders: [], notes: [] }), () => {},
    );
    expect(index.files.get('a.dds')?.winner).toBe(sharing.path);
    expect(index.files.get('a.dds')?.winnerOrigin).toEqual({ kind: 'runtimeOutput' });
    expect(index.files.get('a.dds')?.providers).toEqual([{ kind: 'runtimeOutput' }, modOrigin(OVERWRITE_ORIGIN)]);
    expect(computeModStatuses(entries, index).get(OVERWRITE_ORIGIN)?.status).toEqual({ kind: 'conflicts', count: 1 });
  });
});

describe('buildFileConflictIndex — case-insensitive conflicts, as Proton/Wine folds case over case-sensitive ext4', () => {
  it('resolves case-variant paths from two mods to a single conflict entry with both providers', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], caseFixture, () => {});

    expect(index.files.size).toBe(1);
    const entry = index.files.get('Textures/Foo.dds');
    expect(entry?.providers).toEqual([modOrigin('ModA'), modOrigin('ModB')]);
    const entryOtherCasing = index.files.get('textures/foo.dds');
    expect(entryOtherCasing).toBe(entry);
  });

  it('picks the same winner by priority whether casing matches or varies', async () => {
    const top = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], caseFixture, () => {});
    expect(top.files.get('textures/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModA'));

    const flipped = await buildFileConflictIndex([mod('ModB'), mod('ModA')], [], caseFixture, () => {});
    expect(flipped.files.get('textures/foo.dds')?.winnerOrigin).toEqual(modOrigin('ModB'));
  });

  it('keeps the winner\'s own original casing in relativePath and winner, regardless of lookup casing', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], [], caseFixture, () => {});

    const entry = index.files.get('TEXTURES/FOO.DDS');
    expect(entry?.relativePath).toBe('Textures/Foo.dds');
    expect(entry?.winner).toBe(join(caseFixtureRoot, 'mods', 'ModA', 'Textures', 'Foo.dds'));
  });

  it('rootLevelWinners folds a case-variant root-level plugin pair to one winner', async () => {
    const index = await buildFileConflictIndex([mod('RootA'), mod('RootB')], [], caseFixture, () => {});
    const winners = rootLevelWinners(index);

    expect(winners.size).toBe(1);
    expect(winners.get('foo.esp')).toBe(join(caseFixtureRoot, 'mods', 'RootA', 'Foo.esp'));
  });
});

describe('buildFileConflictIndex — what the adapter answers: the walk is the adapter\'s, and a note for a skipped entry is an Output line, never a silent skip', () => {
  it('logs each entry the adapter skipped, naming its mod', async () => {
    const log = vi.fn();

    await buildFileConflictIndex([mod('ModA')], [], answering({ folder: '/mods/ModA', files: [], folders: [], notes: ['broken link "/mods/ModA/x.dds", skipped'] }), log);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ModA.*broken link "\/mods\/ModA\/x\.dds", skipped/));
  });

  it('takes no excluded file as a provider, in a mod or Overwrite, and keeps it among its mod\'s files', async () => {
    const excluded = { relativePath: 'Hidden.esp', path: '/mods/ModA/Hidden.esp', sourcePath: '/mods/ModA/Hidden.esp', excluded: true };
    const kept = { relativePath: 'Kept.esp', path: '/mods/ModA/Kept.esp', sourcePath: '/mods/ModA/Kept.esp', excluded: false };
    const overwritten = { relativePath: 'Hidden.esp', path: '/overwrite/Hidden.esp', sourcePath: '/overwrite/Hidden.esp', excluded: true };
    const index = await buildFileConflictIndex(
      [mod('ModA')], [overwritten], answering({ folder: '/mods/ModA', files: [excluded, kept], folders: [], notes: [] }), () => {},
    );

    expect([...index.files].map((entry) => entry.relativePath)).toEqual(['Kept.esp']);
    expect(index.filesByMod.get('ModA')).toEqual([excluded, kept]);
  });

  it('keeps each file where the adapter says it sits and is read from, and each folder where it sits', async () => {
    const linked = { relativePath: 'x/linked.dds', path: '/mods/ModA/x/linked.dds', sourcePath: '/shared/real.dds', excluded: false };
    const folder = { relativePath: 'x', path: '/mods/ModA/x', excluded: false };
    const index = await buildFileConflictIndex(
      [mod('ModA')], [], answering({ folder: '/mods/ModA', files: [linked], folders: [folder], notes: [] }), () => {},
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
  const ESL_ANOTHER_ENABLED_MOD_ALSO_SHIPS = 1;
  const sameLineIgnoringCasing = (line: string, expected: string): boolean => foldPath(line) === foldPath(expected);
  const contested = [
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavyf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavym.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumm.nif',
  ];

  it('a fix patch positioned above the mod it fixes wins the meshes they both ship, a real conflict that is an oracle independent of this codebase\'s own logic — index and badge agree', async () => {
    const litr = adapterOver(litrInstance);
    const entries = await litr.modOrder(litrProfile);
    const fixEntry = entries.find((e) => e.kind === 'mod' && e.name === fixName);
    const baseEntry = entries.find((e) => e.kind === 'mod' && e.name === baseName);
    if (!fixEntry?.enabled || !baseEntry?.enabled) {
      throw new Error(
        `LitR fixture assumption broken: expected both "${fixName}" and "${baseName}" present and enabled in modlist.txt`,
      );
    }

    const index = await buildFileConflictIndex(entries, [], litr, () => {});
    for (const relativePath of contested) {
      const entry = index.files.get(relativePath);
      expect(entry?.providers).toEqual([modOrigin(fixName), modOrigin(baseName)]);
      expect(entry?.winnerOrigin).toEqual(modOrigin(fixName));
    }

    const statuses = computeModStatuses([fixEntry, baseEntry], index);
    expect(statuses.get(fixName)?.status).toEqual({ kind: 'overrides', count: contested.length });
    expect(statuses.get(baseName)?.status).toEqual({ kind: 'conflicts', count: contested.length + ESL_ANOTHER_ENABLED_MOD_ALSO_SHIPS });
    for (const relativePath of contested) {
      expect(
        statuses
          .get(baseName)
          ?.conflictLines.some((line) => sameLineIgnoringCasing(line, `${relativePath} → winner: "${fixName}"`)),
      ).toBe(true);
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
