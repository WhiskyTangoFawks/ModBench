import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { Mod, Separator, ModlistEntry } from '../instance';
import { buildFileConflictIndex, rootLevelWinners, foldPath } from '../fileConflictIndex';
import { computeModStatuses } from '../statusChecker';
import type { InstanceAdapter, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { adapterOver } from '../../test/mo2/adapterOver';

const fixtureRoot = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'conflict-instance');
const caseFixtureRoot = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'case-conflict-instance');
const fixture = adapterOver(fixtureRoot);
const caseFixture = adapterOver(caseFixtureRoot);

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the topmost (winning) mod', async () => {
    // modlist.txt is winning-first, so ModA — the array's first enabled mod — wins over ModB.
    const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];
    const index = await buildFileConflictIndex(entries, fixture, () => {});

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winnerMod).toBe('ModA');
    expect(entry?.winner).toBe(join(fixtureRoot, 'mods', 'ModA', 'textures', 'shared', 'foo.dds'));
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
  });

  it('flips the winner when the mods are reordered', async () => {
    const index = await buildFileConflictIndex([mod('ModB'), mod('ModA')], fixture, () => {});
    expect(index.files.get('textures/shared/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('excludes disabled mods from conflict resolution', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], fixture, () => {});
    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
    expect(index.filesByMod.has('ModA')).toBe(false);
  });

  // ADR-0013, invariant 2: the snapshot names every plugin, disabled mods' included, so their
  // files are still read — into their own map, apart from conflict resolution.
  it('lists a disabled mod\'s own files under disabledModFiles', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], fixture, () => {});
    const modAFiles = index.disabledModFiles.get('ModA')?.map((f) => f.relativePath).sort();
    expect(modAFiles).toEqual(['textures/shared/foo.dds']);
    expect(index.disabledModFiles.has('ModB')).toBe(false);
  });

  it('records a single-provider file with providers.length === 1', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    const entry = index.files.get('meshes/onlyB.nif');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
  });

  it('resolves nested subdirectory relative paths correctly', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    // Iteration surface: entries carry their own original-cased relativePath,
    // not raw (possibly folded) Map keys.
    const paths = [...index.files].map((e) => e.relativePath);
    expect(paths).toContain('meshes/onlyB.nif');
    expect(paths).toContain('textures/shared/foo.dds');
  });

  it('groups each mod\'s own files under filesByMod', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    const modBFiles = index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort();
    expect(modBFiles).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });

  it('excludes an enabled separator from the index — a separator is not a mod, even though it also carries `enabled`', async () => {
    const index = await buildFileConflictIndex([separator('Unassigned'), mod('ModA'), mod('ModB')], fixture, () => {});
    expect(index.filesByMod.has('Unassigned')).toBe(false);
    expect(index.files.get('textures/shared/foo.dds')?.winnerMod).toBe('ModA');
  });
});

// Proton/Wine folds case over case-sensitive ext4, so case-variant paths must resolve to one
// conflict entry with a deterministic winner.
describe('buildFileConflictIndex — case-insensitive conflicts', () => {
  it('resolves case-variant paths from two mods to a single conflict entry with both providers', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});

    expect(index.files.size).toBe(1);
    const entry = index.files.get('Textures/Foo.dds'); // look up via either casing
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
    const entryOtherCasing = index.files.get('textures/foo.dds');
    expect(entryOtherCasing).toBe(entry);
  });

  it('picks the same winner by priority whether casing matches or varies', async () => {
    const top = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});
    expect(top.files.get('textures/foo.dds')?.winnerMod).toBe('ModA');

    const flipped = await buildFileConflictIndex([mod('ModB'), mod('ModA')], caseFixture, () => {});
    expect(flipped.files.get('textures/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('keeps the winner\'s own original casing in relativePath and winner, regardless of lookup casing', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});

    const entry = index.files.get('TEXTURES/FOO.DDS'); // deliberately different casing again
    expect(entry?.relativePath).toBe('Textures/Foo.dds'); // ModA's own casing (it won)
    expect(entry?.winner).toBe(join(caseFixtureRoot, 'mods', 'ModA', 'Textures', 'Foo.dds'));
  });

  it('rootLevelWinners folds a case-variant root-level plugin pair to one winner', async () => {
    const index = await buildFileConflictIndex([mod('RootA'), mod('RootB')], caseFixture, () => {});
    const winners = rootLevelWinners(index);

    expect(winners.size).toBe(1);
    expect(winners.get('foo.esp')).toBe(join(caseFixtureRoot, 'mods', 'RootA', 'Foo.esp'));
  });
});

