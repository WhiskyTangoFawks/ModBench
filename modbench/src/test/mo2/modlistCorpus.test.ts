// Each test drives the real write path and asserts over the WHOLE instance tree that only
// modlist.txt changed — the composition-level guarantee a per-format test cannot give.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveModToSeparator,
  renameSeparator,
  reorderMod,
  reorderSeparatorBlock,
  setModEnabled,
  syncMods,
} from '../../modlist/modlist';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, modFolderNames, readModlistEntries, snapshotTree,
} from './corpusFixture';
import type { Mod, Separator } from '../../instanceLoader/instance';
import { present } from '../../ports/present';

const isMod = (name: string) => (e: { kind: string; name: string }): e is Mod => e.kind === 'mod' && e.name === name;

const PROFILE = 'Default';
const separatorNames = async (dir: string): Promise<string[]> =>
  (await readModlistEntries(dir)).filter((e) => e.kind === 'separator').map((e) => e.name);

describe('modlist.txt corpus — every entry mutation touches modlist.txt and nothing else', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setModEnabled(false) on an enabled mod touches only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await setModEnabled(dir, PROFILE, "Ñoño's Retexture", false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entry = (await readModlistEntries(dir)).find(isMod("Ñoño's Retexture"));
    expect(entry?.enabled).toBe(false);
  });

  // Rival this catches: a handler that unconditionally re-renders the line (e.g.
  // normalizes casing/whitespace) instead of a minimal-diff flip — re-asserting an
  // already-true state must reproduce byte-identical content, not merely "the same
  // meaning".
  it('setModEnabled(true) on an already-enabled mod is a byte-identical no-op over the whole instance', async () => {
    const before = await snapshotTree(dir);
    await setModEnabled(dir, PROFILE, 'Unofficial Fallout 4 Patch', true);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
  });

  it('reorderMod moves a mod to the winning end, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await reorderMod(dir, PROFILE, 'ENBoost - 12k', { kind: 'winningEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    expect(present(entries[0], 'the first entry after reordering to the winning end').name).toBe('ENBoost - 12k');
  });

  it('insertSeparator adds a new separator marker, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await insertSeparator(dir, PROFILE, 'QA Corpus Marker', 'Cracked and Smudged Pip-Boy Screen');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('QA Corpus Marker');
  });

  // This separator has a real mods/..._separator/ folder on disk; the rival is a rename that
  // also renames the folder to "stay consistent".
  it('renameSeparator renames the marker, leaving its mods/ folder untouched', async () => {
    const before = await snapshotTree(dir);
    await renameSeparator(dir, PROFILE, 'Unassigned (Modlist Development)', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('Renamed QA Group');
    expect(after.has('mods/Unassigned (Modlist Development)_separator/meta.ini')).toBe(true);
  });

  // "Radfall - All-In-One Survival Overhaul_separator" has NO folder on disk in the
  // fixture (a real MO2 shape: a separator can outlive the folder MO2 once made for
  // it) — deleting it must not touch mods/ at all.
  it('deleteSeparator removes the marker, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await deleteSeparator(dir, PROFILE, 'Radfall - All-In-One Survival Overhaul');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).not.toContain('Radfall - All-In-One Survival Overhaul');
  });

  // A separator's section is the mods that PRECEDE it (mo2/modlistText.ts) —
  // moving a mod "into" a separator's group means it becomes the last entry
  // immediately above that separator's own line, not below it.
  it('moveModToSeparator regroups a mod, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveModToSeparator(dir, PROFILE, 'Cracked and Smudged Pip-Boy Screen', 'Unassigned (Modlist Development)');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    const sepIdx = entries.findIndex((e) => e.kind === 'separator' && e.name === 'Unassigned (Modlist Development)');
    expect(present(entries[sepIdx - 1], "the entry now preceding the separator").name).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('reorderSeparatorBlock moves a separator and its (preceding) children as a unit, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    // Past the last remaining entry once the block is lifted out: a move large enough that
    // "the drop ignored" or "children left behind" would be visible.
    await reorderSeparatorBlock(dir, PROFILE, 'Unassigned (Modlist Development)', { kind: 'losingEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    const last = entries.at(-1);
    if (last?.kind !== 'separator') throw new Error('expected the last entry to be a separator');
    const lastSeparator: Separator = last;
    expect(lastSeparator.name).toBe('Unassigned (Modlist Development)');
    // Its three (preceding) children moved with it, immediately above it, in order.
    expect(entries.slice(-4).map((e) => e.name)).toEqual([
      "Ñoño's Retexture",
      'Tracked Patch Mod',
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
    ]);
    // And everything that followed the block now leads it.
    const enboostIdx = entries.findIndex((e) => e.name === 'ENBoost - 12k');
    expect(enboostIdx).toBeLessThan(entries.length - 4);
  });

  it('createEmptyMod adds one empty mods/ folder and one disabled modlist line, and nothing else', async () => {
    const before = await snapshotTree(dir);
    await createEmptyMod(dir, PROFILE, 'QA Empty Mod', await modFolderNames(dir));
    const after = await snapshotTree(dir);
    // An empty directory holds no files, so the whole change is visible in modlist.txt.
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entry = (await readModlistEntries(dir)).find(isMod('QA Empty Mod'));
    expect(entry?.enabled).toBe(false);
  });

  // The fixture ships one unlisted folder and one folderless mod line. Rival: a sync that also
  // writes into the folder it lists, or rewrites the entries it keeps.
  it('syncMods adds and drops lines against the folders it is handed, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    const outcome = await syncMods(dir, PROFILE, await modFolderNames(dir));
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(outcome).toEqual({ applied: true, added: ['DragIn Manual Extract'], dropped: ['[NODELETE] Radfall'] });
    expect(after.has('mods/DragIn Manual Extract/textures/dummy.dds')).toBe(true);
    expect((await readModlistEntries(dir)).map((e) => e.name)).toContain('DragIn Manual Extract');
  });
});
