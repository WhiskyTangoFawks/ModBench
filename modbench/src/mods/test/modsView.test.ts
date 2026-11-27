import { describe, it, expect, vi, onTestFinished } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { everyChainedPromiseSettled, modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import { currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { Uri } from '../../test/vscodeMock';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { file, folder, indexedValueOf, mod } from './indexedValue';
import { modArgumentOf, separatorArgumentOf } from '../../drivingLib/argument';
import { ModStatuses } from '../../modStatus/modStatuses';
import { modValueOver } from '../../instanceAdapter/modValue';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestedIn } from '../../test/modStatusFixture';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { createModSync } from '../../drivingLib/syncFailureReport';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { ModSyncRun } from '../../modCommands/modCommands';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled } from '../../test/eventually';

const foldersHoldingNothing = (listing: () => Promise<readonly string[]> = () => Promise.resolve([])): Pick<InstanceAdapter, 'modValue' | 'installationFile' | 'foldersHeldWhole' | 'filesHeldByGit'> => ({
  foldersHeldWhole: () => Promise.resolve(new Set()),
  filesHeldByGit: () => Promise.resolve(new Map()),
  installationFile: () => Promise.resolve({ kind: 'read', answer: undefined }),
  modValue: (folder, asked, heldByGit) => modValueOver({
  filesIn: listing,
  fileStamp: () => Promise.resolve({ kind: 'unreadable', reason: 'ENOENT' }),
  originFileHash: () => Promise.resolve({ kind: 'unreadable', reason: 'ENOENT' }),
  exclusionMark: '.mohidden',
  downloadedFile: () => Promise.resolve({ kind: 'read', answer: undefined }),
  gamePlace: () => Promise.resolve(undefined),
  gameFilesTakenBy: () => Promise.resolve({ kind: 'read', answer: { gameFiles: [], notes: [] } }),
  submodule: () => Promise.resolve({ lacks: 'no submodule' }),
  sourceFolderTracked: () => Promise.resolve(false),
  }, folder, asked, heldByGit),
});

const currentBox = currentBoxOf(seen);

const silentChannel = { error: () => undefined, info: () => undefined };
const modSyncAnswering = (sync: ModSyncRun) => createModSync(sync, silentChannel, 'modlist.txt');

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const LISTED_MODS: ModlistEntry[] = [
  mod('Ñoño\'s Retexture'), mod('Source mod Patch Mod'), mod('SKK Fast Start new game (Fallout 4)'),
  separator('Unassigned (Modlist Development)'),
  mod('[NODELETE] Radfall'), mod('Unofficial Fallout 4 Patch'),
  separator('Radfall - All-In-One Survival Overhaul'),
  mod('ENBoost - 12k'), mod('Harder VATS', false), mod('Cracked and Smudged Pip-Boy Screen'),
];

const listing = (mods: ModlistEntry[]) => instanceValueFixture({ mods });
const SEQUENCE_NOT_READ_YET = 0;

const listed = () => modsViewOn({ value: listing(LISTED_MODS) });

describe('the Mods view\'s problems (publishing.md, Publisher tags, story 4)', () => {
  it('publishes a publisher tag that names no path to the Problems panel', () => {
    const file = '/instance/compiler_settings.json';
    const publisherConfiguration = { kind: 'read', covering: () => [], listed: () => [], pathProblems: [{ kind: 'namesNoPath', file, line: 2, tag: { name: 'Ignore', badge: 'IG', marksPaths: true }, entry: 'gone' }], unshippable: { file: '', reason: () => undefined } } as const;

    const { diagnostics } = modsViewOn({ value: instanceValueFixture({ publisherConfiguration }) });

    expect(diagnostics('modbench-publisher').has(Uri.file(file))).toBe(true);
  });
});

describe('the Mods view is a tree whose rows select several at once (common.md, story 6; mods.md)', () => {
  it('selects several rows and has Collapse All', () => {
    const { view } = listed();

    const { canSelectMany, showCollapseAll } = view.options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: true });
  });
});

