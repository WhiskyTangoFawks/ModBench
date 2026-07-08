import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mod, ModlistEntry } from './model';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computeModStatuses } from './statusChecker';
import { buildTes4Buffer } from './test/buildTes4Buffer';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

async function writeMod(instanceRoot: string, name: string, files: Record<string, Buffer | string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(instanceRoot, 'mods', name, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
}

describe('computeModStatuses', () => {
  let instanceRoot: string;

  // "MasterOK" depends on a master provided by another enabled mod ("Provider").
  // "VanillaOK" depends on a vanilla master (Fallout4.esm, not backed by any mod).
  // "Broken" depends on a master nobody provides.
  // "DisabledBroken" is the same as Broken but disabled.
  // "High"/"Low" conflict on meshes/shared.nif; High is the higher-priority entry.
  // "Clean" has no masters and no conflicts.
  // "Ghost" is referenced in entries but has no folder on disk.
  const entries: ModlistEntry[] = [
    mod('MasterOK'),
    mod('Provider'),
    mod('VanillaOK'),
    mod('Broken'),
    mod('DisabledBroken', false),
    mod('High'),
    mod('Low'),
    mod('Clean'),
    mod('Ghost'),
  ];
  const vanillaMasters = new Set(['fallout4.esm']);

  beforeAll(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-statuschecker-'));
    await writeMod(instanceRoot, 'MasterOK', {
      'MasterOK.esp': buildTes4Buffer(['ProvidedByOther.esm']),
    });
    await writeMod(instanceRoot, 'Provider', {
      'ProvidedByOther.esm': buildTes4Buffer([]),
    });
    await writeMod(instanceRoot, 'VanillaOK', {
      'VanillaOK.esp': buildTes4Buffer(['Fallout4.esm']),
    });
    await writeMod(instanceRoot, 'Broken', {
      'Broken.esp': buildTes4Buffer(['DoesNotExist.esm']),
    });
    await writeMod(instanceRoot, 'DisabledBroken', {
      'DisabledBroken.esp': buildTes4Buffer(['DoesNotExist.esm']),
    });
    await writeMod(instanceRoot, 'High', { 'meshes/shared.nif': 'high' });
    await writeMod(instanceRoot, 'Low', { 'meshes/shared.nif': 'low' });
    await writeMod(instanceRoot, 'Clean', { 'meshes/clean.nif': 'clean' });
    // 'Ghost' intentionally has no folder on disk.
  });

  afterAll(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  async function statuses() {
    const index = await buildFileConflictIndex(entries, instanceRoot);
    return computeModStatuses(entries, instanceRoot, index, vanillaMasters);
  }

  it('is ok when a master is satisfied by another enabled mod', async () => {
    expect((await statuses()).get('MasterOK')?.status).toEqual({ kind: 'ok' });
  });

  it('is ok when a master is satisfied by the vanilla master set', async () => {
    expect((await statuses()).get('VanillaOK')?.status).toEqual({ kind: 'ok' });
  });

  it('reports missingMaster when a master is satisfied by neither', async () => {
    expect((await statuses()).get('Broken')?.status).toEqual({
      kind: 'missingMaster',
      masters: ['DoesNotExist.esm'],
    });
  });

  it('does not flag a missing master on a disabled mod', async () => {
    expect((await statuses()).get('DisabledBroken')?.status).toEqual({ kind: 'ok' });
  });

  it('reports missingMod for a modlist entry with no folder on disk', async () => {
    expect((await statuses()).get('Ghost')?.status).toEqual({ kind: 'missingMod' });
  });

  it('reports conflicts for the overridden (lower-priority) mod, with a tooltip line', async () => {
    const result = (await statuses()).get('Low');
    expect(result?.status).toEqual({ kind: 'conflicts', count: 1 });
    expect(result?.conflictLines.join('\n')).toContain('meshes/shared.nif');
    expect(result?.conflictLines.join('\n')).toContain('High');
  });

  it('reports overrides for the winning (higher-priority) mod', async () => {
    expect((await statuses()).get('High')?.status).toEqual({ kind: 'overrides', count: 1 });
  });

  it('is ok for a mod with no masters and no conflicts', async () => {
    expect((await statuses()).get('Clean')?.status).toEqual({ kind: 'ok' });
  });

  it('does not throw when a plugin fails to parse, and does not blank other mods\' statuses', async () => {
    const corruptRoot = await mkdtemp(join(tmpdir(), 'medit-statuschecker-corrupt-'));
    try {
      await writeMod(corruptRoot, 'HasCorruptPlugin', {
        'Valid.esp': buildTes4Buffer(['Fallout4.esm']),
        'Corrupt.esp': 'this is not a TES4 plugin',
      });
      await writeMod(corruptRoot, 'Other', { 'meshes/other.nif': 'other' });
      const corruptEntries: ModlistEntry[] = [mod('HasCorruptPlugin'), mod('Other')];
      const logs: string[] = [];

      const index = await buildFileConflictIndex(corruptEntries, corruptRoot);
      const result = await computeModStatuses(corruptEntries, corruptRoot, index, vanillaMasters, (m) => logs.push(m));

      expect(result.get('HasCorruptPlugin')?.status).toEqual({ kind: 'ok' });
      expect(result.get('Other')?.status).toEqual({ kind: 'ok' });
      expect(logs.some((l) => l.includes('Corrupt.esp'))).toBe(true);
    } finally {
      await rm(corruptRoot, { recursive: true, force: true });
    }
  });
});
