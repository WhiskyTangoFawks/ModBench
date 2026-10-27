import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic, DiagnosticSeverity, FakeDiagnosticCollection, uriParse, Uri,
} from '../../test/vscodeMock';
import {
  filterBoxCommandsMock, filterBoxWindowMock, currentBoxOf, waitForMessage, FakeTreeViews, type FakeInputBox,
} from '../../drivingLib/test/nameFilterViewHarness';

type SqlLens = { provideCodeLenses(document: Pick<vscode.TextDocument, 'getText'>): vscode.CodeLens[] };

const treeViews = new FakeTreeViews();

const h = vi.hoisted(() => ({
  state: { commands: new Map<string, (...args: unknown[]) => unknown>(), boxes: [] as FakeInputBox[] },
  lenses: [] as SqlLens[],
  decorations: [] as { provideFileDecoration(uri: unknown): { badge?: string } | undefined }[],
  diagnostics: new Map<string, FakeDiagnosticCollection>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  contexts: [] as [string, unknown][],
  files: new Map<string, string>(),
  untitled: { uri: 'untitled:Untitled-1' },
  document: undefined as { uri: unknown; fileName: string; getText(): string } | undefined,
  pick: undefined as ((items: { label: string }[]) => { label: string } | undefined) | undefined,
  picked: [] as string[][],
  opened: [] as unknown[],
  shown: [] as unknown[],
}));

