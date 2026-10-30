import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modSyncOver, modCommands } from '../../modCommands/modCommands';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, modFolderNames, snapshotTree,
} from './corpusFixture';
import { adapterOver, readModlistEntries } from './adapterOver';
import type { Mod } from '../../instanceLoader/instance';


const isMod = (name: string) => (e: { kind: string; name: string }): e is Mod => e.kind === 'mod' && e.name === name;

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
    const outcome = await modCommands(adapterOver(dir)).setModsEnabled(['Unofficial Fallout 4 Patch'], true);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Unofficial Fallout 4 Patch'], refused: [] } });
  });

  it('setModsEnabled flips only the mods asked for that are not already in that state, refuses a mod not in the modlist by name, and touches only modlist.txt, in one write', async () => {
    const before = await snapshotTree(dir);
    const outcome = await modCommands(adapterOver(dir)).setModsEnabled(["Ñoño's Retexture", 'Unofficial Fallout 4 Patch', 'No Such Mod'], false);
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
    await modCommands(adapterOver(dir)).moveMods(['ENBoost - 12k'], { kind: 'modOrder' }, 'winning');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));
  });

  it('insertSeparator adds a separator line and its empty mods/ folder, touching no other file', async () => {
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir)).insertSeparator('QA Corpus Marker', { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('QA Corpus Marker');
    expect((await stat(join(dir, 'mods', 'QA Corpus Marker_separator'))).isDirectory()).toBe(true);
  });

  it('insertSeparator answers the name the separator was written under, folded as MO2 folds a folder name', async () => {
    const outcome = await modCommands(adapterOver(dir)).insertSeparator('  QA  Marker. ', { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' });

    expect(outcome).toEqual({ applied: true, wrote: true, name: 'QA Marker' });
    expect(await separatorNames(dir)).toContain('QA Marker');
  });

  it('renameSeparator answers the name the separator was written under, folded as MO2 folds a folder name', async () => {
    const outcome = await modCommands(adapterOver(dir)).renameSeparator('Unassigned (Modlist Development)', 'Renamed  QA Group.');

    expect(outcome).toEqual({ applied: true, wrote: true, name: 'Renamed QA Group' });
    expect(await separatorNames(dir)).toContain('Renamed QA Group');
  });

  it('renameSeparator to the separator\'s own name writes nothing', async () => {
    const before = await snapshotTree(dir);
    const outcome = await modCommands(adapterOver(dir)).renameSeparator('Unassigned (Modlist Development)', 'Unassigned (Modlist Development)');
    assertOnlyChanged(before, await snapshotTree(dir), new Set());

    expect(outcome).toMatchObject({ applied: true, wrote: false });
  });

  it.each(['', '   ', '...'])('insertSeparator and renameSeparator refuse the name %j the adapter folds to nothing, writing nothing', async (name) => {
    const commands = modCommands(adapterOver(dir));
    const before = await snapshotTree(dir);
    const added = await commands.insertSeparator(name, { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen' });
    const renamed = await commands.renameSeparator('Unassigned (Modlist Development)', name);
    assertOnlyChanged(before, await snapshotTree(dir), new Set());

    const refusal = { applied: false, refusal: `Not a valid separator name: "${name}"` };
    expect([added, renamed]).toEqual([refusal, refusal]);
  });

  it('renameSeparator renames the line and its mods/ folder, its meta.ini carried along unchanged', async () => {
    const OLD_META = 'mods/Unassigned (Modlist Development)_separator/meta.ini';
    const NEW_META = 'mods/Renamed QA Group_separator/meta.ini';
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir)).renameSeparator('Unassigned (Modlist Development)', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST, OLD_META, NEW_META]));

    expect(await separatorNames(dir)).toContain('Renamed QA Group');
    expect(after.has(OLD_META)).toBe(false);
    expect(after.get(NEW_META)).toEqual(before.get(OLD_META));
  });

  it('renameSeparator of a separator with no folder renames its line alone, and makes no folder', async () => {
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir)).renameSeparator('Radfall - All-In-One Survival Overhaul', 'Renamed QA Group');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(await separatorNames(dir)).toContain('Renamed QA Group');
    expect(await modFolderNames(dir)).not.toContain('Renamed QA Group_separator');
  });

  it('deleteSeparators of a separator with no folder removes its line alone, and trashes nothing', async () => {
    const trashed: string[] = [];
    const before = await snapshotTree(dir);
    const outcome = await modCommands(adapterOver(dir)).deleteSeparators(['Radfall - All-In-One Survival Overhaul'], (path) => {
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
    await modCommands(adapterOver(dir)).deleteSeparators(['Unassigned (Modlist Development)'], async (path) => {
      trashed.push(path);
      await rm(path, { recursive: true });
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST, SEPARATOR_META]));

    expect(trashed).toEqual([join(dir, 'mods', 'Unassigned (Modlist Development)_separator')]);
    expect(await separatorNames(dir)).toEqual(['Radfall - All-In-One Survival Overhaul']);
    expect((await readModlistEntries(dir)).filter((e) => e.kind === 'mod')).toEqual(modsBefore);
  });

  it('moveSeparators touches only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir)).moveSeparators(['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));
  });

  it('createEmptyMod adds one empty mods/ folder and one disabled modlist line, and nothing else', async () => {
    const before = await snapshotTree(dir);
    await modCommands(adapterOver(dir)).createEmptyMod('QA Empty Mod');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    const entry = (await readModlistEntries(dir)).find(isMod('QA Empty Mod'));
    expect(entry?.enabled).toBe(false);
  });

  it('syncMods adds and drops lines against the folders on disk, touching only modlist.txt', async () => {
    const before = await snapshotTree(dir);
    const outcome = await modSyncOver(adapterOver(dir))();
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([MODLIST]));

    expect(outcome).toEqual({
      applied: true, added: ['DragIn Manual Extract'],
      dropped: ['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)'],
    });
    expect(after.has('mods/DragIn Manual Extract/textures/dummy.dds')).toBe(true);
    expect((await readModlistEntries(dir)).map((e) => e.name)).toContain('DragIn Manual Extract');
  });

  it('syncMods reports a missing mod its file repeats once', async () => {
    await appendFile(join(dir, MODLIST), '+[NODELETE] Radfall\r\n');
    const outcome = await modSyncOver(adapterOver(dir))();

    expect(outcome).toMatchObject({ applied: true, dropped: ['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)'] });
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

  it('excludes a mod\'s file and an Overwrite file, then includes them back byte-identical', async () => {
    const before = await snapshotTree(dir);

    const excluded = await modCommands(adapterOver(dir)).markFiles([inMod, inOverwrite], 'Excluded');

    expect(excluded).toEqual({ applied: true, outcome: { landed: [inMod, inOverwrite], refused: [] } });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([
      'mods/DragIn Manual Extract/textures/dummy.dds', 'mods/DragIn Manual Extract/textures/dummy.dds.mohidden',
      'overwrite/F4SE/Plugins/SomePlugin.log', 'overwrite/F4SE/Plugins/SomePlugin.log.mohidden',
    ]));
    expect(after.get('mods/DragIn Manual Extract/textures/dummy.dds.mohidden')).toEqual(before.get('mods/DragIn Manual Extract/textures/dummy.dds'));
    expect(after.get('overwrite/F4SE/Plugins/SomePlugin.log.mohidden')).toEqual(before.get('overwrite/F4SE/Plugins/SomePlugin.log'));

    await modCommands(adapterOver(dir)).markFiles([
      { ...inMod, relativePath: 'textures/dummy.dds.mohidden' }, { ...inOverwrite, relativePath: 'F4SE/Plugins/SomePlugin.log.mohidden' },
    ], 'Included');

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('refuses a file gone from disk by name, and an include its folder leaves undone with the instance\'s reason, while the rest land', async () => {
    const own = { ...inMod, relativePath: 'textures/dummy.dds.mohidden' };
    const gone = { ...inMod, relativePath: 'Missing.esp' };
    const byFolder = { ...inMod, relativePath: 'meshes.mohidden/a.nif' };
    await modCommands(adapterOver(dir)).markFiles([inMod], 'Excluded');
    await mkdir(join(dir, 'mods', 'DragIn Manual Extract', 'meshes.mohidden'));
    await writeFile(join(dir, 'mods', 'DragIn Manual Extract', 'meshes.mohidden', 'a.nif'), '');
    const before = await snapshotTree(dir);

    const outcome = await modCommands(adapterOver(dir)).markFiles([gone, byFolder, own], 'Included');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [own], refused: [
      { item: gone, reason: '"Missing.esp" is gone from disk.' },
      { item: byFolder, reason: '"meshes.mohidden/a.nif" has no suffix of its own to remove, and its folder excludes it.' },
    ] } });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([
      'mods/DragIn Manual Extract/textures/dummy.dds', 'mods/DragIn Manual Extract/textures/dummy.dds.mohidden',
    ]));
  });
});