// The walk is the adapter's: each enabled mod's files arrive with a note for every entry the
// listing skipped, and a note is an Output line, never a silent skip.
describe('buildFileConflictIndex — what the adapter answers', () => {
  const answering = (answer: Omit<OriginFiles, 'origin'>): Pick<InstanceAdapter, 'originFiles'> => ({
    originFiles: (origin) => Promise.resolve({ origin: origin.kind === 'mod' ? origin.name : 'overwrite', ...answer }),
  });

  it('logs each entry the adapter skipped, naming its mod', async () => {
    const log = vi.fn();

    await buildFileConflictIndex([mod('ModA')], answering({ folder: '/mods/ModA', files: [], notes: ['broken link "/mods/ModA/x.dds", skipped'] }), log);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ModA.*broken link "\/mods\/ModA\/x\.dds", skipped/));
  });

  it('keeps each file where the adapter says it is read from', async () => {
    const index = await buildFileConflictIndex(
      [mod('ModA')], answering({ folder: '/mods/ModA', files: [{ relativePath: 'linked.dds', path: '/shared/real.dds' }], notes: [] }), () => {},
    );

    expect(index.files.get('linked.dds')?.winner).toBe('/shared/real.dds');
    expect(index.filesByMod.get('ModA')).toEqual([{ relativePath: 'linked.dds', absolutePath: '/shared/real.dds' }]);
  });
});

// Proves the override-order direction against a REAL MO2 instance, not synthetic fixtures.
// Opt-in: runs only when MEDIT_LITR_INSTANCE names a LitR instance.
const litrInstance = process.env.MEDIT_LITR_INSTANCE ?? '';
const litrProfile = 'Life in the Ruins';

describe.skipIf(litrInstance === '')('buildFileConflictIndex — real LitR instance (opt-in)', () => {
  // A real conflict in the live LitR modlist, not planted: a fix patch must override what it
  // fixes, which is an oracle independent of this codebase's own logic.
  const fixName = 'Pipboy Arm Fix for Grafs Assaultron Armor';
  const baseName = "Graf's Assaultron Armor";
  const contested = [
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavyf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavym.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumm.nif',
  ];

  // The badge consumes the index's winner with no logic of its own, so asserting both proves
  // they agree rather than documenting the badge away.
  it('a fix patch positioned above the mod it fixes wins the meshes they both ship — index and badge agree', async () => {
    const litr = adapterOver(litrInstance);
    const entries = await litr.modOrder(litrProfile);
    const fixEntry = entries.find((e) => e.kind === 'mod' && e.name === fixName);
    const baseEntry = entries.find((e) => e.kind === 'mod' && e.name === baseName);
    if (!fixEntry?.enabled || !baseEntry?.enabled) {
      throw new Error(
        `LitR fixture assumption broken: expected both "${fixName}" and "${baseName}" present and enabled in modlist.txt`,
      );
    }

    const index = await buildFileConflictIndex(entries, litr, () => {});
    for (const relativePath of contested) {
      const entry = index.files.get(relativePath);
      expect(entry?.providers.sort()).toEqual([baseName, fixName].sort());
      expect(entry?.winnerMod).toBe(fixName);
    }

    const statuses = computeModStatuses([fixEntry, baseEntry], index);
    expect(statuses.get(fixName)?.status).toEqual({ kind: 'overrides', count: contested.length });
    // baseName's real count is 5: it also ships an .esl another enabled mod happens to ship,
    // a separate real collision that is part of its honest badge.
    expect(statuses.get(baseName)?.status).toEqual({ kind: 'conflicts', count: contested.length + 1 });
    for (const relativePath of contested) {
      // conflictLines carry the base mod's own on-disk casing, so compare through foldPath.
      expect(
        statuses
          .get(baseName)
          ?.conflictLines.some((line) => foldPath(line) === foldPath(`${relativePath} → winner: ${fixName}`)),
      ).toBe(true);
    }
  });
});