vi.mock('vscode', () => {
  const disposable = () => ({ dispose: () => undefined });
  const { state } = h;
  h.commands = state.commands;
  return {
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic,
    DiagnosticSeverity, Uri: { ...Uri, parse: uriParse },
    StatusBarAlignment: { Left: 1 },
    Position: class { constructor(public line: number, public character: number) {} },
    CodeLens: class { constructor(public range: unknown, public command: unknown) {} },
    Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
    window: {
      ...filterBoxWindowMock(state),
      createTreeView: (id: string, options: { treeDataProvider: vscode.TreeDataProvider<unknown> }) => treeViews.create(id, options),
      registerFileDecorationProvider: (provider: (typeof h.decorations)[number]) => {
        h.decorations.push(provider);
        return disposable();
      },
      createStatusBarItem: () => ({ text: '', show: () => undefined, dispose: () => undefined }),
      withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
      showQuickPick: (items: { label: string }[]) => {
        h.picked.push(items.map((item) => item.label));
        return Promise.resolve(h.pick?.(items));
      },
      showTextDocument: (document: unknown) => { h.shown.push(document); return Promise.resolve(); },
    },
    workspace: {
      findFiles: (glob: string) => Promise.resolve(
        [...h.files.keys()].filter((name) => glob !== '**/*.sql' || name.endsWith('.sql')).map(workspaceUri)),
      openTextDocument: (target: { path: string } | { language: string }) => {
        h.opened.push(target);
        if ('language' in target) return Promise.resolve(h.untitled);
        return Promise.resolve(h.document ?? {
          uri: target, getText: () => present(h.files.get(target.path.replace('/workspace/', '')), `the file ${target.path}`),
        });
      },
      asRelativePath: (uri: { path: string }) => uri.path.replace(/^\/workspace\//, ''),
    },
    languages: {
      createDiagnosticCollection: (name: string) => {
        const collection = new FakeDiagnosticCollection();
        h.diagnostics.set(name, collection);
        return collection;
      },
      registerCodeLensProvider: (_selector: unknown, provider: SqlLens) => {
        h.lenses.push(provider);
        return disposable();
      },
    },
    commands: {
      ...filterBoxCommandsMock(state),
      executeCommand: (command: string, ...args: unknown[]) => {
        if (command === 'setContext') h.contexts.push([String(args[0]), args[1]]);
        return Promise.resolve();
      },
    },
  };
});

import { createFocusedView } from '../../drivingLib/focusedView';
import { createPluginsView } from '../pluginsView';
import { createPluginSync, type Sync } from '../../drivingLib/syncFailureReport';
import { NO_PLUGINS_MESSAGE } from '../PluginsTreeProvider';
import { PluginNode } from '../pluginRows';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';
import { soleGroup } from './browserRows';
import type { LoadOrderProgress, LoadOrderSnapshot, PluginMetadata, RecordSummary } from '../../client';
import { loadOrderStatusEventFixture, notificationEventFixture, pluginMetadataFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import { recordingReporter, scriptedDialog, type RecordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const FOUND = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
const ARMOR_SQL = 'SELECT form_key FROM "armo"';
const workspaceUri = (name: string) => ({ scheme: 'file', path: `/workspace/${name}` });

const rowsChanged = notificationEventFixture({ kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', sequence: 1 });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pluginReads = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPlugins').length;

const tick = (over: Parameters<typeof loadOrderStatusEventFixture>[0] = {}) => loadOrderStatusEventFixture(
  { state: 'Reconciling', totalPlugins: 3, activePlugins: 3, conflictsComputed: false, ...over },
);

const silentChannel = { error: vi.fn(), info: vi.fn() };

function syncRefusing() {
  let refusal: string | undefined;
  const pluginSync = createPluginSync(
    () => Promise.resolve(refusal === undefined
      ? { applied: true, wrote: false, added: [], dropped: [] }
      : { applied: false, refusal }),
    silentChannel);
  const run = () => pluginSync.run();
  return {
    pluginSync,
    refuse: async (reason: string) => { refusal = reason; await run(); },
    land: async () => { refusal = undefined; await run(); },
  };
}

function clientHoldingNothing(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', []);
  return client;
}

function pluginsView(
  value = instanceValueFixture(),
  { instance = new FakeInstance(value), client = clientHoldingNothing(), pluginSync = syncRefusing().pluginSync }:
    { instance?: FakeInstance; client?: InMemoryMEditClient; pluginSync?: Sync } = {},
) {
  const recordBrowser = new RecordBrowser(client);
  const reporters = new Map<string, RecordingReporter>();
  const plugins = createPluginsView({
    instance, commands: pluginCommandsWith(fakeInstanceAdapter().adapter), recordBrowser, client,
    pluginSync, modStatuses: NO_MOD_STATUSES,
    channel: silentChannel,
    log: () => undefined,
    reporterFor: (tag) => { const reporter = recordingReporter(); reporters.set(tag, reporter); return reporter; },
    statusBar: { ready: vi.fn(), showMEditState: vi.fn(), dispose: vi.fn() }, registerRepositories: () => Promise.resolve(),
    ask: scriptedDialog(), recordWrite: (command) => command(),
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
  });
  const provider = () => treeViews.view().treeDataProvider;
  const rows = async () => (await provider().getChildren()) ?? [];
  return { client, recordBrowser, plugins, reporters, instance, rows, provider, view: () => treeViews.view() };
}

beforeEach(() => {
  h.lenses.length = 0;
  treeViews.clear();
  h.decorations.length = 0;
  h.diagnostics.clear();
  h.contexts.length = 0;
  h.files.clear();
  h.document = undefined;
  h.pick = undefined;
  h.picked.length = 0;
  h.opened.length = 0;
  h.shown.length = 0;
  h.state.boxes.length = 0;
});

describe('the Plugins view is a tree whose rows select several at once (common.md, story 6; plugins.md)', () => {
  it('selects several rows and has Collapse All', () => {
    const { view } = pluginsView();

    const { canSelectMany, showCollapseAll } = view().options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: true });
  });
});

describe('the Plugins view registers its own gestures', () => {
  it('runs modbench.plugin.create under its own reporter', async () => {
    const { reporters } = pluginsView();

    await present(h.commands.get('modbench.plugin.create'), 'the modbench.plugin.create handler')();

    expect(present(reporters.get('newPlugin'), 'the newPlugin reporter').reports.map((report) => report.message))
      .toEqual(['Could not look up which extensions a plugin may take.']);
  });

  it('hears its copy value in the Plugins view\'s key, and defers for any other', () => {
    const { plugins } = pluginsView();
    expect(plugins.copyValue.reporterTag).toBe('pluginListTree.copyValue');
    expect(plugins.copyValue.text({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(plugins.copyValue.text({ view: 'modbench.pluginListTree' }, undefined)).toBe('');
  });
});

describe('the Plugins view\'s move from the palette', () => {
  it('offers above each row outside the selection, then the bottom of the view', async () => {
    const { rows } = pluginsView(instanceValueFixture({
      plugins: ['A.esp', 'B.esp', 'C.esp'].map((name, line) => ({ name, path: `/fixture/${name}`, origin: 'SomeMod', line, enabled: true, winning: true })),
      gameFolder: FOUND,
    }));
    const [, b] = await rows();
    treeViews.view().selectRows([present(b, 'the B.esp row')]);

    await present(h.commands.get('modbench.plugin.move'), 'the modbench.plugin.move handler')();

    expect(h.picked).toEqual([['A.esp', 'C.esp', 'Bottom of the view']]);
  });
});

describe('the Plugins view\'s selection for a key', () => {
  it('still holds a selected row the rebuilt tree shows, though VS Code reports none until the tree hands its rows back', async () => {
    const { plugins, view, rows } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'A.esp', path: '/fixture/A.esp', origin: 'SomeMod', line: 0, enabled: true, winning: true }], gameFolder: FOUND,
    }));
    const focused = createFocusedView();
    focused.follow('modbench.pluginListTree', plugins.followed);
    const [row] = await rows();

    treeViews.view().selectRows([present(row, 'the plugin row')]);
    expect(view().selection).toEqual([row]);
    Object.assign(view(), { selection: [] });

    expect(focused.selectionOf('modbench.pluginListTree')).toEqual([row]);
  });
});

describe('the Plugins view\'s selection relates to its masters (plugins.md, The highlight, story 4)', () => {
  it('names the row of each master mEdit read from the selected plugin', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'Dep.esp', origin: 'SomeMod', masters: ['Base.esm'] })]);
    const { plugins, rows } = pluginsView(instanceValueFixture({
      plugins: ['Dep.esp', 'Base.esm'].map((name, line) => ({ name, path: `/fixture/${name}`, origin: 'SomeMod', line, enabled: true, winning: true })),
      gameFolder: FOUND,
    }), { client });
    const [dep] = await rows();
    client.emit(rowsChanged);
    await vi.waitFor(() => { expect(pluginReads(client)).toBe(1); });
    await settle();

    expect(plugins.relatesRows.related([present(dep, 'the Dep.esp row')]).plugins).toEqual([{ name: 'Base.esm', origin: 'SomeMod' }]);
  });
});

