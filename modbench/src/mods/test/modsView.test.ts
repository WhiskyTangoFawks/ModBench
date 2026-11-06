import { ORDER_SENT } from '../../test/orderSent';
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, DataTransferItem, DataTransfer, Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri,
} from '../../test/vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, currentBoxOf, waitForMessage, FakeTreeViews, type FakeTreeView,
} from '../../drivingLib/test/nameFilterViewHarness';

const diagnosticCollections = new Map<string, FakeDiagnosticCollection>();

const h = vi.hoisted(() => ({
  state: {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, unknown>(),
    boxes: [],
  },
  decorationProviders: [] as vscode.FileDecorationProvider[],
  picked: [] as string[][],
  taskTypes: [] as string[],
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri, DataTransferItem, DataTransfer, Diagnostic, DiagnosticSeverity, Range,
  languages: { createDiagnosticCollection: (name: string) => { const collection = new FakeDiagnosticCollection(); diagnosticCollections.set(name, collection); return collection; } },
  tasks: { registerTaskProvider: (type: string) => { h.taskTypes.push(type); return { dispose: () => undefined }; } },
  workspace: {
    ...fakeVscodeModule().workspace,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: vscode.TreeDataProvider<unknown> }) => treeViews.create(id, options),
    showQuickPick: (items: { label: string }[]) => {
      h.picked.push(items.map((item) => item.label));
      return Promise.resolve(undefined);
    },
    registerCustomEditorProvider: () => ({ dispose: () => undefined }),
    withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => {
      h.decorationProviders.push(provider);
      return { dispose: () => undefined };
    },
  },
  commands: {
    ...filterBoxCommandsMock(h.state),
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext' && typeof args[0] === 'string') h.state.contextKeys.set(args[0], args[1]);
      return Promise.resolve();
    },
  },
}));

import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { file, folder, mod } from './indexedValue';
import { ModNode, SeparatorNode } from '../ModListProvider';
import { createModsView } from '../modsView';
import { createFocusedView } from '../../drivingLib/focusedView';
import { ModStatuses } from '../../modStatus/modStatuses';
import { modValueOver } from '../../instanceAdapter/modValue';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestedIn } from '../../test/modStatusFixture';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { createModSync } from '../../drivingLib/syncFailureReport';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { ModSyncRun } from '../../modCommands/modCommands';
import { rowLabelOf } from '../../drivingLib/argument';
import { present } from '../../ports/present';
import { modCommands } from '../../modCommands/modCommands';
import { entryRenameCommands } from '../../modCommands/renameEntry';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import { sourceCommands } from '../../sourceCommands/sourceCommands';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingTasks } from '../../test/recordingTasks';


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
  gamePlaces: () => Promise.resolve([]),
  flaggedHash: () => Promise.resolve(undefined),
  gameFilesTakenBy: () => Promise.resolve({ kind: 'read', answer: { gameFiles: [], notes: [] } }),
  submodule: () => Promise.resolve({ lacks: 'no submodule' }),
  sourceFolderTracked: () => Promise.resolve(false),
  }, folder, asked, heldByGit),
});

const treeViews = new FakeTreeViews();
const currentBox = currentBoxOf(h.state);

const shownRows = async () => (await treeViews.view('modbench.modList').treeDataProvider.getChildren()) ?? [];
const shownLabels = async () => (await shownRows()).map((row) => rowLabelOf(row));

const otherDeps = () => ({
  commands: modCommands(fakeInstanceAdapter().adapter),
  renames: entryRenameCommands({ adapter: fakeInstanceAdapter().adapter, client: new InMemoryMEditClient() }),
  source: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: oneAtATime(), refreshSourceControlFor: () => undefined },
  copyReads: fakeInstanceAdapter().adapter, reporterFor: () => recordingReporter(), ask: scriptedDialog(), trash: vi.fn(),
  extensionUri: Uri.file('/extension'), downloadsView: 'modbench.downloads', channel: { warn: () => undefined },
  focusedView: { id: () => undefined, selection: () => [], selectionOf: () => [], follow: () => ({ dispose: () => undefined }), enter: () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
  statuses: new ModStatuses(foldersHoldingNothing(), () => undefined),
  sourceGestures: {
    commands: sourceCommands({ client: new InMemoryMEditClient(), adapter: fakeInstanceAdapter().adapter, saveUnsaved: () => Promise.resolve([]), loadOrderSnapshot: ORDER_SENT, tasks: recordingTasks(), trash: vi.fn() }),
    pluginsView: 'modbench.pluginListTree', say: () => undefined,
    registerRepositories: () => Promise.resolve(),
  },
  checkForUpdates: vi.fn(),
  manifestGestures: {
    toolboxView: 'modbench.toolbox', commands: { updateManifest: vi.fn(), restoreFromManifest: vi.fn(), otherManifests: vi.fn(), ignoreFiles: vi.fn() }, say: () => undefined,
  },
});