describe('the Mods filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const { mods, view, instance, rows } = listed();
    await rows();

    mods.nameFilter.open();
    currentBox().type('zzznomatch');
    await settled(() => { expect(view.message).toBe('No matches for "zzznomatch".'); });

    instance.publish(listing([...LISTED_MODS, mod('zzznomatchMod')]));
    await settled(() => { expect(view.message).toBeUndefined(); });

    instance.publish(listing(LISTED_MODS));
    await settled(() => { expect(view.message).toBe('No matches for "zzznomatch".'); });
  });
});

describe('the Mods view\'s description counts the mods', () => {
  it('reads the enabled mods over the listed mods, then the term, counting the whole list', () => {
    const { mods, view } = listed();
    expect(view.description).toBe('7 / 8');

    mods.nameFilter.open();
    currentBox().type('radfall');
    expect(view.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', () => {
    const { view, instance } = listed();

    instance.publish(listing([...LISTED_MODS, mod('Parked Mod', false)]));

    expect(view.description).toBe('7 / 9');
  });
});

describe('the Mods view registers its own gestures', () => {
  it('offers modbench.mod.build from the palette every source in the source folder, the modlist listing it or not', async () => {
    const value = instanceValueFixture({
      paths: { ...instanceValueFixture().paths, sourceDirs: new Map([['Cloned And Unlisted', '/source/Cloned And Unlisted']]) },
    });
    const { run } = modsViewOn({ value });

    await run('modbench.mod.build');

    expect(seen.quickPicks.map(({ labels }) => labels)).toEqual([['Cloned And Unlisted']]);
  });

  it('says whether any mod is a source mod, for the palette to offer build', () => {
    modsViewOn({ value: instanceValueFixture({ sourceMods: new Set(['Source']) }) });
    expect(seen.contextKeys.get('modbench.mod.anySource')).toBe(true);
  });

  it('offers build as a task, for a chain', () => {
    listed();
    expect([...seen.taskProviders.keys()]).toEqual(['modbench.mod.build']);
  });

  it('says the tooltip of a mod\'s row, and none for a separator or a mod it lists no row for', () => {
    const { mods } = listed();

    expect([
      mods.tooltipOf({ kind: 'mod', name: 'Harder VATS' }), mods.tooltipOf({ kind: 'separator', name: 'Unassigned (Modlist Development)' }), mods.tooltipOf({ kind: 'mod', name: 'Gone' }),
    ]).toEqual(['Harder VATS', undefined, undefined]);
  });

  it('names the separator a separator row stands for', async () => {
    const { row } = modsViewOn({ value: listing([mod('A'), separator('Gear')]) });

    expect(separatorArgumentOf(await row('Gear'))).toEqual({ kind: 'separator', name: 'Gear' });
  });

  it('says the one selected mod row to Symbols, and none over several rows or a separator', async () => {
    const { mods, view, row } = listed();
    const [harderVats, enboost, radfall] = [await row('Harder VATS'), await row('ENBoost - 12k'), await row('Radfall - All-In-One Survival Overhaul')];

    view.selectRows([harderVats]);
    const one = modArgumentOf(mods.symbolRows.selected());
    view.selectRows([harderVats, enboost]);
    const several = mods.symbolRows.selected();
    view.selectRows([radfall]);

    expect([one, several, mods.symbolRows.selected()]).toEqual([{ kind: 'mod', name: 'Harder VATS' }, undefined, undefined]);
  });

  it('says the Data folder path a file row stands for, and none for any other argument', async () => {
    const value = await indexedValueOf(
      [mod('Harder VATS')], { 'Harder VATS': { files: [file('Harder VATS', 'meshes/a.nif'), file('Harder VATS', 'Main.ba2')], folders: [folder('Harder VATS', 'meshes')] } },
      { files: [] }, [{ origin: modOrigin('Harder VATS'), archive: '/instance/Harder VATS/Main.ba2', files: ['meshes/b.nif'] }],
    );
    const { mods, row } = modsViewOn({ value });
    const owner = await row('Harder VATS');
    const archived = await row('meshes', await row('Main.ba2', owner));

    expect([
      mods.symbolRows.dataPathOf(await row('a.nif', await row('meshes', owner))), mods.symbolRows.dataPathOf(await row('b.nif', archived)), mods.symbolRows.dataPathOf(owner),
    ]).toEqual(['meshes/a.nif', 'meshes/b.nif', undefined]);
  });

  it('hears its copy value in the Mods view\'s key', () => {
    const { mods } = listed();
    expect([mods.copyValue.reporterTag, mods.copyValue.text({ view: 'modbench.modList' }, undefined)]).toEqual(['mod.copyValue', '']);
  });
});

describe('the Mods title-bar sort icons', () => {
  it('set the tree\'s own direction', async () => {
    const { labels, run } = listed();
    const losingAtTop = await labels();

    await run('modbench.mod.sortWinningAtTop');
    expect(await labels()).toEqual([...losingAtTop].reverse());
    await run('modbench.mod.sortLosingAtTop');
    expect(await labels()).toEqual(losingAtTop);
  });
});

describe('the Mods view tells its keys, which are handed no row, what the selection holds', () => {
  const SELECTION_KEYS = ['selectionToggle', 'selectionKind', 'singleRow', 'holdsEnabledMod', 'holdsDisabledMod'].map((name) => `modbench.mod.${name}`);
  const keys = () => Object.fromEntries(SELECTION_KEYS.map((key) => [key, seen.contextKeys.get(key)]));

  it('sets the Space direction and the Delete and F2 kind off the selection', async () => {
    const { view, row } = listed();

    view.selectRows([await row('Harder VATS')]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': 'enable', 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': true,
    });

    view.selectRows([await row('Radfall - All-In-One Survival Overhaul'), await row('Unassigned (Modlist Development)')]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': undefined, 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': false,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': false,
    });
  });

  it('follows a mod enabled in a new instance value while the selection still holds the row built before', async () => {
    const { view, row, instance } = listed();
    view.selectRows([await row('Harder VATS')]);

    instance.publish(listing(LISTED_MODS.map((m) => (m.name === 'Harder VATS' ? mod('Harder VATS') : m))));

    expect(seen.contextKeys.get('modbench.mod.selectionToggle')).toBe('disable');
  });
});

