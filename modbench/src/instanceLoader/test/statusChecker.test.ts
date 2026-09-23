import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mod, ModlistEntry } from '../instance';
import { buildFileConflictIndex } from '../fileConflictIndex';
import { computeModStatuses } from '../statusChecker';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

async function writeMod(instanceRoot: string, name: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(instanceRoot, 'mods', name, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
}

describe('computeModStatuses', () => {
  let instanceRoot: string;

  // "High" and "Low" conflict on meshes/shared.nif, and High is listed first — the winning end
  // of the Mod override order.
  const entries: ModlistEntry[] = [
    mod('Disabled', false),
    mod('High'),
    mod('Low'),
    mod('Clean'),
  ];

  beforeAll(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-statuschecker-'));
    await writeMod(instanceRoot, 'Disabled', { 'Disabled.esp': 'plugin bytes' });
    await writeMod(instanceRoot, 'High', { 'meshes/shared.nif': 'high' });
    await writeMod(instanceRoot, 'Low', { 'meshes/shared.nif': 'low' });
    await writeMod(instanceRoot, 'Clean', { 'meshes/clean.nif': 'clean' });
  });

  afterAll(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  async function statuses() {
    const index = await buildFileConflictIndex(entries, instanceRoot, () => {});
    return computeModStatuses(entries, index);
  }

  it('is ok for a disabled mod, whose files are not deployed', async () => {
    expect((await statuses()).get('Disabled')).toEqual({ status: { kind: 'ok' }, conflictLines: [] });
  });

  it('reports conflicts for the overridden (losing) mod, with a tooltip line naming the winner', async () => {
    const result = (await statuses()).get('Low');
    expect(result?.status).toEqual({ kind: 'conflicts', count: 1 });
    expect(result?.conflictLines.join('\n')).toContain('meshes/shared.nif');
    expect(result?.conflictLines.join('\n')).toContain('High');
  });

  it('reports overrides for the winning mod', async () => {
    expect((await statuses()).get('High')?.status).toEqual({ kind: 'overrides', count: 1 });
  });

  it('is ok for a mod with no conflicts', async () => {
    expect((await statuses()).get('Clean')).toEqual({ status: { kind: 'ok' }, conflictLines: [] });
  });

  it('skips separator entries entirely — no status map entry', async () => {
    const withSeparator: ModlistEntry[] = [{ kind: 'separator', name: 'WEAPONS', enabled: true }, ...entries];
    const index = await buildFileConflictIndex(withSeparator, instanceRoot, () => {});
    const result = computeModStatuses(withSeparator, index);
    expect(result.has('WEAPONS')).toBe(false);
  });

  // No status kind here is a fact about a plugin's contents: those are the backend's, reported
  // per plugin on the Plugins rows (ADR-0016).
  it('never reports a status derived from a plugin file, however malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medit-statuschecker-garbage-'));
    try {
      await writeMod(root, 'Garbage', { 'Garbage.esp': 'TES4 masters: NoSuchMaster.esm' });
      const garbageEntries: ModlistEntry[] = [mod('Garbage')];
      const index = await buildFileConflictIndex(garbageEntries, root, () => {});

      const result = computeModStatuses(garbageEntries, index);

      expect(result.get('Garbage')?.status).toEqual({ kind: 'ok' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeModStatuses — case-insensitive conflicts', () => {
  // Proton/Wine resolves paths case-insensitively over ext4, so Textures/Foo.dds and
  // textures/foo.dds are one file. The fold belongs in the index, since statusChecker looks
  // paths up exactly as the walk wrote them.
  const caseFixture = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'case-conflict-instance');
  const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];

  it('reports a badge conflict for case-variant paths from two mods, winner-by-priority', async () => {
    const index = await buildFileConflictIndex(entries, caseFixture, () => {});
    const statuses = computeModStatuses(entries, index);

    expect(statuses.get('ModA')?.status).toEqual({ kind: 'overrides', count: 1 });
    const modB = statuses.get('ModB');
    expect(modB?.status).toEqual({ kind: 'conflicts', count: 1 });
    expect(modB?.conflictLines.join('\n')).toContain('ModA');
  });
});