const silentChannel = { error: () => undefined, info: () => undefined };
const modSyncAnswering = (sync: ModSyncRun) => ({
  modSync: createModSync(sync, silentChannel, 'modlist.txt'),
});
const noSync = () => modSyncAnswering(() => Promise.resolve({ applied: true as const, added: [], dropped: [] }));

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

beforeEach(() => {
  h.state.boxes.length = 0;
  h.state.commands.clear();
  treeViews.clear();
  h.state.contextKeys.clear();
  h.decorationProviders.length = 0;
  h.picked.length = 0;
});

describe('the Mods view\'s problems (publishing.md, Publisher tags, story 4)', () => {
  it('publishes a publisher tag that names no path to the Problems panel', () => {
    const file = '/instance/compiler_settings.json';
    const publisherConfiguration = { kind: 'read', covering: () => [], listed: () => [], pathProblems: [{ kind: 'namesNoPath', file, line: 2, tag: { name: 'Ignore', badge: 'IG', marksPaths: true }, entry: 'gone' }], unshippable: { file: '', reason: () => undefined } } as const;
    const instance = new FakeInstance(instanceValueFixture({ publisherConfiguration }));

    createModsView({ ...otherDeps(), instance, ...noSync() });

    expect(diagnosticCollections.get('modbench-publisher')?.has(Uri.file(file))).toBe(true);
  });
});

describe('the Mods view is a tree whose rows select several at once (common.md, story 6; mods.md)', () => {
  it('selects several rows and has Collapse All', () => {
    createModsView({ ...otherDeps(), instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });

    const { canSelectMany, showCollapseAll } = treeViews.view('modbench.modList').options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: true });
  });
});

describe('the Mods filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    const { view: modListView, nameFilter: modListFilter } =
      createModsView({ ...otherDeps(), instance, ...noSync() });
    await shownRows();

    modListFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(modListView.message).toBe('No matches for "zzznomatch".');

    instance.publish(listing([...LISTED_MODS, mod('zzznomatchMod')]));
    await waitForMessage(modListView, (m) => m === undefined, 'the message clearing once a matching mod lands');
    expect(modListView.message).toBeUndefined();

    instance.publish(listing(LISTED_MODS));
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the mod is gone');
    expect(modListView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Mods view\'s description counts the mods', () => {
  it('reads the enabled mods over the listed mods, then the term, counting the whole list', () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    const { view: modListView, nameFilter: modListFilter } = createModsView({ ...otherDeps(), instance, ...noSync() });
    expect(modListView.description).toBe('7 / 8');

    modListFilter.open();
    currentBox().type('radfall');
    expect(modListView.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    const { view: modListView } = createModsView({ ...otherDeps(), instance, ...noSync() });

    instance.publish(listing([...LISTED_MODS, mod('Parked Mod', false)]));

    expect(modListView.description).toBe('7 / 9');
  });
});

describe('the Mods view registers its own gestures', () => {
  it('offers modbench.mod.build from the palette every source in the source folder, the modlist listing it or not', async () => {
    const value = instanceValueFixture({
      paths: { ...instanceValueFixture().paths, sourceDirs: new Map([['Cloned And Unlisted', '/source/Cloned And Unlisted']]) },
    });
    createModsView({ ...otherDeps(), instance: new FakeInstance(value), ...noSync() });

    await present(h.state.commands.get('modbench.mod.build'), 'the modbench.mod.build handler')();

    expect(h.picked).toEqual([['Cloned And Unlisted']]);
  });

  it('says whether any mod is a source mod, for the palette to offer build', () => {
    const value = instanceValueFixture({ sourceMods: new Set(['Source']) });
    createModsView({ ...otherDeps(), instance: new FakeInstance(value), ...noSync() });
    expect(h.state.contextKeys.get('modbench.mod.anySource')).toBe(true);
  });

  it('offers build as a task, for a chain', () => {
    h.taskTypes.length = 0;
    createModsView({ ...otherDeps(), instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });
    expect(h.taskTypes).toEqual(['modbench.mod.build']);
  });

  it('hears its copy value in the Mods view\'s key', () => {
    const { copyValue } = createModsView({ ...otherDeps(), instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });
    expect([copyValue.reporterTag, copyValue.text({ view: 'modbench.modList' }, undefined)]).toEqual(['mod.copyValue', '']);
  });
});

describe('the Mods title-bar sort icons', () => {
  it('set the tree\'s own direction', async () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    createModsView({ ...otherDeps(), instance, ...noSync() });
    const losingAtTop = await shownLabels();

    await h.state.commands.get('modbench.mod.sortWinningAtTop')?.();
    expect(await shownLabels()).toEqual([...losingAtTop].reverse());
    await h.state.commands.get('modbench.mod.sortLosingAtTop')?.();
    expect(await shownLabels()).toEqual(losingAtTop);
  });
});