describe('the Mods view names its own tags and palette context keys', () => {
  it('reports a downloaded file install under the downloadedFiles tag', () => {
    const { tags } = listed();

    expect(tags).toContain('downloadedFiles');
  });

  it('sets modbench.mod.sourceGestureRowsIn to the focused view while it is the Mods or Plugins view, and clears it otherwise', () => {
    const { focusedView } = listed();
    const held = () => seen.contextKeys.get('modbench.mod.sourceGestureRowsIn');

    focusedView.enter('modbench.pluginListTree');
    const inPlugins = held();
    focusedView.enter('modbench.toolbox');

    expect([inPlugins, held()]).toEqual(['modbench.pluginListTree', undefined]);
  });

  it('sets modbench.mod.nexusRowIn to the focused Downloads view while one row with a Nexus id is selected in it', () => {
    const { focusedView } = listed();
    let selected: () => void = () => undefined;
    const downloads: Parameters<typeof focusedView.follow>[1] = {
      selection: [{ nexusModId: '1' }],
      onDidChangeSelection: (listener) => { selected = () => { listener({ selection: [] }); }; return { dispose: () => undefined }; },
    };
    focusedView.follow('modbench.downloads', downloads);

    selected();

    expect(seen.contextKeys.get('modbench.mod.nexusRowIn')).toBe('modbench.downloads');
  });
});

type ShownView = ReturnType<typeof modsViewOn>['view'];

