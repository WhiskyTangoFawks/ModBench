// Each test drives the real write path and asserts over the WHOLE instance tree that only
// modlist.txt changed — the composition-level guarantee a per-format test cannot give.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveMods,
  moveSeparators,
  renameSeparator,
  setModsEnabled,
  syncMods,
} from '../../modlist/modlist';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, modFolderNames, readModlistEntries, snapshotTree,
} from './corpusFixture';
import type { Mod } from '../../instanceLoader/instance';
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

  // Rival this catches: a handler that unconditionally re-renders the line (e.g.
  // normalizes casing/whitespace) instead of a minimal-diff flip — re-asserting an
  // already-true state must reproduce byte-identical content, not merely "the same
  // meaning".
  it('setModsEnabled on a selection already in that state is a byte-identical no-op over the whole instance', async () => {
    const before = await snapshotTree(dir);
    const outcome = await setModsEnabled(dir, PROFILE, ['Unofficial Fallout 4 Patch'], true);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Unofficial Fallout 4 Patch'], refused: [] } });
  });

  // modbench.mod.enable / modbench.mod.disable over a mixed selection, in one write, and a gone
  // mod refused by name while the other lands.
  it('setModsEnabled flips only the mods asked for that are not already in that state, touching only modlist.txt, in one write', async () => {
    const before = await snapshotTree(dir);
    const outcome = await setModsEnabled(
      dir, PROFILE, ["Ñoño's Retexture", 'Unofficial Fallout 4 Patch', 'No Such Mod'], false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: ["Ñoño's Retexture", 'Unofficial Fallout 4 Patch'],
        refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }],
      },
    });
    const entries = await readModlistEntries(dir);
    expect(entries.find(isMod("Ñoño's Retexture"))?.enabled).toBe(false);
    expect(entries.find(isMod('Unofficial Fallout 4 Patch'))?.enabled).toBe(false);
  });

  it('moveMods moves a mod to the winning end of mod order, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveMods(dir, PROFILE, ['ENBoost - 12k'], { kind: 'modOrder' }, 'winning');
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

  it('moveMods regroups mods, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveMods(
      dir, PROFILE, ['Cracked and Smudged Pip-Boy Screen'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    const sepIdx = entries.findIndex((e) => e.kind === 'separator' && e.name === 'Unassigned (Modlist Development)');
    expect(present(entries[sepIdx - 1], "the entry now preceding the separator").name).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('moveSeparators moves a separator with its mods, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveSeparators(dir, PROFILE, ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toEqual(['Radfall - All-In-One Survival Overhaul', 'Unassigned (Modlist Development)']);
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