describe('the Plugins view\'s selection and the highlight (plugins.md, The highlight, stories 3 and 6)', () => {
  const value = () => instanceValueFixture({
    mods: [{ kind: 'mod', name: 'SomeMod', enabled: true }],
    plugins: ['A.esp', 'B.esp'].map((name, line) => ({ name, path: `/fixture/${name}`, origin: 'SomeMod', line, enabled: true, winning: true })),
    gameFolder: FOUND,
  });

  it('relates a selected plugin to the mod it comes from', async () => {
    const { plugins, rows } = pluginsView(value());
    const [a] = await rows();

    expect(plugins.relatesRows.related([present(a, 'the A.esp row')]).origins).toEqual([{ kind: 'mod', name: 'SomeMod' }]);
  });

  it('marks the label of the plugin rows it is handed', async () => {
    const { plugins, rows, provider } = pluginsView(value());

    plugins.drawsHighlight.highlight({ plugins: [{ name: 'B.esp', origin: 'SomeMod' }], origins: [] });

    const marked: string[] = [];
    for (const row of await rows()) {
      const { label } = await provider().getTreeItem(row);
      if (typeof label === 'object' && label.highlights !== undefined) marked.push(label.label);
    }
    expect(marked).toEqual(['B.esp']);
  });
});

const APPLIED_STATUS: LoadOrderProgress = {
  totalPlugins: 3, activePlugins: 3, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};

function snapshotOf(...names: string[]): LoadOrderSnapshot {
  return {
    plugins: names.map((name) => ({
      name, path: `/mods/A/${name}`, origin: 'A', provider: { kind: 'Mod' as const, mod: 'A', folder: '/mods/A' },
      lineNamesIt: true, archives: [], stringsFiles: [],
    })),
    active: [], loadedWithNoLine: [], archives: [], stringsFiles: [], places: [], mods: [], statCache: '/instance/stat-cache',
    dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'English',
  };
}

describe('the Plugins view follows mEdit\'s pushes', () => {
  it.each(['rows-changed', 'plugin-changed'])('re-reads the record browser and the plugin facts on mEdit\'s %s', async (kind) => {
    const { client, recordBrowser } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    client.emit({ ...rowsChanged, kind });

    await vi.waitFor(() => { expect(pluginReads(client)).toBe(1); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('re-reads once when mEdit holds the load order again after a dropped connection, however many plugins it names', async () => {
    const { client, recordBrowser } = pluginsView();
    client.answerPuts(() => Promise.resolve({ outcome: 'applied', status: APPLIED_STATUS }));
    client.setStatus('running');
    await client.sendLoadOrder(snapshotOf('A.esp', 'B.esp', 'C.esp'));
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    client.reconnected();
    await client.latestLoadOrder();

    await vi.waitFor(() => { expect(pluginReads(client)).toBe(1); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('hears no push once disposed', () => {
    const { client, recordBrowser, plugins } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    plugins.dispose();
    client.emit(rowsChanged);
    client.emit({ ...rowsChanged, kind: 'plugin-changed' });

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the Plugins view re-renders for a reconcile tick only when it landed something new, since a re-render re-fetches record types for every expanded row', () => {
  const A = { name: 'A.esp', origin: 'SomeMod' };

  function reconciling() {
    const { client, provider } = pluginsView();
    const rerenders: unknown[] = [];
    provider().onDidChangeTreeData?.((changed) => rerenders.push(changed));
    return { client, rerenders };
  }

  it('re-renders for a tick that landed a new plugin', () => {
    const { client, rerenders } = reconciling();

    client.emit(tick({ indexedPlugins: [A] }));

    expect(rerenders).toHaveLength(1);
  });

  it('does not re-render for a tick that landed nothing new', () => {
    const { client, rerenders } = reconciling();

    client.emit(tick({ indexedPlugins: [A] }));
    client.emit(tick({ indexedPlugins: [A] }));
    client.emit(tick({ indexedPlugins: [A] }));

    expect(rerenders).toHaveLength(1);
  });

  it('re-renders for a tick that landed a failure though no plugin was indexed, since a failed plugin never joins the indexed set', () => {
    const { client, rerenders } = reconciling();

    client.emit(tick({ indexedPlugins: [A] }));
    client.emit(tick({ indexedPlugins: [A], failures: [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }] }));

    expect(rerenders).toHaveLength(2);
  });
});

describe('the Plugins view\'s Problems', () => {
  it('puts a plugin changed outside Modbench on its row\'s own file, at the name it has on disk', () => {
    const onDisk = '/instance/mods/ModA/test.ESP';
    const { client } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'Test.esp', path: onDisk, origin: 'ModA', line: 0, enabled: true, winning: true }],
    }));

    client.emit({ ...rowsChanged, kind: 'external-change', changedPlugins: [{ name: 'Test.esp', bytesSha256: 'ab12' }] });

    const collection = present(h.diagnostics.get('modbench-changed-outside'), 'the changed-outside collection');
    expect([...collection].map(([uri, diagnostics]) => [uri.fsPath, diagnostics.map((d) => d.severity)]))
      .toEqual([[onDisk, [DiagnosticSeverity.Warning]]]);
  });

  it('puts the diagnosis of a failed read on its row\'s own file as an error, and a malformed plugin\'s as a warning', async () => {
    const onDisk = '/instance/mods/ModA/Test.esp';
    const { client } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'Test.esp', path: onDisk, origin: 'ModA', line: 0, enabled: true, winning: true }],
    }));
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getDiagnoses', [
      { plugin: 'Test.esp', origin: 'ModA', text: 'short' },
    ]);

    client.emit(tick({
      state: 'Ready', conflictsComputed: true,
      failures: [{ name: 'Test.esp', origin: 'ModA', reason: 'Could not read this plugin.', diagnosis: 'duplicate FormKey' }],
    }));

    const published = (name: string) => [...present(h.diagnostics.get(name), name)]
      .map(([uri, diagnostics]) => [uri.fsPath, diagnostics.map((d) => [d.message, d.severity])]);
    await vi.waitFor(() => {
      expect(published('modbench-failed-to-read')).toEqual([[onDisk, [['duplicate FormKey', DiagnosticSeverity.Error]]]]);
      expect(published('modbench-diagnosis')).toEqual([[onDisk, [['short', DiagnosticSeverity.Warning]]]]);
    });
  });

  it('links a malformed plugin\'s entry to decompile and repair in a mod, and not in the game folder', async () => {
    const inAMod = '/instance/mods/ModA/Test.esp';
    const inTheGameFolder = '/game/Data/Vanilla.esm';
    const { client } = pluginsView(instanceValueFixture({
      mods: [{ kind: 'mod', name: 'ModA', enabled: true }],
      plugins: [
        { name: 'Test.esp', path: inAMod, origin: 'ModA', line: 0, enabled: true, winning: true },
        { name: 'Vanilla.esm', path: inTheGameFolder, origin: 'Data/', line: 1, enabled: true, winning: true },
      ],
    }));
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getDiagnoses', [
      { plugin: 'Test.esp', origin: 'ModA', text: 'short' },
      { plugin: 'Vanilla.esm', origin: 'Data/', text: 'short' },
    ]);

    client.emit(tick({ state: 'Ready', conflictsComputed: true }));

    await vi.waitFor(() => expect([...present(h.diagnostics.get('modbench-diagnosis'), 'the malformed collection')]
      .map(([uri, diagnostics]) => [uri.fsPath, diagnostics.map((d) => d.code)]))
      .toEqual([
        [inAMod, [{
          value: 'decompile and repair',
          target: uriParse(`command:modbench.plugin.decompileAndRepair?${encodeURIComponent(JSON.stringify([{ name: 'Test.esp', origin: 'ModA' }]))}`),
        }]],
        [inTheGameFolder, [undefined]],
      ]));
  });
});