describe('the Mods view tells its keys, which are handed no row, what the selection holds', () => {
  it('sets the Space direction and the Delete and F2 kind off the selection', () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    createModsView({ ...otherDeps(), instance, ...noSync() });

    const SELECTION_KEYS = ['selectionToggle', 'selectionKind', 'singleRow', 'holdsEnabledMod', 'holdsDisabledMod']
      .map((name) => `modbench.mod.${name}`);
    const keys = () => Object.fromEntries(SELECTION_KEYS.map((key) => [key, h.state.contextKeys.get(key)]));
    const harderVats = new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false });
    const separatorRow = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

    treeViews.view().selectRows([harderVats]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': 'enable', 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': true,
    });

    treeViews.view().selectRows([separatorRow('Radfall - All-In-One Survival Overhaul'), separatorRow('Unassigned (Modlist Development)')]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': undefined, 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': false,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': false,
    });
  });

  it('follows a mod enabled in a new instance value while the selection still holds the row built before', () => {
    const instance = new FakeInstance(listing(LISTED_MODS));
    createModsView({ ...otherDeps(), instance, ...noSync() });
    treeViews.view().selectRows([new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false })]);

    instance.publish(listing(LISTED_MODS.map((m) => (m.name === 'Harder VATS' ? mod('Harder VATS') : m))));

    expect(h.state.contextKeys.get('modbench.mod.selectionToggle')).toBe('disable');
  });
});

describe('the Mods view names its own tags and palette context keys', () => {
  it('reports a downloaded file install under the downloadedFiles tag', () => {
    const tags: string[] = [];
    createModsView({ ...otherDeps(), reporterFor: (tag) => { tags.push(tag); return recordingReporter(); }, instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });

    expect(tags).toContain('downloadedFiles');
  });

  it('sets modbench.mod.sourceGestureRowsIn to the focused view while it is the Mods or Plugins view, and clears it otherwise', () => {
    const focusedView = createFocusedView();
    createModsView({ ...otherDeps(), focusedView, instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });
    const held = () => h.state.contextKeys.get('modbench.mod.sourceGestureRowsIn');

    focusedView.enter('modbench.pluginListTree');
    const inPlugins = held();
    focusedView.enter('modbench.toolbox');

    expect([inPlugins, held()]).toEqual(['modbench.pluginListTree', undefined]);
  });

  it('sets modbench.mod.nexusRowIn to the focused Downloads view while one row with a Nexus id is selected in it', () => {
    const focusedView = createFocusedView();
    createModsView({ ...otherDeps(), focusedView, instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });
    let selected: () => void = () => undefined;
    const downloads: Parameters<typeof focusedView.follow>[1] = {
      selection: [{ nexusModId: '1' }],
      onDidChangeSelection: (listener) => { selected = () => { listener({ selection: [] }); }; return { dispose: () => undefined }; },
    };
    focusedView.follow('modbench.downloads', downloads);

    selected();

    expect(h.state.contextKeys.get('modbench.mod.nexusRowIn')).toBe('modbench.downloads');
  });
});