describe('the Mods view expands by reveal a separator a filter shows for its matching mods', () => {
  const mountFiltered = (term: string, prepare: (view: ShownView) => void = () => undefined) => {
    const shown = listed();
    shown.mods.nameFilter.open();
    prepare(shown.view);
    currentBox().type(term);
    return shown;
  };

  it('reveals it expanded, neither selecting nor focusing it', async () => {
    const { view } = mountFiltered('source');
    await settled(() => expect(view.reveals).not.toEqual([]));

    expect(view.reveals).toEqual([
      { label: 'Unassigned (Modlist Development)', options: { select: false, focus: false, expand: true } },
    ]);
  });

  it('leaves a separator shown for its own name as the user left it', async () => {
    const { view } = mountFiltered('radfall - all');
    await everyChainedPromiseSettled();

    expect(view.reveals).toEqual([]);
  });

  it('writes a reveal VS Code refuses once, by the walk of the tree as it is, when the tree changed under the first', async () => {
    let release = (): void => undefined;
    const { view, instance, lines } = mountFiltered('source', (view) => { view.revealHeldUntil = new Promise((resolve) => { release = resolve; }); });
    await settled(() => expect(view.revealsHeld).toEqual(['Unassigned (Modlist Development)']));
    instance.publish(instance.value);
    await settled(() => expect(view.revealsHeld).toHaveLength(2));
    view.revealRefusal = new Error('Cannot resolve tree item');
    release();
    await settled(() => expect(lines).not.toEqual([]));

    expect(lines).toEqual([
      '[modList] Could not expand "Unassigned (Modlist Development)" for the filter: Cannot resolve tree item',
    ]);
  });

  it('writes a reveal VS Code refuses to the Output, naming the separator and why', async () => {
    const { lines } = mountFiltered('source', (view) => { view.revealRefusal = new Error('Cannot resolve tree item'); });
    await settled(() => expect(lines).not.toEqual([]));

    expect(lines).toEqual([
      '[modList] Could not expand "Unassigned (Modlist Development)" for the filter: Cannot resolve tree item',
    ]);
  });

  it('reveals nothing while the view is hidden, and reveals it once the view is shown', async () => {
    const { view } = mountFiltered('source', (view) => { view.visible = false; });
    await everyChainedPromiseSettled();
    const whileHidden = [...view.reveals];

    view.setVisible(true);
    await settled(() => expect(view.reveals).not.toEqual([]));

    expect([whileHidden, view.reveals.map((r) => r.label)]).toEqual([[], ['Unassigned (Modlist Development)']]);
  });
});

describe('the Mods view says the phase of a version in git fired from it', () => {
  it('says the mod and the phase on its own message line while it runs, gives the agent no phase line, and takes the line back when it lands', async () => {
    let release = () => undefined;
    const running = new Promise<{ landed: []; refused: [] }>((resolve) => { release = () => { resolve({ landed: [], refused: [] }); }; });
    const { mods, view, run } = modsViewOn({ value: listing(LISTED_MODS), sourceCommands: { versionInGit: () => running } });

    const fired = run('modbench.mod.versionInGit', new AgentCall([{ kind: 'mod', name: 'Source mod Patch Mod' }], { commit: true, where: 'NewRepository' }));

    await settled(() => { expect(view.message).toBe('Version in git "Source mod Patch Mod"…'); });
    expect(mods.standingLines()).toEqual([]);
    release();
    await fired;
    await settled(() => { expect(view.message).toBeUndefined(); });
  });
});