type BadgeSource = (typeof h.decorations)[number] & { onDidChangeFileDecorations: (listener: (changed: unknown) => void) => unknown };
const badgeSource = () => present(h.decorations.find((provider): provider is BadgeSource => 'onDidChangeFileDecorations' in provider), 'the record badge provider');

describe('a record row\'s badge, from mEdit\'s stream', () => {
  const FORM_KEY = '000001:Test.esp';
  const summary = (workingTreeState: RecordSummary['workingTreeState']): RecordSummary => ({
    formKey: FORM_KEY, plugin: 'Test.esp', loadOrderIndex: 0, isWinner: true, editorId: 'TestNpc', origin: 'ModA',
    workingTreeState, hasContainerChildren: false, hasParseFailure: false,
  });
  const asVsCodeReReadsAnExpandedGroupOnTreeChange = (tree: RecordBrowser, group: RecordBrowserNode) => tree.getChildren(group);

  it('arrives as an M, and a change notice for the row, when mEdit reports the row changed', async () => {
    const { client, recordBrowser } = pluginsView();
    client.setQueryAnswer('getRecords', { items: [summary('None')], total: 1 });
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'NPC_', displayName: 'Non-Player Character' })]);
    const group = await soleGroup(recordBrowser, { name: 'Test.esp', origin: 'ModA' });
    const uri = present((await recordBrowser.getChildren(group))[0]?.resourceUri, "the row's resource URI");
    const badges = badgeSource();
    const badgeChanges: unknown[] = [];
    badges.onDidChangeFileDecorations((changed) => { badgeChanges.push(changed); });
    expect(badges.provideFileDecoration(uri)).toBeUndefined();

    client.setQueryAnswer('getRecords', { items: [summary('Modified')], total: 1 });
    client.emit({ ...rowsChanged, keys: [FORM_KEY] });
    await vi.waitFor(() => { expect(badgeChanges).toEqual([undefined]); });
    await asVsCodeReReadsAnExpandedGroupOnTreeChange(recordBrowser, group);

    expect(badgeChanges).toEqual([undefined, [uri]]);
    expect(badges.provideFileDecoration(uri)?.badge).toBe('M');
  });
});

