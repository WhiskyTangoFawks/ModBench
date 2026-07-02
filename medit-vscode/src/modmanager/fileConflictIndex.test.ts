import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { Mod, ModlistEntry } from './model';
import { buildFileConflictIndex } from './fileConflictIndex';

const fixture = join(__dirname, 'test', 'fixtures', 'conflict-instance');

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the topmost (highest-priority) mod', async () => {
    // ModA is index 0 (top of modlist.txt = highest priority); both provide
    // textures/shared/foo.dds. Getting the reverse-iteration wrong would make
    // ModB (the array's *last* enabled mod) win instead.
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
    expect([...index.files.keys()]).toContain('meshes/onlyB.nif');
    expect([...index.files.keys()]).toContain('textures/shared/foo.dds');
  });

  it('groups each mod\'s own files under filesByMod', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture);
    const modBFiles = index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort();
    expect(modBFiles).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });
});
