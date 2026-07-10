import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mod, ModlistEntry } from './model';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computeModStatuses, checkMasterOrder, computePluginOrderStatuses } from './statusChecker';
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
  // "CcOK" depends on a Creation Club vanilla master (a .esl, not a .esm).
  // "Broken" depends on a master nobody provides.
  // "DisabledBroken" is the same as Broken but disabled.
  // "High"/"Low" conflict on meshes/shared.nif; Low is the higher-priority entry (listed later/bottom).
  // "Clean" has no masters and no conflicts.
  // "Ghost" is referenced in entries but has no folder on disk.
  const entries: ModlistEntry[] = [
    mod('MasterOK'),
    mod('Provider'),
    mod('VanillaOK'),
    mod('CcOK'),
    mod('Broken'),
    mod('DisabledBroken', false),
    mod('High'),
    mod('Low'),
    mod('Clean'),
    mod('Ghost'),
  ];
  const vanillaMasters = new Set(['fallout4.esm', 'ccbgsfo4044-hellfirepowerarmor.esl']);

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
    await writeMod(instanceRoot, 'CcOK', {
      'CcOK.esp': buildTes4Buffer(['ccBGSFO4044-HellfirePowerArmor.esl']),
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

  it('is ok when a master is a Creation Club .esl in the vanilla master set', async () => {
    expect((await statuses()).get('CcOK')?.status).toEqual({ kind: 'ok' });
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
    const result = (await statuses()).get('High');
    expect(result?.status).toEqual({ kind: 'conflicts', count: 1 });
    expect(result?.conflictLines.join('\n')).toContain('meshes/shared.nif');
    expect(result?.conflictLines.join('\n')).toContain('Low');
  });

  it('reports overrides for the winning (higher-priority) mod', async () => {
    expect((await statuses()).get('Low')?.status).toEqual({ kind: 'overrides', count: 1 });
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

describe('checkMasterOrder', () => {
  // order: the raw plugins.txt line order (index 0 = loads first).
  const order = ['Fallout4.esm', 'Base.esp', 'Child.esp', 'Late.esp'];

  it('is ok when a declared master is present and before this plugin', () => {
    // Child.esp (index 2) depends on Base.esp (index 1) — loaded earlier.
    expect(checkMasterOrder(['Base.esp'], order, 2)).toEqual({ kind: 'ok' });
  });

  it('flags a master present but positioned after this plugin', () => {
    // Base.esp (index 1) depends on Late.esp (index 3) — loaded too late.
    expect(checkMasterOrder(['Late.esp'], order, 1)).toEqual({
      kind: 'masterNotLoadedBefore',
      masters: ['Late.esp'],
    });
  });

  it('flags a master absent from the plugin order entirely', () => {
    expect(checkMasterOrder(['Missing.esm'], order, 2)).toEqual({
      kind: 'masterNotLoadedBefore',
      masters: ['Missing.esm'],
    });
  });

  it('is ok for a vanilla master present and before, with no special-casing', () => {
    // Base.esp (index 1) depends on Fallout4.esm (index 0) — an ordinary earlier row.
    expect(checkMasterOrder(['Fallout4.esm'], order, 1)).toEqual({ kind: 'ok' });
  });

  it('matches master names case-insensitively', () => {
    expect(checkMasterOrder(['base.ESP'], order, 2)).toEqual({ kind: 'ok' });
  });

  it('reports every offending master, keeping the ok ones out', () => {
    // Child.esp (index 2): Base.esp is fine; Late.esp is after; Missing.esm is absent.
    expect(checkMasterOrder(['Base.esp', 'Late.esp', 'Missing.esm'], order, 2)).toEqual({
      kind: 'masterNotLoadedBefore',
      masters: ['Late.esp', 'Missing.esm'],
    });
  });
});

describe('computePluginOrderStatuses', () => {
  let root: string;
  let dataFolder: string;

  // A synthetic instance: two mods (Provider ships Base.esp; Consumer ships
  // Child.esp which masters Base.esp) plus a vanilla plugin in the game's Data
  // folder that Base.esp masters. plugins.txt order is set per-test.
  const entries: ModlistEntry[] = [mod('Provider'), mod('Consumer')];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-pluginorder-'));
    dataFolder = join(root, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // A vanilla-only plugin (present in Data/, provided by no mod) that itself
    // declares a master — used to prove vanilla-row masters are read via dataFolder.
    await writeFile(join(dataFolder, 'DLCRobot.esm'), buildTes4Buffer(['Fallout4.esm']));
    await writeMod(root, 'Provider', { 'Base.esp': buildTes4Buffer(['Fallout4.esm']) });
    await writeMod(root, 'Consumer', { 'Child.esp': buildTes4Buffer(['Base.esp']) });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function statuses(order: string[], df: string | undefined = dataFolder) {
    const index = await buildFileConflictIndex(entries, root);
    return computePluginOrderStatuses(order, index, df);
  }

  it('has no entry for a plugin whose masters are all present and before it', async () => {
    // Fallout4.esm < Base.esp < Child.esp — every master loads first.
    const result = await statuses(['Fallout4.esm', 'Base.esp', 'Child.esp']);
    expect(result.get('Child.esp')).toBeUndefined();
    expect(result.get('Base.esp')).toBeUndefined();
  });

  it('flags a mod-provided master sequenced after its dependant', async () => {
    // Child.esp before Base.esp — its master loads too late.
    const result = await statuses(['Fallout4.esm', 'Child.esp', 'Base.esp']);
    expect(result.get('Child.esp')).toEqual({ kind: 'masterNotLoadedBefore', masters: ['Base.esp'] });
  });

  it('flags a vanilla-folder master (resolved via dataFolder) sequenced after its dependant', async () => {
    // Base.esp before Fallout4.esm — the vanilla master loads too late.
    const result = await statuses(['Base.esp', 'Fallout4.esm', 'Child.esp']);
    expect(result.get('Base.esp')).toEqual({ kind: 'masterNotLoadedBefore', masters: ['Fallout4.esm'] });
  });

  it("reads a vanilla row's own masters via dataFolder and flags an out-of-order one", async () => {
    // DLCRobot.esm (vanilla-only, in Data/) masters Fallout4.esm; placed before it.
    const result = await statuses(['DLCRobot.esm', 'Fallout4.esm']);
    expect(result.get('DLCRobot.esm')).toEqual({ kind: 'masterNotLoadedBefore', masters: ['Fallout4.esm'] });
  });

  it('still checks mod-provided masters when dataFolder is unresolved, degrading only vanilla-row lookups', async () => {
    const logs: string[] = [];
    const index = await buildFileConflictIndex(entries, root);
    // Child before Base still flags (mod-provided path known). DLCRobot.esm is
    // vanilla-only, so with no dataFolder its own file can't be read → degrades
    // to no masters → ok, and a skip is logged.
    const result = await computePluginOrderStatuses(
      ['Child.esp', 'Base.esp', 'DLCRobot.esm', 'Fallout4.esm'],
      index,
      undefined,
      (m) => logs.push(m),
    );
    expect(result.get('Child.esp')).toEqual({ kind: 'masterNotLoadedBefore', masters: ['Base.esp'] });
    expect(result.get('DLCRobot.esm')).toBeUndefined();
    expect(logs.some((l) => l.includes('DLCRobot.esm'))).toBe(true);
  });

  it('does not throw or blank other plugins when one plugin fails to parse', async () => {
    const corruptRoot = await mkdtemp(join(tmpdir(), 'medit-pluginorder-corrupt-'));
    try {
      const corruptData = join(corruptRoot, 'Game', 'Data');
      await mkdir(corruptData, { recursive: true });
      await writeMod(corruptRoot, 'Bad', { 'Corrupt.esp': 'not a TES4 plugin' });
      await writeMod(corruptRoot, 'Good', { 'Good.esp': buildTes4Buffer(['Missing.esm']) });
      const logs: string[] = [];
      const index = await buildFileConflictIndex([mod('Bad'), mod('Good')], corruptRoot);
      const result = await computePluginOrderStatuses(['Corrupt.esp', 'Good.esp'], index, corruptData, (m) => logs.push(m));

      expect(result.get('Corrupt.esp')).toBeUndefined(); // unreadable → treated as no masters
      expect(result.get('Good.esp')).toEqual({ kind: 'masterNotLoadedBefore', masters: ['Missing.esm'] });
      expect(logs.some((l) => l.includes('Corrupt.esp'))).toBe(true);
    } finally {
      await rm(corruptRoot, { recursive: true, force: true });
    }
  });
});