describe('the Mods view expands by reveal a separator a filter shows for its matching mods', () => {
  let instance: FakeInstance;
  const mountFiltered = (
    term: string, log: (line: string) => void = () => undefined, prepare: (view: FakeTreeView) => void = () => undefined,
  ) => {
    instance = new FakeInstance(listing(LISTED_MODS));
    createModsView({ ...otherDeps(), instance, channel: { warn: log }, ...noSync() }).nameFilter.open();
    prepare(treeViews.view());
    currentBox().type(term);
  };
  const windowForARevealThatMustNotCome = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('reveals it expanded, neither selecting nor focusing it', async () => {
    mountFiltered('source');
    await vi.waitFor(() => expect(treeViews.view().reveals).not.toEqual([]));

    expect(treeViews.view().reveals).toEqual([
      { label: 'Unassigned (Modlist Development)', options: { select: false, focus: false, expand: true } },
    ]);
  });

  it('leaves a separator shown for its own name as the user left it', async () => {
    mountFiltered('radfall - all');
    await windowForARevealThatMustNotCome();

    expect(treeViews.view().reveals).toEqual([]);
  });

  it('writes a reveal VS Code refuses once, by the walk of the tree as it is, when the tree changed under the first', async () => {
    const lines: string[] = [];
    let release = (): void => undefined;
    mountFiltered('source', (line) => lines.push(line), (view) => { view.revealHeldUntil = new Promise((resolve) => { release = resolve; }); });
    await vi.waitFor(() => expect(treeViews.view().revealsHeld).toEqual(['Unassigned (Modlist Development)']));
    instance.publish(instance.value);
    await vi.waitFor(() => expect(treeViews.view().revealsHeld).toHaveLength(2));
    treeViews.view().revealRefusal = new Error('Cannot resolve tree item');
    release();
    await vi.waitFor(() => expect(lines).not.toEqual([]));

    expect(lines).toEqual([
      '[modList] Could not expand "Unassigned (Modlist Development)" for the filter: Cannot resolve tree item',
    ]);
  });

  it('writes a reveal VS Code refuses to the Output, naming the separator and why', async () => {
    const lines: string[] = [];
    mountFiltered('source', (line) => lines.push(line), (view) => { view.revealRefusal = new Error('Cannot resolve tree item'); });
    await vi.waitFor(() => expect(lines).not.toEqual([]));

    expect(lines).toEqual([
      '[modList] Could not expand "Unassigned (Modlist Development)" for the filter: Cannot resolve tree item',
    ]);
  });

  it('reveals nothing while the view is hidden, and reveals it once the view is shown', async () => {
    mountFiltered('source', undefined, (view) => { view.visible = false; });
    await windowForARevealThatMustNotCome();
    const whileHidden = [...treeViews.view().reveals];

    treeViews.view().setVisible(true);
    await vi.waitFor(() => expect(treeViews.view().reveals).not.toEqual([]));

    expect([whileHidden, treeViews.view().reveals.map((r) => r.label)]).toEqual([[], ['Unassigned (Modlist Development)']]);
  });
});

describe('the Mods view says the phase of a version in git fired from it', () => {
  it('says the mod and the phase on its own message line while it runs, gives the agent no phase line, and takes the line back when it lands', async () => {
    let release = () => undefined;
    const running = new Promise<{ landed: []; refused: [] }>((resolve) => { release = () => { resolve({ landed: [], refused: [] }); }; });
    const deps = otherDeps();
    const sourceGestures = { ...deps.sourceGestures, commands: { ...deps.sourceGestures.commands, versionInGit: () => running } };
    const mods = createModsView({ ...deps, sourceGestures, instance: new FakeInstance(listing(LISTED_MODS)), ...noSync() });
    const { view } = mods;
    const handler = present(h.state.commands.get('modbench.mod.versionInGit'), 'the version in git command createModsView registers');

    const fired = handler(new AgentCall([{ kind: 'mod', name: 'Source mod Patch Mod' }], { commit: true, where: 'NewRepository' }));

    await waitForMessage(view, (m) => m === 'Version in git "Source mod Patch Mod"…', 'the phase line');
    expect(mods.standingLines()).toEqual([]);
    release();
    await fired;
    await waitForMessage(view, (m) => m === undefined, 'the line given back');
  });
});