describe('the Plugins view\'s progress', () => {
  const held = () => {
    const { plugins, view } = pluginsView(instanceValueFixture({ gameFolder: FOUND }));
    view().message = 'Indexing 3/100…';
    const refresh = vi.spyOn(plugins.nameFilter, 'refresh');
    return { view, refresh, progress: plugins.progress };
  };

  it('takes the message line without asking the name filter', () => {
    const { view, refresh, progress } = held();

    progress.say('Starting backend…');

    expect(view().message).toBe('Starting backend…');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gives a cleared line back to the name filter', () => {
    const { view, refresh, progress } = held();

    progress.say(undefined);

    expect(view().message).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears the line when the work it runs fails', async () => {
    const { view, refresh, progress } = held();

    await expect(progress.while(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(view().message).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('the record filter, from the commands that set and clear it', () => {
  function filtering() {
    const { client, recordBrowser, reporters } = pluginsView();
    client.setQueryAnswer('setFilter', null);
    client.setQueryAnswer('clearFilter', null);
    const reporter = present(reporters.get('recordFilter'), 'the record filter reporter');
    const recordBrowserRefreshes: unknown[] = [];
    recordBrowser.onDidChangeTreeData((changed) => recordBrowserRefreshes.push(changed));
    return {
      client, reporter, recordBrowserRefreshes,
      description: () => treeViews.view().description,
      lensOn: (sql: string) => present(h.lenses[0], 'the code lens provider').provideCodeLenses({ getText: () => sql })[0]?.command?.command,
      filterActive: () => h.contexts.filter(([name]) => name === 'modbench.record.filterActive').map(([, value]) => value),
      pluginReadsAre: (count: number) => vi.waitFor(() => { expect(pluginReads(client)).toBe(count); }),
      filter: (...args: unknown[]) => present(h.commands.get('modbench.record.filter'), 'the modbench.record.filter handler')(...args),
      clearFilter: () => present(h.commands.get('modbench.record.clearFilter'), 'the modbench.record.clearFilter handler')(),
      setCalls: () => client.calls.filter((call) => call.method === 'setFilter'),
      activeFilterReads: () => client.calls.filter((call) => call.method === 'getActiveFilter').length,
      holds: (source: string) => client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source }),
    };
  }

  describe('modbench.record.filter, from the picker', () => {
    it('lists the workspace\'s .sql files and no other, then New filter… last', async () => {
      h.files.set('armor.sql', ARMOR_SQL).set('notes.py', '').set('weapons.sql', '');
      const { filter } = filtering();

      await filter();

      expect(h.picked).toEqual([['armor.sql', 'weapons.sql', '$(add) New filter…']]);
    });

    it('applies nothing on Esc', async () => {
      h.files.set('armor.sql', ARMOR_SQL);
      const view = filtering();

      await view.filter();

      expect(view.setCalls()).toEqual([]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
      expect(view.recordBrowserRefreshes).toEqual([]);
    });

    it('applies a picked file\'s SQL, named by the file, and re-reads the records and the matching plugins', async () => {
      h.files.set('armor.sql', ARMOR_SQL);
      h.pick = (items) => items[0];
      const view = filtering();
      view.holds('armor.sql');

      await view.filter();

      expect(view.setCalls()).toEqual([{ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'armor.sql' }] }]);
      expect(view.description()).toBe('records: armor.sql');
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.clearFilter');
      expect(view.filterActive()).toEqual([true]);
      expect(view.recordBrowserRefreshes).toHaveLength(1);
      await view.pluginReadsAre(1);
    });

    it('opens an untitled SQL document for New filter…, and applies nothing', async () => {
      h.pick = (items) => items.at(-1);
      const view = filtering();

      await view.filter();

      expect(h.opened).toEqual([{ language: 'sql' }]);
      expect(h.shown).toEqual([h.untitled]);
      expect(view.setCalls()).toEqual([]);
      expect(view.description()).toBeUndefined();
    });
  });

  describe('modbench.record.filter, from a document', () => {
    const untitled = { scheme: 'untitled', path: 'Untitled-1' };

    it('applies the document\'s text, named by the document, without asking', async () => {
      h.document = { uri: untitled, fileName: 'Untitled-1', getText: () => ARMOR_SQL };
      const view = filtering();
      view.holds('Untitled-1');

      await view.filter(untitled);

      expect(h.picked).toEqual([]);
      expect(view.setCalls()).toEqual([{ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'Untitled-1' }] }]);
      expect(view.description()).toBe('records: Untitled-1');
    });

    it('reports a refused set and shows what mEdit holds', async () => {
      h.document = { uri: untitled, fileName: 'Untitled-1', getText: () => 'SELECT editor_id FROM "npc_"' };
      const view = filtering();
      view.client.setQueryAnswer('setFilter', 'Filter SQL must return a form_key column');
      view.holds('older.sql');

      await view.filter(untitled);

      expect(view.reporter.reports).toEqual([
        { severity: 'error', message: 'Filter failed — Filter SQL must return a form_key column', detail: undefined },
      ]);
      expect(view.description()).toBe('records: older.sql');
    });

    it('reports a read of what mEdit holds that fails after a set that succeeded, and keeps the view', async () => {
      h.document = { uri: untitled, fileName: 'Untitled-1', getText: () => ARMOR_SQL };
      const view = filtering();
      view.client.setQueryFailure('getActiveFilter', { failed: 'refused', refusal: 'boom' });

      await view.filter(untitled);

      expect(view.reporter.reports).toEqual([{ severity: 'error', message: 'Could not read the record filter', detail: 'boom' }]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
    });
  });

  describe('a record filter the record index could not apply again', () => {
    const cleared = (source: string) => notificationEventFixture({
      kind: 'record-filter-cleared', recordFilterCleared: { source, reason: 'Conversion Error' },
    });
    const warned = [{ severity: 'warning', message: 'The record filter a was cleared', detail: 'Conversion Error' }];

    async function showingA() {
      h.document = { uri: { scheme: 'untitled', path: 'a' }, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      view.holds('a');
      await view.filter({ scheme: 'untitled', path: 'a' });
      view.recordBrowserRefreshes.length = 0;
      return view;
    }

    it('shows what mEdit holds, re-reads the records, and warns naming the source and the reason', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);

      view.client.emit(cleared('a'));

      await vi.waitFor(() => { expect(view.reporter.reports).toEqual(warned); });
      expect(view.description()).toBeUndefined();
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.filter');
      expect(view.filterActive()).toEqual([true, false]);
      expect(view.recordBrowserRefreshes).toHaveLength(1);
    });

    it('keeps a newer filter mEdit holds, and only logs a clearing of an older one', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source: 'a' });

      view.client.emit(cleared('older.sql'));

      await vi.waitFor(() => {
        expect(view.reporter.shownFailures).toEqual([
          { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
        ]);
      });
      expect(view.description()).toBe('records: a');
      expect(view.reporter.reports).toEqual([]);
    });

    it('warns when the clearing of another source leaves the view without the filter it showed', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);

      view.client.emit(cleared('older.sql'));

      await vi.waitFor(() => {
        expect(view.reporter.reports).toEqual([
          { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
        ]);
      });
      expect(view.description()).toBeUndefined();
    });

    it('shows no filter when the clearing outruns the reply to the set it clears', async () => {
      h.document = { uri: { scheme: 'untitled', path: 'a' }, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      view.client.setQueryAnswer('getActiveFilter', null);

      const applying = view.filter({ scheme: 'untitled', path: 'a' });
      await vi.waitFor(() => { expect(view.setCalls()).toHaveLength(1); });
      view.client.emit(cleared('a'));
      await vi.waitFor(() => { expect(view.reporter.reports).toEqual(warned); });
      replied(null);
      await applying;

      await vi.waitFor(() => { expect(view.filterActive()).toEqual([false, false]); });
      expect(view.description()).toBeUndefined();
    });
  });

  describe('overlapping applies', () => {
    const documentNamed = (name: string) => {
      h.document = { uri: { scheme: 'untitled', path: name }, fileName: name, getText: () => ARMOR_SQL };
      return { scheme: 'untitled', path: name };
    };

    it('shows what mEdit holds when the earlier apply\'s reply arrives last', async () => {
      const view = filtering();
      let repliedToA!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { repliedToA = resolve; }));
      view.holds('b');
      const applyingA = view.filter(documentNamed('a'));
      await vi.waitFor(() => { expect(view.setCalls()).toHaveLength(1); });
      view.client.setQueryAnswerOnce('setFilter', null);
      await view.filter(documentNamed('b'));

      repliedToA(null);
      await applyingA;

      expect(view.description()).toBe('records: b');
    });

    it('shows the later read when an earlier read of what mEdit holds is handled after it', async () => {
      const view = filtering();
      let readForA!: (held: { sql: string; source: string }) => void;
      view.client.setQueryAnswerOnce('getActiveFilter', new Promise((resolve) => { readForA = resolve; }));
      view.holds('b');
      const applyingA = view.filter(documentNamed('a'));
      await vi.waitFor(() => { expect(view.activeFilterReads()).toBe(1); });
      await view.filter(documentNamed('b'));

      readForA({ sql: ARMOR_SQL, source: 'a' });
      await applyingA;

      expect(view.description()).toBe('records: b');
    });

    it('shows the new copy when the clearing of the old copy of the same source arrives during the re-apply', async () => {
      h.document = { uri: { scheme: 'untitled', path: 'a' }, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      view.holds('a');
      await view.filter({ scheme: 'untitled', path: 'a' });
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      const reapplying = view.filter({ scheme: 'untitled', path: 'a' });
      await vi.waitFor(() => { expect(view.setCalls()).toHaveLength(2); });

      view.client.emit(notificationEventFixture({ kind: 'record-filter-cleared', recordFilterCleared: { source: 'a', reason: 'Conversion Error' } }));
      await vi.waitFor(() => { expect(view.activeFilterReads()).toBe(2); });
      replied(null);
      await reapplying;

      expect(view.description()).toBe('records: a');
    });
  });

  describe('modbench.record.clearFilter', () => {
    const source = { scheme: 'untitled', path: 'a' };
    const applied = async () => {
      h.document = { uri: source, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      view.holds('a');
      await view.filter(source);
      view.recordBrowserRefreshes.length = 0;
      return view;
    };

    it('shows no filter and re-reads the records, as a set does', async () => {
      const view = await applied();
      view.client.setQueryAnswer('getActiveFilter', null);

      await view.clearFilter();

      expect(view.client.calls).toContainEqual({ method: 'clearFilter', args: [] });
      expect(view.description()).toBeUndefined();
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.filter');
      expect(view.filterActive()).toEqual([true, false]);
      expect(view.recordBrowserRefreshes).toHaveLength(1);
    });

    it('re-reads the matching plugins, as a set does', async () => {
      const view = await applied();
      await view.pluginReadsAre(1);

      await view.clearFilter();

      await view.pluginReadsAre(2);
    });

    it('reports a refused clear and keeps showing the filter', async () => {
      const view = await applied();
      view.client.setQueryAnswer('clearFilter', 'No load order has been received yet.');

      await view.clearFilter();

      expect(view.reporter.reports).toEqual([
        { severity: 'error', message: 'Could not clear the record filter — No load order has been received yet.', detail: undefined },
      ]);
      expect(view.description()).toBe('records: a');
    });

    it('shows what mEdit holds after a clear whose reply arrives last', async () => {
      const view = await applied();
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('clearFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      const clearing = view.clearFilter();
      await vi.waitFor(() => { expect(view.client.calls).toContainEqual({ method: 'clearFilter', args: [] }); });
      view.holds('b');
      await view.filter(source);
      replied(null);
      await clearing;

      expect(view.description()).toBe('records: b');
    });
  });
});

