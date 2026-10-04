import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createEmptyMod,
  deleteSeparators,
  insertSeparator,
  markFiles,
  moveMods,
  moveSeparators,
  renameSeparator,
  setModsEnabled,
  syncMods,
} from '../../modlist/modlist';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, modFolderNames, snapshotTree,
} from './corpusFixture';
import { accessTo, adapterOver, readModlistEntries } from './adapterOver';
import type { Mod } from '../../instanceLoader/instance';
import { present } from '../../ports/present';

const isMod = (name: string) => (e: { kind: string; name: string }): e is Mod => e.kind === 'mod' && e.name === name;

const PROFILE = 'Default';
const separatorNames = async (dir: string): Promise<string[]> =>
  (await readModlistEntries(dir)).filter((e) => e.kind === 'separator').map((e) => e.name);

describe('modlist.txt corpus — every entry mutation touches the files it names and nothing else', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setModsEnabled on a selection already in that state is a byte-identical no-op over the whole instance', async () => {
    const before = await snapshotTree(dir);
    const outcome = await setModsEnabled(accessTo(dir), PROFILE, ['Unofficial Fallout 4 Patch'], true);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Unofficial Fallout 4 Patch'], refused: [] } });
  });

  it('setModsEnabled flips only the mods asked for that are not already in that state, refuses a mod not in the modlist by name, and touches only modlist.txt, in one write', async () => {
    const before = await snapshotTree(dir);
    const outcome = await setModsEnabled(accessTo(dir), PROFILE, ["Ñoño's Retexture", 'Unofficial Fallout 4 Patch', 'No Such Mod'], false);
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
    await moveMods(accessTo(dir), PROFILE, ['ENBoost - 12k'], { kind: 'modOrder' }, 'winning');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    expect(present(entries[0], 'the first entry after reordering to the winning end').name).toBe('ENBoost - 12k');
  });

  it('insertSeparator adds a separator line and its empty mods/ folder, touching no other file', async () => {
    const before = await snapshotTree(dir);
    await insertSeparator(accessTo(dir), PROFILE, 'QA Corpus Marker', { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('QA Corpus Marker');
    expect((await stat(join(dir, 'mods', 'QA Corpus Marker_separator'))).isDirectory()).toBe(true);
  });

  it('renameSeparator renames the line and its mods/ folder, its meta.ini carried along unchanged', async () => {
    const OLD_META = 'mods/Unassigned (Modlist Development)_separator/meta.ini';
    const NEW_META = 'mods/Renamed QA Group_separator/meta.ini';
    const before = await snapshotTree(dir);
    await renameSeparator(accessTo(dir), PROFILE, 'Unassigned (Modlist Development)', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST, OLD_META, NEW_META]));

    expect(await separatorNames(dir)).toContain('Renamed QA Group');
    expect(after.has(OLD_META)).toBe(false);
    expect(after.get(NEW_META)).toEqual(before.get(OLD_META));
  });

  it('renameSeparator of a separator with no folder renames its line alone, and makes no folder', async () => {
    const before = await snapshotTree(dir);
    await renameSeparator(accessTo(dir), PROFILE, 'Radfall - All-In-One Survival Overhaul', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('Renamed QA Group');
    expect(await modFolderNames(dir)).not.toContain('Renamed QA Group_separator');
  });

  it('deleteSeparators of a separator with no folder removes its line alone, and trashes nothing', async () => {
    const trashed: string[] = [];
    const before = await snapshotTree(dir);
    const outcome = await deleteSeparators(accessTo(dir), PROFILE, ['Radfall - All-In-One Survival Overhaul'], (path) => {
      trashed.push(path);
      return Promise.resolve();
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [{ name: 'Radfall - All-In-One Survival Overhaul' }], refused: [] },
    });
    expect(await separatorNames(dir)).not.toContain('Radfall - All-In-One Survival Overhaul');
    expect(trashed).toEqual([]);
  });

  it('deleteSeparators removes the line and trashes the folder, and its mods stay where they are', async () => {
    const SEPARATOR_META = 'mods/Unassigned (Modlist Development)_separator/meta.ini';
    const trashed: string[] = [];
    const modsBefore = (await readModlistEntries(dir)).filter((e) => e.kind === 'mod');
    const before = await snapshotTree(dir);
    await deleteSeparators(accessTo(dir), PROFILE, ['Unassigned (Modlist Development)'], async (path) => {
      trashed.push(path);
      await rm(path, { recursive: true });
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST, SEPARATOR_META]));

    expect(trashed).toEqual([join(dir, 'mods', 'Unassigned (Modlist Development)_separator')]);
    expect(await separatorNames(dir)).toEqual(['Radfall - All-In-One Survival Overhaul']);
    expect((await readModlistEntries(dir)).filter((e) => e.kind === 'mod')).toEqual(modsBefore);
  });

  it('moveMods regroups mods, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveMods(accessTo(dir), PROFILE, ['Cracked and Smudged Pip-Boy Screen'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entries = await readModlistEntries(dir);
    const sepIdx = entries.findIndex((e) => e.kind === 'separator' && e.name === 'Unassigned (Modlist Development)');
    expect(present(entries[sepIdx - 1], "the entry now preceding the separator").name).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('moveSeparators moves a separator with its mods, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await moveSeparators(accessTo(dir), PROFILE, ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toEqual(['Radfall - All-In-One Survival Overhaul', 'Unassigned (Modlist Development)']);
  });

  it('createEmptyMod adds one empty mods/ folder and one disabled modlist line, and nothing else', async () => {
    const before = await snapshotTree(dir);
    await createEmptyMod(accessTo(dir), PROFILE, 'QA Empty Mod');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entry = (await readModlistEntries(dir)).find(isMod('QA Empty Mod'));
    expect(entry?.enabled).toBe(false);
  });

  it('syncMods adds and drops lines against the folders it is handed, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    const outcome = await syncMods(accessTo(dir), PROFILE, (await adapterOver(dir).modFolders())?.all ?? []);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(outcome).toEqual({
      applied: true, added: ['DragIn Manual Extract'],
      dropped: ['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)'],
    });
    expect(after.has('mods/DragIn Manual Extract/textures/dummy.dds')).toBe(true);
    expect((await readModlistEntries(dir)).map((e) => e.name)).toContain('DragIn Manual Extract');
  });
});