describe('compiler_settings.json corpus — a publisher tag change touches the publisher\'s configuration and nothing else', () => {
  let dir: string;
  const row = { origin: { kind: 'mod', name: 'DragIn Manual Extract' } } as const;
  const SETTINGS = 'compiler_settings.json';

  beforeEach(async () => {
    dir = cloneCorpusFixture();
    await writeFile(join(dir, SETTINGS), '{\n  "Include": [],\n  "Source": "somewhere"\n}\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds a mod\'s folder under the tag, then removes it', async () => {
    const before = await snapshotTree(dir);
    const commands = modCommands(adapterOver(dir));

    const added = await commands.changePublisherTag('add', 'Ignore', [row]);

    expect(added).toEqual({ applied: true, outcome: { landed: [row], refused: [] } });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([SETTINGS]));
    expect(JSON.parse(after.get(SETTINGS)?.toString() ?? '')).toMatchObject({ Include: [], Source: 'somewhere', Ignore: [expect.stringContaining('DragIn Manual Extract')] });

    await commands.changePublisherTag('remove', 'Ignore', [row]);

    expect(JSON.parse((await snapshotTree(dir)).get(SETTINGS)?.toString() ?? '')).toMatchObject({ Include: [], Source: 'somewhere', Ignore: [] });
  });

  it('follows a rename and leaves with an uninstall', async () => {
    const adapter = adapterOver(dir);
    const commands = modCommands(adapter);
    await modSyncOver(adapter)();
    const settings = async () => (await snapshotTree(dir)).get(SETTINGS)?.toString() ?? '';
    await commands.changePublisherTag('add', 'Ignore', [row]);

    await commands.renameMod('DragIn Manual Extract', 'Renamed');

    expect(await settings()).toContain('"Ignore": [\n    "mods\\\\Renamed"');

    await commands.uninstallMods(['Renamed'], () => Promise.resolve());

    expect(await settings()).not.toContain('Renamed');
  });

  it('refuses a rename and an uninstall, changing nothing, while the settings cannot be read', async () => {
    await writeFile(join(dir, SETTINGS), 'not json');
    const before = await snapshotTree(dir);
    const commands = modCommands(adapterOver(dir));

    const renamed = await commands.renameMod('DragIn Manual Extract', 'Renamed');
    const uninstalled = await commands.uninstallMods(['DragIn Manual Extract'], () => Promise.resolve());

    expect([renamed.applied, uninstalled.applied]).toEqual([false, false]);
    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });
});
