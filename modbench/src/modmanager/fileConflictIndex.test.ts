import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { Mod, ModlistEntry } from './model';
import { buildFileConflictIndex, rootLevelWinners } from './fileConflictIndex';

const fixture = join(__dirname, 'test', 'fixtures', 'conflict-instance');
const caseFixture = join(__dirname, 'test', 'fixtures', 'case-conflict-instance');

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the topmost (winning) mod', async () => {
    // Entries are in modlist.txt file order, top-first. Top of the file is the
    // winning end (MO2: vanilla/base is losing-most, everything above overrides
    // it), so ModA — the array's first enabled mod — wins over ModB. Both provide
    // textures/shared/foo.dds. Getting the direction wrong would make ModB win.
    const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];
    const index = await buildFileConflictIndex(entries, fixture);

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winnerMod).toBe('ModA');
    expect(entry?.winner).toBe(join(fixture, 'mods', 'ModA', 'textures', 'shared', 'foo.dds'));
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
  });

  it('flips the winner when the mods are reordered', async () => {
    const index = await buildFileConflictIndex([mod('ModB'), mod('ModA')], fixture);
    expect(index.files.get('textures/shared/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('excludes disabled mods entirely', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], fixture);
    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
  });

  it('never treats meta.ini as a conflict, even though every mod has one', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture);
    expect(index.files.has('meta.ini')).toBe(false);
  });

  it('records a single-provider file with providers.length === 1', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture);
    const entry = index.files.get('meshes/onlyB.nif');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
  });

  it('resolves nested subdirectory relative paths correctly', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture);
    // Iteration surface: entries carry their own original-cased relativePath,
    // not raw (possibly folded) Map keys.
    const paths = [...index.files].map((e) => e.relativePath);
    expect(paths).toContain('meshes/onlyB.nif');
    expect(paths).toContain('textures/shared/foo.dds');
  });

  it('groups each mod\'s own files under filesByMod', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture);
    const modBFiles = index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort();
    expect(modBFiles).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });
});

// Proton/Wine resolves paths case-insensitively over ext4's case-sensitive
// mods/, so two mods providing case-variant paths (Textures/Foo.dds vs
// textures/foo.dds) must resolve to ONE conflict entry with a deterministic
// winner (#128). caseFixture: ModA/Textures/Foo.dds vs ModB/textures/foo.dds;
// RootA/Foo.esp vs RootB/foo.ESP (root-level, for rootLevelWinners).
describe('buildFileConflictIndex — case-insensitive conflicts', () => {
  it('resolves case-variant paths from two mods to a single conflict entry with both providers', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture);

    expect(index.files.size).toBe(1);
    const entry = index.files.get('Textures/Foo.dds'); // look up via either casing
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
    const entryOtherCasing = index.files.get('textures/foo.dds');
    expect(entryOtherCasing).toBe(entry);
  });

  it('picks the same winner by priority whether casing matches or varies', async () => {
    const top = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture);
    expect(top.files.get('textures/foo.dds')?.winnerMod).toBe('ModA');

    const flipped = await buildFileConflictIndex([mod('ModB'), mod('ModA')], caseFixture);
    expect(flipped.files.get('textures/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('keeps the winner\'s own original casing in relativePath and winner, regardless of lookup casing', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture);

    const entry = index.files.get('TEXTURES/FOO.DDS'); // deliberately different casing again
    expect(entry?.relativePath).toBe('Textures/Foo.dds'); // ModA's own casing (it won)
    expect(entry?.winner).toBe(join(caseFixture, 'mods', 'ModA', 'Textures', 'Foo.dds'));
  });

  it('rootLevelWinners folds a case-variant root-level plugin pair to one winner', async () => {
    const index = await buildFileConflictIndex([mod('RootA'), mod('RootB')], caseFixture);
    const winners = rootLevelWinners(index);

    expect(winners.size).toBe(1);
    expect(winners.get('foo.esp')).toBe(join(caseFixture, 'mods', 'RootA', 'Foo.esp'));
  });
});