describe('a mod\'s and Overwrite\'s files corpus — exclude and include rename the files they name and nothing else', () => {
  let dir: string;
  const inMod = { origin: { kind: 'mod', name: 'DragIn Manual Extract' }, relativePath: 'textures/dummy.dds' } as const;
  const inOverwrite = { origin: { kind: 'runtimeOutput' }, relativePath: 'F4SE/Plugins/SomePlugin.log' } as const;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('markFiles excludes a mod\'s file and an Overwrite file, then includes them back byte-identical', async () => {
    const before = await snapshotTree(dir);

    const excluded = await markFiles(accessTo(dir), [inMod, inOverwrite], 'Excluded');

    expect(excluded).toEqual({ landed: [inMod, inOverwrite], refused: [] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([
      'mods/DragIn Manual Extract/textures/dummy.dds', 'mods/DragIn Manual Extract/textures/dummy.dds.mohidden',
      'overwrite/F4SE/Plugins/SomePlugin.log', 'overwrite/F4SE/Plugins/SomePlugin.log.mohidden',
    ]));
    expect(after.get('mods/DragIn Manual Extract/textures/dummy.dds.mohidden')).toEqual(before.get('mods/DragIn Manual Extract/textures/dummy.dds'));
    expect(after.get('overwrite/F4SE/Plugins/SomePlugin.log.mohidden')).toEqual(before.get('overwrite/F4SE/Plugins/SomePlugin.log'));

    await markFiles(accessTo(dir), [
      { ...inMod, relativePath: 'textures/dummy.dds.mohidden' }, { ...inOverwrite, relativePath: 'F4SE/Plugins/SomePlugin.log.mohidden' },
    ], 'Included');

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('markFiles refuses a file gone from disk by name, and one the instance refuses with its reason, while the rest land', async () => {
    const own = { ...inMod, relativePath: 'textures/dummy.dds.mohidden' };
    const gone = { ...inMod, relativePath: 'Missing.esp' };
    const byFolder = { ...inMod, relativePath: 'meshes.mohidden/a.nif' };
    await markFiles(accessTo(dir), [inMod], 'Excluded');
    await mkdir(join(dir, 'mods', 'DragIn Manual Extract', 'meshes.mohidden'));
    await writeFile(join(dir, 'mods', 'DragIn Manual Extract', 'meshes.mohidden', 'a.nif'), '');
    const before = await snapshotTree(dir);

    const outcome = await markFiles(accessTo(dir), [gone, byFolder, own], 'Included');

    expect(outcome.landed).toEqual([own]);
    expect(outcome.refused.map(({ item }) => item)).toEqual([gone, byFolder]);
    expect(outcome.refused[0]?.reason).toBe('"Missing.esp" is gone from disk.');
    expect(outcome.refused[1]?.reason).toContain('excluded by its folder');
    assertOnlyChanged(before, await snapshotTree(dir), new Set([
      'mods/DragIn Manual Extract/textures/dummy.dds', 'mods/DragIn Manual Extract/textures/dummy.dds.mohidden',
    ]));
  });
});