describe('the Plugins view\'s message line and name filter', () => {
  const loadOrderPlugin = (name: string): LoadOrderPlugin | LoadOrderPluginLine => (
    { name, path: `/fixture/${name}`, origin: 'SomeMod', line: 0, enabled: true, winning: true });
  const found = (...names: string[]): InstanceValue => instanceValueFixture({ plugins: names.map(loadOrderPlugin), gameFolder: FOUND });
  const notFound = (...names: string[]): InstanceValue =>
    instanceValueFixture({ plugins: names.map(loadOrderPlugin), gameFolder: GAME_FOLDER_NOT_FOUND });
  const GAME_FOLDER_MESSAGE =
    "Game folder not found: set modbench.mods.gameFolder. The Toolbox's Game row names each place Modbench looked.";
  const heldPlugin = (name: string, hasMatchingRecords: boolean): PluginMetadata =>
    pluginMetadataFixture({ name, path: `/fixture/${name}`, hasMatchingRecords });
  const NO_MATCH = 'No matches for "zzznomatch".';
  const currentBox = currentBoxOf(h.state);
  const messageIs = (expected: string | undefined, label: string) =>
    waitForMessage(treeViews.view(), (m) => m === expected, label);

  async function applyFilter(client: InMemoryMEditClient, source: string | undefined) {
    if (source === undefined) {
      client.emit(rowsChanged);
    } else {
      client.setQueryAnswer('setFilter', null);
      client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source });
      h.files.set(source, ARMOR_SQL);
      await present(h.commands.get('modbench.record.filter'), 'the modbench.record.filter handler')(workspaceUri(source));
    }
  }

  async function shown(value: InstanceValue, extra: Parameters<typeof pluginsView>[1] = {}) {
    const result = pluginsView(value, { instance: new FakeInstance(value), ...extra });
    await result.rows();
    return result;
  }

  function typeNoMatch(plugins: { nameFilter: { open(): void } }) {
    plugins.nameFilter.open();
    currentBox().type('zzznomatch');
  }

  describe('a row change with no keystroke', () => {
    it('recomputes the no-match message off a reconcile, in both directions', async () => {
      const { plugins, view, instance } = await shown(found('TestMod.esp'));

      typeNoMatch(plugins);
      await messageIs(NO_MATCH, 'the message after the keystroke');

      instance.publish(found('TestMod.esp', 'zzznomatch.esp'));
      await messageIs(undefined, 'the message clearing once a matching plugin lands');

      instance.publish(found('TestMod.esp'));
      await messageIs(NO_MATCH, 'the message returning once the plugin is gone');
      expect(view().message).toBe(NO_MATCH);
    });
  });

  describe('given the game folder not found', () => {
    it('says so, and keeps its rows', async () => {
      const { rows, instance } = await shown(found('TestMod.esp'));

      instance.publish(notFound('TestMod.esp'));

      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message');
      expect(await rows()).toHaveLength(1);
    });

    it('clears the message on the next value with the game folder found', async () => {
      const { instance } = await shown(found('TestMod.esp'));
      instance.publish(notFound('TestMod.esp'));
      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message');

      instance.publish(found('TestMod.esp'));

      await messageIs(undefined, 'the message clearing');
    });

    it('says nothing before the first read lands', async () => {
      const value = notFound();
      const { plugins, view } = pluginsView(value, { instance: new FakeInstance(value, 0) });

      plugins.nameFilter.refresh();
      await settle();

      expect(view().message).toBeUndefined();
    });

    it('gives the line to the filter\'s no-match message, and takes it back once the filter clears', async () => {
      const { plugins } = await shown(notFound('TestMod.esp'));

      typeNoMatch(plugins);
      await messageIs(NO_MATCH, 'the no-match message');

      plugins.nameFilter.clear();
      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message returning');
    });
  });

  describe('given no lines and no locked plugins', () => {
    it('says so, and shows no row', async () => {
      const { rows } = await shown(found());

      await messageIs(NO_PLUGINS_MESSAGE, 'the empty-list message');
      expect(await rows()).toEqual([]);
    });
  });

  describe('given a record filter that matches nothing', () => {
    async function filteredView(testModMatches: boolean, source?: string) {
      const client = new InMemoryMEditClient();
      client.setQueryAnswer('getPlugins', [heldPlugin('Other.esp', false), heldPlugin('TestMod.esp', testModMatches)]);
      client.setQueryAnswer('getDiagnoses', []);
      const sync = syncRefusing();
      const result = await shown(found('Other.esp', 'TestMod.esp'), { client, pluginSync: sync.pluginSync });
      await applyFilter(client, source);
      return { ...result, client, sync };
    }

    const LAST_SYNC_MESSAGE = 'plugins.txt is not synced: sentinel.';
    async function lineOnceRendersHaveLanded(view: () => { message?: string }, sync: ReturnType<typeof syncRefusing>) {
      await sync.refuse('sentinel');
      await waitForMessage(view(), (m) => m?.endsWith(LAST_SYNC_MESSAGE) === true, 'the sync message reaching the line');
      return view().message;
    }

    it('says so in its message line, naming the source', async () => {
      const { view } = await filteredView(false, 'armor.sql');

      await messageIs('No records match armor.sql.', 'the no-match message');
      expect(view().message).toBe('No records match armor.sql.');
    });

    it('says nothing while the filter matches a record in any plugin', async () => {
      const { view, sync } = await filteredView(true, 'armor.sql');

      expect(await lineOnceRendersHaveLanded(view, sync)).toBe(LAST_SYNC_MESSAGE);
    });

    it('says nothing while no record filter is in force, whatever the facts say', async () => {
      const { view, sync } = await filteredView(false);

      expect(await lineOnceRendersHaveLanded(view, sync)).toBe(LAST_SYNC_MESSAGE);
    });

    it('takes the message back once the filter clears', async () => {
      const { client } = await filteredView(false, 'armor.sql');
      await messageIs('No records match armor.sql.', 'the no-match message');

      client.setQueryAnswer('getPlugins', [heldPlugin('Other.esp', true), heldPlugin('TestMod.esp', true)]);
      client.setQueryAnswer('clearFilter', null);
      await present(h.commands.get('modbench.record.clearFilter'), 'the modbench.record.clearFilter handler')();

      await messageIs(undefined, 'the message clearing');
    });
  });

  describe('given a plugin sync that refused', () => {
    const SYNC_REASON = "the game's Data folder cannot be listed: EACCES";
    const SYNC_MESSAGE = `plugins.txt is not synced: ${SYNC_REASON}.`;
    const NO_RECORD_MATCH = 'No records match armor.sql.';

    async function refusedView(recordFilter?: string) {
      const client = new InMemoryMEditClient();
      client.setQueryAnswer('getPlugins', [heldPlugin('TestMod.esp', false)]);
      client.setQueryAnswer('getDiagnoses', []);
      const sync = syncRefusing();
      const result = await shown(found('TestMod.esp'), { client, pluginSync: sync.pluginSync });
      await applyFilter(client, recordFilter);
      return { ...result, sync };
    }

    it('says it beside the view\'s own message, and drops only its own once the sync lands', async () => {
      const { sync } = await refusedView('armor.sql');

      await sync.refuse(SYNC_REASON);
      await messageIs(`${NO_RECORD_MATCH} ${SYNC_MESSAGE}`, 'both messages');

      await sync.land();
      await messageIs(NO_RECORD_MATCH, 'the view\'s own message alone');
    });

    it('gives the line to the filter\'s no-match message, and takes it back once the filter clears', async () => {
      const { plugins, sync } = await refusedView();
      await sync.refuse(SYNC_REASON);
      await messageIs(SYNC_MESSAGE, 'the sync message');

      typeNoMatch(plugins);
      await messageIs(NO_MATCH, 'the no-match message');

      plugins.nameFilter.clear();
      await messageIs(SYNC_MESSAGE, 'the sync message returning');
    });
  });

  describe('while a load holds it', () => {
    it('keeps the load\'s message when a reconcile tick still matches nothing', async () => {
      const { plugins, view, client } = await shown(found('TestMod.esp'));
      typeNoMatch(plugins);
      await messageIs(NO_MATCH, 'the message after the keystroke');

      plugins.progress.say('Starting backend…');
      client.emit(tick({ indexedPlugins: [{ name: 'TestMod.esp', origin: 'SomeMod' }] }));
      await settle();

      expect(view().message).toBe('Starting backend…');
    });

    it('keeps the load\'s message when a fresh Instance value would otherwise have cleared it', async () => {
      const { plugins, view, instance } = await shown(found('TestMod.esp'));
      typeNoMatch(plugins);
      await messageIs(NO_MATCH, 'the message after the keystroke');

      plugins.progress.say('Starting backend…');
      instance.publish(found('TestMod.esp', 'zzznomatch.esp'));
      await settle();

      expect(view().message).toBe('Starting backend…');
    });

    it('gives the line back to the game folder message once the load clears it', async () => {
      const { plugins, view, instance } = await shown(notFound('TestMod.esp'));

      plugins.progress.say('Starting backend…');
      instance.publish(notFound('TestMod.esp'));
      await settle();
      expect(view().message).toBe('Starting backend…');

      plugins.progress.say(undefined);
      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message returning');
    });

    it('gives the line back to the empty-list message once the load clears it', async () => {
      const { plugins, rows, view, instance } = await shown(found('TestMod.esp'));

      plugins.progress.say('Starting backend…');
      instance.publish(found());
      await rows();
      await settle();
      expect(view().message).toBe('Starting backend…');

      plugins.progress.say(undefined);
      await messageIs(NO_PLUGINS_MESSAGE, 'the empty-list message returning');
    });
  });
});