describe('the Mods view says when the list is empty', () => {
  const NO_MODS = 'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

  it('says nothing before the first read, says so once an empty list lands, and gives way to the no-match message', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const { mods, view } = modsViewOn({ instance });
    expect(view.message).toBeUndefined();
    expect(view.description).toBeUndefined();

    instance.publish(listing([]));
    await settled(() => { expect(view.message).toBe(NO_MODS); });

    mods.nameFilter.open();
    currentBox().type('zzz');
    await settled(() => { expect(view.message).toBe('No matches for "zzz".'); });

    currentBox().type('');
    await settled(() => { expect(view.message).toBe(NO_MODS); });
  });

  it('says mod sync\'s refusal beside it, and drops only that once the sync lands', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const outcomes = [
      { applied: false as const, refusal: '/instance/mods does not exist' },
      { applied: true as const, added: [], dropped: [] },
    ];
    let run = 0;
    const modSync = modSyncAnswering(() => Promise.resolve(present(outcomes[run++], 'an outcome for this run')));
    const { view } = modsViewOn({ instance, modSync });
    instance.publish(listing([]));
    await settled(() => { expect(view.message).toBe(NO_MODS); });

    await modSync.run();
    await settled(() => { expect(view.message).toBe(`${NO_MODS} modlist.txt is not synced: /instance/mods does not exist.`); });

    await modSync.run();
    await settled(() => { expect(view.message).toBe(NO_MODS); });
  });

  it('gives the agent sync\'s refusal, without the empty-list line the view shows beside it', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const modSync = modSyncAnswering(() => Promise.resolve({ applied: false as const, refusal: '/instance/mods does not exist' }));
    const { mods, view } = modsViewOn({ instance, modSync });
    instance.publish(listing([]));
    await settled(() => { expect(view.message).toBe(NO_MODS); });

    await modSync.run();
    await settled(() => { expect(view.message).toBe(`${NO_MODS} modlist.txt is not synced: /instance/mods does not exist.`); });

    expect(mods.standingLines()).toEqual(['modlist.txt is not synced: /instance/mods does not exist.']);
  });
});

describe('the Mods view finds a file the filter matches, however deep', () => {
  const open = { select: false, focus: false, expand: true };

  const mountFiltered = (term: string, overwrite = false, prepare: (view: ShownView) => void = () => undefined) => {
    const value = instanceValueFixture({
      mods: [mod('Armour'), separator('Gear'), mod('Boots'), separator('Other')],
      filesByMod: new Map([['Armour', [file('Armour', 'textures/armour/b.dds')]], ['Boots', [file('Boots', 'gear.esp')]]]),
      foldersByMod: new Map([['Armour', [folder('Armour', 'textures'), folder('Armour', 'textures/armour')]], ['Boots', []]]),
      overwriteFiles: overwrite ? [file('overwrite', 'F4SE/a.log')] : [],
      overwriteFolders: overwrite ? [folder('overwrite', 'F4SE')] : [],
    });
    const shown = modsViewOn({ value });
    shown.mods.nameFilter.open();
    prepare(shown.view);
    currentBox().type(term);
    return { ...shown, revealed: () => shown.view.reveals.map((r) => r.label) };
  };

  it('reveals, expanded, each row it shows for its matches: the separator, the mod and each folder', async () => {
    const { view, revealed } = mountFiltered('b.dds');
    await settled(() => expect(revealed()).toContain('armour'));

    expect(view.reveals).toEqual(['Gear', 'Armour', 'textures', 'armour'].map((label) => ({ label, options: open })));
  });

  it('ends a walk the tree changed under after the reveal in hand, so only the walk of the tree as it is goes deeper', async () => {
    let release = (): void => undefined;
    const { view, instance, revealed } = mountFiltered('b.dds', false, (view) => { view.revealHeldUntil = new Promise((resolve) => { release = resolve; }); });
    await settled(() => expect(view.revealsHeld).toEqual(['Gear']));
    instance.publish(instance.value);
    release();
    await settled(() => expect(revealed()).toContain('armour'));

    expect(revealed()).toEqual(['Gear', 'Gear', 'Armour', 'textures', 'armour']);
  });

  it('does not reveal a row shown for its own name, nor the rows under it, while it reveals one shown for a match', async () => {
    const { view, revealed } = mountFiltered('gear');
    await settled(() => expect(revealed()).toContain('Boots'));

    expect(view.description).toContain('"gear"');
    expect(revealed()).toEqual(['Other', 'Boots']);
  });

  it('is not told no match by a term that only an Overwrite file matches, and reveals Overwrite open', async () => {
    const { view, revealed } = mountFiltered('a.log', true);
    await settled(() => expect(revealed()).toContain('F4SE'));

    expect(view.message).toBeUndefined();
    expect(revealed()).toEqual(['Overwrite', 'F4SE']);
  });

  it('is told no match by a term that only the name Overwrite matches', async () => {
    const { view, revealed } = mountFiltered('overwrite', true);
    await settled(() => { expect(view.message).toBe('No matches for "overwrite".'); });

    expect(revealed()).toEqual([]);
  });
});