describe('the Mods view says when the list is empty', () => {
  const NO_MODS = 'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

  it('says nothing before the first read, says so once an empty list lands, and gives way to the no-match message', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const { view: modListView, nameFilter: modListFilter } = createModsView({ ...otherDeps(), instance, ...noSync() });
    expect(modListView.message).toBeUndefined();
    expect(modListView.description).toBeUndefined();

    instance.publish(listing([]));
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

    modListFilter.open();
    currentBox().type('zzz');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzz".', 'the no-match message');

    currentBox().type('');
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message back');
  });

  it('says mod sync\'s refusal beside it, and drops only that once the sync lands', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const outcomes = [
      { applied: false as const, refusal: '/instance/mods does not exist' },
      { applied: true as const, added: [], dropped: [] },
    ];
    let run = 0;
    const { modSync } = modSyncAnswering(() => Promise.resolve(present(outcomes[run++], 'an outcome for this run')));
    const { view: modListView } = createModsView({ ...otherDeps(), instance, modSync });
    instance.publish(listing([]));
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

    await modSync.run();
    await waitForMessage(modListView, (m) => m === `${NO_MODS} modlist.txt is not synced: /instance/mods does not exist.`, 'both messages');

    await modSync.run();
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message alone');
  });

  it('gives the agent sync\'s refusal, without the empty-list line the view shows beside it', async () => {
    const instance = new FakeInstance(listing([]), SEQUENCE_NOT_READ_YET);
    const { modSync } = modSyncAnswering(() => Promise.resolve({ applied: false as const, refusal: '/instance/mods does not exist' }));
    const mods = createModsView({ ...otherDeps(), instance, modSync });
    const { view } = mods;
    instance.publish(listing([]));
    await waitForMessage(view, (m) => m === NO_MODS, 'the empty-list message');

    await modSync.run();
    await waitForMessage(view, (m) => m === `${NO_MODS} modlist.txt is not synced: /instance/mods does not exist.`, 'both messages');

    expect(mods.standingLines()).toEqual(['modlist.txt is not synced: /instance/mods does not exist.']);
  });
});

describe('the Mods view finds a file the filter matches, however deep', () => {
  const revealed = () => treeViews.view().reveals.map((r) => r.label);
  const open = { select: false, focus: false, expand: true };

  let instance: FakeInstance;
  const mountFiltered = (term: string, overwrite = false, prepare: (view: FakeTreeView) => void = () => undefined) => {
    const value = instanceValueFixture({
      mods: [mod('Armour'), separator('Gear'), mod('Boots'), separator('Other')],
      filesByMod: new Map([['Armour', [file('Armour', 'textures/armour/b.dds')]], ['Boots', [file('Boots', 'gear.esp')]]]),
      foldersByMod: new Map([['Armour', [folder('Armour', 'textures'), folder('Armour', 'textures/armour')]], ['Boots', []]]),
      overwriteFiles: overwrite ? [file('overwrite', 'F4SE/a.log')] : [],
      overwriteFolders: overwrite ? [folder('overwrite', 'F4SE')] : [],
    });
    instance = new FakeInstance(value);
    const { view: modListView, nameFilter: modListFilter } = createModsView({ ...otherDeps(), instance, ...noSync() });
    modListFilter.open();
    prepare(treeViews.view());
    currentBox().type(term);
    return modListView;
  };

  it('reveals, expanded, each row it shows for its matches: the separator, the mod and each folder', async () => {
    mountFiltered('b.dds');
    await vi.waitFor(() => expect(revealed()).toContain('armour'));

    expect(treeViews.view().reveals).toEqual(['Gear', 'Armour', 'textures', 'armour'].map((label) => ({ label, options: open })));
  });

  it('ends a walk the tree changed under after the reveal in hand, so only the walk of the tree as it is goes deeper', async () => {
    let release = (): void => undefined;
    mountFiltered('b.dds', false, (view) => { view.revealHeldUntil = new Promise((resolve) => { release = resolve; }); });
    await vi.waitFor(() => expect(treeViews.view().revealsHeld).toEqual(['Gear']));
    instance.publish(instance.value);
    release();
    await vi.waitFor(() => expect(revealed()).toContain('armour'));

    expect(revealed()).toEqual(['Gear', 'Gear', 'Armour', 'textures', 'armour']);
  });

  it('does not reveal a row shown for its own name, nor the rows under it, while it reveals one shown for a match', async () => {
    const view = mountFiltered('gear');
    await vi.waitFor(() => expect(revealed()).toContain('Boots'));

    expect(view.description).toContain('"gear"');
    expect(revealed()).toEqual(['Other', 'Boots']);
  });

  it('is not told no match by a term that only an Overwrite file matches, and reveals Overwrite open', async () => {
    const view = mountFiltered('a.log', true);
    await vi.waitFor(() => expect(revealed()).toContain('F4SE'));

    expect(view.message).toBeUndefined();
    expect(revealed()).toEqual(['Overwrite', 'F4SE']);
  });

  it('is told no match by a term that only the name Overwrite matches', async () => {
    const view = mountFiltered('overwrite', true);
    await waitForMessage(view, (m) => m === 'No matches for "overwrite".', 'the no-match message');

    expect(revealed()).toEqual([]);
  });
});