describe('a collapsed row\'s badge, from the states beneath it', () => {
  it('is a dot on a plugin row with changes beneath it, only while the row is collapsed', async () => {
    const { client, rows } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'A.esp', path: '/fixture/A.esp', origin: 'SomeMod', line: 0, enabled: true, winning: true }],
      gameFolder: FOUND,
    }));
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { plugin: ['Modified'], recordTypes: {}, records: {} });
    const row = expectInstanceOf((await rows())[0], PluginNode);
    const uri = present(row.resourceUri, 'the row\'s resourceUri');
    const badges = badgeSource();
    const badged = new Promise((resolve) => { badges.onDidChangeFileDecorations(resolve); });

    badges.provideFileDecoration(uri);
    await badged;
    const collapsed = badges.provideFileDecoration(uri)?.badge;
    treeViews.view().expand(row);
    const expanded = badges.provideFileDecoration(uri)?.badge;
    treeViews.view().collapse(row);

    expect([collapsed, expanded, badges.provideFileDecoration(uri)?.badge]).toEqual(['•', undefined, '•']);
  });

  it('puts a failed read of the states beneath on the view\'s message line', async () => {
    const { client, rows, view } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'A.esp', path: '/fixture/A.esp', origin: 'SomeMod', line: 0, enabled: true, winning: true }],
      gameFolder: FOUND,
    }));
    client.setQueryFailure('getWorkingTreeStatesBeneath', { failed: 'refused', refusal: 'boom' });
    const row = expectInstanceOf((await rows())[0], PluginNode);

    badgeSource().provideFileDecoration(present(row.resourceUri, 'the row\'s resourceUri'));

    await waitForMessage(view(), (message) => message === 'Failed to load: boom', 'the failed read of the states beneath');
  });
});
