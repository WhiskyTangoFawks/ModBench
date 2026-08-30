// #41 corpus — single-file modlist.txt mutations against the committed
// mo2-instance-corpus fixture. Each test drives the real Mo2ModlistSource write
// path and asserts, over the WHOLE instance tree, that only modlist.txt changed —
// not any mod's meta.ini, not the other profile, not plugins.txt, not the mods/
// folder layout. That composition-level guarantee is this file's whole point: the
// per-format tests (modlistText.test.ts) already prove modlist.txt itself is
// byte-faithful in isolation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './test/corpusFixture';
import type { Mod, Separator } from './model';

const MODLIST = 'profiles/Default/modlist.txt';

describe('modlist.txt corpus — every entry mutation touches modlist.txt and nothing else', () => {
  let dir: string;
  let src: Mo2ModlistSource;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    src = new Mo2ModlistSource(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setEnabled(false) on an enabled mod touches only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.setEnabled("Ñoño's Retexture", false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entry = (await src.readModlist()).find((e) => e.name === "Ñoño's Retexture") as Mod;
    expect(entry.enabled).toBe(false);
  });

  // Rival this catches: a handler that unconditionally re-renders the line (e.g.
  // normalizes casing/whitespace) instead of a minimal-diff flip — re-asserting an
  // already-true state must reproduce byte-identical content, not merely "the same
  // meaning".
  it('setEnabled(true) on an already-enabled mod is a byte-identical no-op over the whole instance', async () => {
    const before = await snapshotTree(dir);
    await src.setEnabled('Unofficial Fallout 4 Patch', true);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
  });

  it('reorder moves a mod to the winning end, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.reorder('ENBoost - 12k', 0);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await src.readModlist();
    expect(entries[0].name).toBe('ENBoost - 12k');
  });

  it('insertSeparator adds a new separator marker, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.insertSeparator('QA Corpus Marker', 'Cracked and Smudged Pip-Boy Screen');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await src.listSeparators()).toContain('QA Corpus Marker');
  });

  // "Unassigned (Modlist Development)" has a corresponding mods/..._separator/
  // folder on disk (a real MO2 shape) — the rival this catches is a rename that
  // also renames the folder to "stay consistent": current shipped behavior is
  // text-only, and the folder must be left exactly where it was, under its old name.
  it('renameSeparator renames the marker, leaving its mods/ folder untouched', async () => {
    const before = await snapshotTree(dir);
    await src.renameSeparator('Unassigned (Modlist Development)', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await src.listSeparators()).toContain('Renamed QA Group');
    expect(after.has('mods/Unassigned (Modlist Development)_separator/meta.ini')).toBe(true);
  });

  // "Radfall - All-In-One Survival Overhaul_separator" has NO folder on disk in the
  // fixture (a real MO2 shape: a separator can outlive the folder MO2 once made for
  // it) — deleting it must not touch mods/ at all.
  it('deleteSeparator removes the marker, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.deleteSeparator('Radfall - All-In-One Survival Overhaul');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await src.listSeparators()).not.toContain('Radfall - All-In-One Survival Overhaul');
  });

  // A separator's section is the mods that PRECEDE it (mo2/modlistText.ts #107) —
  // moving a mod "into" a separator's group means it becomes the last entry
  // immediately above that separator's own line, not below it.
  it('moveModToSeparator regroups a mod, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.moveModToSeparator('Cracked and Smudged Pip-Boy Screen', 'Unassigned (Modlist Development)');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await src.readModlist();
    const sepIdx = entries.findIndex((e) => e.kind === 'separator' && e.name === 'Unassigned (Modlist Development)');
    expect(entries[sepIdx - 1].name).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('reorderSeparatorBlock moves a separator and its (preceding) children as a unit, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    // Past the last remaining entry once the block is lifted out — moves the
    // block from the winning end to the losing end, a change large enough that
    // any of "toIndex ignored", "only the separator moved", "children left
    // behind" would all be visible in the result.
    await src.reorderSeparatorBlock('Unassigned (Modlist Development)', 999);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await src.readModlist();
    const last = entries.at(-1) as Separator;
    expect(last.kind).toBe('separator');
    expect(last.name).toBe('Unassigned (Modlist Development)');
    // Its three (preceding) children moved with it, immediately above it, in order.
    expect(entries.slice(-4).map((e) => e.name)).toEqual([
      "Ñoño's Retexture",
      'Tracked Patch Mod',
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
    ]);
    // And everything that used to follow the block now leads it.
    const enboostIdx = entries.findIndex((e) => e.name === 'ENBoost - 12k');
    expect(enboostIdx).toBeLessThan(entries.length - 4);
  });

  // "DragIn Manual Extract" sits in mods/ with no modlist.txt entry (a manually
  // dropped-in archive, or MO2's own "unmanaged" case) — the rival this catches is
  // a registration path that also touches the folder itself (e.g. writes a fresh
  // meta.ini into it), which current shipped behavior never does.
  it('registerUnlistedMods adopts the one unlisted folder, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    const added = await src.registerUnlistedMods();
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(added).toEqual(['DragIn Manual Extract']);
    expect(after.has('mods/DragIn Manual Extract/textures/dummy.dds')).toBe(true);
  });
});