const listenToEachDecorationProvider = () => {
  const listeners = h.decorationProviders.map((provider) => {
    const listener = vi.fn();
    provider.onDidChangeFileDecorations?.(listener);
    return listener;
  });
  return () => listeners.map((listener) => listener.mock.calls.length);
};

describe('the Mods view tells the indicator and publisher tag decorations when a separator opens or closes', () => {
  it('asks VS Code to decorate again, for each indicator and each publisher tag the publisher declares, on the separator\'s expand and on its collapse', async () => {
    const publisherTags = [{ name: 'Include', badge: 'IN', marksPaths: true }] as const;
    createModsView({
      ...otherDeps(), instance: new FakeInstance(instanceValueFixture({ mods: [mod('A'), separator('Section')], publisherTags })), ...noSync(),
    });
    const fired = listenToEachDecorationProvider();
    const row = present((await shownRows()).find((node) => node instanceof SeparatorNode), 'the separator row');

    treeViews.view().expand(row);
    const afterExpand = fired();
    treeViews.view().collapse(row);

    expect([afterExpand, fired()]).toEqual([[0, 1, 1, 1, 1, 1, 1], [0, 2, 2, 2, 2, 2, 2]]);
  });
});

describe('the Mods view\'s status of each mod (mods.md, The view; common.md, Reporting)', () => {
  const holdingModA = instanceValueFixture({
    holdsRepository: true, mods: [mod('ModA'), mod('ModB')], modFolders: [{ kind: 'mod', name: 'ModA', path: '/nowhere/ModA', modName: 'ModA' }],
  });

  it('counts each mod Mod status derives with no manifest', async () => {
    const statuses = new ModStatuses(foldersHoldingNothing(), () => undefined);
    const { view } = createModsView({ ...otherDeps(), instance: new FakeInstance(holdingModA), ...noSync(), statuses });

    statuses.derive(holdingModA);

    await vi.waitFor(() => { expect(view.badge).toEqual({ value: 1, tooltip: 'Mods that differ from their manifests or have none: 1' }); });
  });

  it('says on the message line that a status could not be read, while the instance holds a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modsView-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const folder = join(root, 'ModA');
    await manifestedIn(folder);
    const holdingManifested = instanceValueFixture({ holdsRepository: true, mods: [mod('ModA')], modFolders: [{ kind: 'mod', name: 'ModA', path: folder, modName: 'ModA' }] });
    const statuses = new ModStatuses(foldersHoldingNothing(() => Promise.reject(new Error('EACCES'))), () => undefined);
    const { view } = createModsView({ ...otherDeps(), instance: new FakeInstance(holdingManifested), ...noSync(), statuses });

    statuses.derive(holdingManifested);

    await waitForMessage(view, (message) => message === 'Showing the last good read: the status of "ModA" could not be read: a file could not be read: EACCES.',
      'the unreadable status');
  });
});

describe('the Mods view\'s selection and the highlight (plugins.md, The highlight; mods.md, The tree, story 11)', () => {
  const held = instanceValueFixture({
    mods: [mod('Alpha'), mod('Beta')],
    plugins: [{ name: 'A.esp', path: '/Alpha/A.esp', origin: 'Alpha', line: 0, enabled: true, winning: true }],
    filesByMod: new Map([['Alpha', [file('Alpha', 'A.esp')]]]),
  });
  const view = () => createModsView({ ...otherDeps(), instance: new FakeInstance(held), ...noSync() });

  it('relates a selected mod to the plugin rows it holds, and to no mod row', async () => {
    const { relatesRows } = view();
    const alpha = (await shownRows()).find((row) => rowLabelOf(row) === 'Alpha');

    expect(relatesRows.related([present(alpha, 'the Alpha row')])).toEqual({ plugins: [{ name: 'A.esp', origin: 'Alpha' }], origins: [] });
  });

  it('marks the label of the mod rows it is handed the origins of', async () => {
    const { drawsHighlight } = view();

    drawsHighlight.highlight({ plugins: [], origins: [{ kind: 'mod', name: 'Beta' }] });

    const marked: string[] = [];
    for (const row of await shownRows()) {
      const { label } = await treeViews.view('modbench.modList').treeDataProvider.getTreeItem(row);
      if (typeof label === 'object' && label.highlights !== undefined) marked.push(label.label);
    }
    expect(marked).toEqual(['Beta']);
  });
});
