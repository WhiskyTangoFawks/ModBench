import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { Mod, ModlistEntry } from '../instance';
import { buildFileConflictIndex } from '../fileConflictIndex';
import { computeModStatuses } from '../statusChecker';
import { adapterOver } from '../../test/mo2/adapterOver';

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

  const entriesHighWinningOverLowOnSharedNif: ModlistEntry[] = [
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
    const index = await buildFileConflictIndex(entriesHighWinningOverLowOnSharedNif, adapterOver(instanceRoot), () => {});
    return computeModStatuses(entriesHighWinningOverLowOnSharedNif, index);
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
    const withSeparator: ModlistEntry[] = [{ kind: 'separator', name: 'WEAPONS', enabled: true }, ...entriesHighWinningOverLowOnSharedNif];
    const index = await buildFileConflictIndex(withSeparator, adapterOver(instanceRoot), () => {});
    const result = computeModStatuses(withSeparator, index);
    expect(result.has('WEAPONS')).toBe(false);
  });
});

describe('computeModStatuses — case-insensitive conflicts, Proton/Wine resolving Textures/Foo.dds and textures/foo.dds as one file over ext4, folded in the index since statusChecker looks paths up exactly as the walk wrote them', () => {
  const caseFixture = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'case-conflict-instance');
  const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];

  it('reports a badge conflict for case-variant paths from two mods, winner-by-priority', async () => {
    const index = await buildFileConflictIndex(entries, adapterOver(caseFixture), () => {});
    const statuses = computeModStatuses(entries, index);

    expect(statuses.get('ModA')?.status).toEqual({ kind: 'overrides', count: 1 });
    const modB = statuses.get('ModB');
    expect(modB?.status).toEqual({ kind: 'conflicts', count: 1 });
    expect(modB?.conflictLines.join('\n')).toContain('ModA');
  });
});