const listenToEachDecorationProvider = () => {
  const listeners = seen.decorationProviders.map((provider) => {
    const listener = vi.fn();
    provider.onDidChangeFileDecorations?.(listener);
    return listener;
  });
  return () => listeners.map((listener) => listener.mock.calls.length);
};

describe('the Mods view tells the indicator and publisher tag decorations when a separator opens or closes', () => {
  it('asks VS Code to decorate again, for each indicator and each publisher tag the publisher declares, on the separator\'s expand and on its collapse', async () => {
    const publisherTags = [{ name: 'Include', badge: 'IN', marksPaths: true }] as const;
    const { view, row } = modsViewOn({ value: instanceValueFixture({ mods: [mod('A'), separator('Section')], publisherTags }) });
    const fired = listenToEachDecorationProvider();
    const section = await row('Section');

    view.expand(section);
    const afterExpand = fired();
    view.collapse(section);

    expect([afterExpand, fired()]).toEqual([[0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]]);
  });
});

describe('the Mods view\'s status of each mod (mods.md, The view; common.md, Reporting)', () => {
  const holdingModA = instanceValueFixture({
    holdsRepository: true, mods: [mod('ModA'), mod('ModB')], modFolders: [{ kind: 'mod', name: 'ModA', path: '/nowhere/ModA', modName: 'ModA' }],
  });

  it('counts each mod Mod status derives with no manifest', async () => {
    const statuses = new ModStatuses(foldersHoldingNothing(), () => undefined, () => Promise.resolve([]));
    const { view } = modsViewOn({ value: holdingModA, statuses });

    statuses.derive(holdingModA);

    await settled(() => { expect(view.badge).toEqual({ value: 1, tooltip: 'Mods that differ from their manifests or have none: 1' }); });
  });

  it('says on the message line that a status could not be read, while the instance holds a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modsView-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const folder = join(root, 'ModA');
    await manifestedIn(folder);
    const holdingManifested = instanceValueFixture({ holdsRepository: true, mods: [mod('ModA')], modFolders: [{ kind: 'mod', name: 'ModA', path: folder, modName: 'ModA' }] });
    const statuses = new ModStatuses(foldersHoldingNothing(() => Promise.reject(new Error('EACCES'))), () => undefined, () => Promise.resolve([]));
    const { view } = modsViewOn({ value: holdingManifested, statuses });

    statuses.derive(holdingManifested);

    await settled(() => { expect(view.message).toBe('Showing the last good read: the status of "ModA" could not be read: a file could not be read: EACCES.'); });
  });
});

describe('the Mods view\'s selection and the highlight (plugins.md, The highlight; mods.md, The tree, story 11)', () => {
  const held = instanceValueFixture({
    mods: [mod('Alpha'), mod('Beta')],
    plugins: [{ name: 'A.esp', path: '/Alpha/A.esp', origin: 'Alpha', line: 0, enabled: true, winning: true }],
    filesByMod: new Map([['Alpha', [file('Alpha', 'A.esp')]]]),
  });

  it('relates a selected mod to the plugin rows it holds, and to no mod row', async () => {
    const { mods, row } = modsViewOn({ value: held });

    expect(mods.relatesRows.related([await row('Alpha')])).toEqual({ plugins: [{ name: 'A.esp', origin: 'Alpha' }], origins: [] });
  });

  it('marks the label of the mod rows it is handed the origins of', async () => {
    const { mods, rows } = modsViewOn({ value: held });

    mods.drawsHighlight.highlight({ plugins: [], origins: [{ kind: 'mod', name: 'Beta' }] });

    expect((await rows()).map(({ label }) => label)).toEqual([{ label: '0 Beta', highlights: [[0, 6]] }, '1 Alpha', 'Overwrite']);
  });
});
