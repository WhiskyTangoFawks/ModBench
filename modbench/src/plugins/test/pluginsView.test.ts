import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic,
  DiagnosticSeverity, FakeDiagnosticCollection, uriFile, uriFrom,
} from '../../test/vscodeMock';
import {
  filterBoxCommandsMock, filterBoxWindowMock, currentBoxOf, waitForMessage, type FakeInputBox,
} from '../../drivingLib/test/nameFilterViewHarness';

type SqlLens = { provideCodeLenses(document: Pick<vscode.TextDocument, 'getText'>): vscode.CodeLens[] };

const h = vi.hoisted(() => ({
  state: { commands: new Map<string, (...args: unknown[]) => unknown>(), boxes: [] as FakeInputBox[] },
  lenses: [] as SqlLens[],
  views: [] as { description?: string; message?: string }[],
  providers: [] as vscode.TreeDataProvider<unknown>[],
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
  selectRows: (_rows: unknown[]): void => undefined,
  toggle: { expand: (_row: unknown): void => undefined, collapse: (_row: unknown): void => undefined },
}));

vi.mock('vscode', () => {
  const disposable = () => ({ dispose: () => undefined });
  const { state } = h;
  h.commands = state.commands;
  return {
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic,
    DiagnosticSeverity, Uri: { file: uriFile, from: uriFrom },
    Position: class { constructor(public line: number, public character: number) {} },
    CodeLens: class { constructor(public range: unknown, public command: unknown) {} },
    Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
    window: {
      ...filterBoxWindowMock(state),
      createTreeView: (_id: string, options: { treeDataProvider: vscode.TreeDataProvider<unknown> }) => {
        const selectionListeners: ((event: { selection: unknown[] }) => unknown)[] = [];
        const expandListeners: ((event: { element: unknown }) => unknown)[] = [];
        const collapseListeners: ((event: { element: unknown }) => unknown)[] = [];
        h.toggle = {
          expand: (element) => { expandListeners.forEach((listener) => listener({ element })); },
          collapse: (element) => { collapseListeners.forEach((listener) => listener({ element })); },
        };
        const view: { description?: string; message?: string } & Record<string, unknown> = {
          selection: [], onDidChangeCheckboxState: disposable, dispose: () => undefined,
          onDidExpandElement: (listener: (event: { element: unknown }) => unknown) => { expandListeners.push(listener); return disposable(); },
          onDidCollapseElement: (listener: (event: { element: unknown }) => unknown) => { collapseListeners.push(listener); return disposable(); },
          onDidChangeSelection: (listener: (event: { selection: unknown[] }) => unknown) => { selectionListeners.push(listener); return disposable(); },
        };
        h.selectRows = (rows) => { view.selection = rows; selectionListeners.forEach((listener) => listener({ selection: rows })); };
        h.views.push(view);
        h.providers.push(options.treeDataProvider);
        return view;
      },
      registerFileDecorationProvider: (provider: (typeof h.decorations)[number]) => {
        h.decorations.push(provider);
        return disposable();
      },
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
import { createPluginSync, type PluginSync } from '../pluginSync';
import { NO_PLUGINS_MESSAGE, PluginNode } from '../PluginsTreeProvider';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';
import type { PluginMetadata, RecordSummary } from '../../client';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import { recordingReporter, scriptedDialog, type RecordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { settled } from '../../test/settled';

const FOUND = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
const ARMOR_SQL = 'SELECT form_key FROM "armo"';
const workspaceUri = (name: string) => ({ scheme: 'file', path: `/workspace/${name}` });

const rowsChanged: NotificationEvent = { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1 };

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pluginReads = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPlugins').length;

const tick = (over: Partial<NonNullable<NotificationEvent['loadOrderStatus']>> = {}): NotificationEvent => ({
  kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
  loadOrderStatus: {
    state: 'Reconciling', totalPlugins: 3, activePlugins: 3, indexedPlugins: [], conflictsComputed: false, failures: [], version: 1,
    ...over,
  },
});

const silentChannel = { error: vi.fn(), info: vi.fn() };

function syncRefusing() {
  let refusal: string | undefined;
  const pluginSync = createPluginSync(
    () => Promise.resolve(refusal === undefined
      ? { applied: true, wrote: false, added: [], dropped: [] }
      : { applied: false, refusal }),
    silentChannel);
  const run = () => pluginSync.run(instanceValueFixture().pluginSyncArguments);
  return {
    pluginSync,
    refuse: async (reason: string) => { refusal = reason; await run(); },
    land: async () => { refusal = undefined; await run(); },
  };
}

function pluginsView(
  value = instanceValueFixture(),
  { instance = new FakeInstance(value), client = new InMemoryMEditClient(), pluginSync = syncRefusing().pluginSync }:
    { instance?: FakeInstance; client?: InMemoryMEditClient; pluginSync?: PluginSync } = {},
) {
  const recordBrowser = new RecordBrowser(client);
  const reporters = new Map<string, RecordingReporter>();
  const plugins = createPluginsView({
    instance, adapter: adapterOver('/instance'), recordBrowser, client,
    pluginSync,
    channel: silentChannel,
    dataFolderFile: () => undefined, log: () => undefined,
    reporterFor: (tag) => { const reporter = recordingReporter(); reporters.set(tag, reporter); return reporter; },
    statusBar: { ready: vi.fn(), showMEditState: vi.fn(), dispose: vi.fn() }, registerRepositories: () => Promise.resolve(),
    ask: scriptedDialog(), recordWrite: (command) => command(), trackSelection: () => [], modsView: 'modbench.modList',
  });
  const provider = () => present(h.providers[0], 'the Plugins tree data provider');
  const rows = async () => (await provider().getChildren()) ?? [];
  return { client, recordBrowser, plugins, reporters, instance, rows, provider, view: () => present(h.views[0], 'the Plugins tree view') };
}

beforeEach(() => {
  h.lenses.length = 0;
  h.views.length = 0;
  h.providers.length = 0;
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

describe('the Plugins view registers its own gestures', () => {
  it.each([
    'modbench.plugin.move', 'modbench.mod.track', 'modbench.plugin.decompile', 'modbench.plugin.compile', 'modbench.record.create',
    'modbench.plugin.rename', 'modbench.plugin.create', 'modbench.plugin.sync',
  ])('registers %s with the view', (command) => {
    pluginsView();
    expect(h.commands.has(command)).toBe(true);
  });

  it('runs plugin sync with the instance\'s sync arguments', async () => {
    const sync = vi.fn(() => Promise.resolve({ applied: true as const, wrote: false, added: [], dropped: [] }));
    pluginsView(instanceValueFixture(), { pluginSync: createPluginSync(sync, silentChannel) });
    const value = instanceValueFixture();

    await present(h.commands.get('modbench.plugin.sync'), 'the modbench.plugin.sync handler')(value);

    expect(sync).toHaveBeenCalledWith(value.pluginSyncArguments);
  });

  it.each([
    ['modbench.plugin.compile', 'plugin.compile', 'Could not list the plugins to compile.'],
    ['modbench.plugin.create', 'newPlugin', 'Could not look up which extensions a plugin may take.'],
  ])('runs %s under its own reporter', async (command, tag, message) => {
    const { reporters } = pluginsView();

    await present(h.commands.get(command), `the ${command} handler`)();

    expect(present(reporters.get(tag), `the ${tag} reporter`).reports.map((report) => report.message)).toEqual([message]);
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
    h.selectRows([present(b, 'the B.esp row')]);

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

    h.selectRows([present(row, 'the plugin row')]);
    Object.assign(view(), { selection: [] });

    expect(focused.selectionOf('modbench.pluginListTree')).toEqual([row]);
  });
});

describe('the Plugins view follows mEdit\'s pushes', () => {
  it('re-reads the record browser and the plugin facts on mEdit\'s changed rows', async () => {
    const { client, recordBrowser } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    client.emit(rowsChanged);

    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    expect(pluginReads(client)).toBe(1);
  });

  it('re-reads the record browser and the plugin facts on a changed plugin', async () => {
    const { client, recordBrowser } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    client.emit({ ...rowsChanged, kind: 'plugin-changed' });

    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    expect(pluginReads(client)).toBe(1);
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
    expect([...collection].map(([uri]) => uri.fsPath)).toEqual([onDisk]);
  });
});

describe('the Plugins view badges the records beneath a plugin', () => {
  it('registers a decoration provider that badges a record row its browser reports Modified', () => {
    const { recordBrowser } = pluginsView();
    vi.spyOn(recordBrowser, 'workingTreeStateOf').mockReturnValue('Modified');

    const badges = h.decorations.map((provider) => provider.provideFileDecoration(uriFile('/a record row'))?.badge);

    expect(badges).toContain('M');
  });
});

describe('a record row\'s badge, from mEdit\'s stream', () => {
  const FORM_KEY = '000001:Test.esp';
  const summary = (workingTreeState: RecordSummary['workingTreeState']): RecordSummary => ({
    formKey: FORM_KEY, plugin: 'Test.esp', loadOrderIndex: 0, isWinner: true, editorId: 'TestNpc', origin: 'ModA',
    workingTreeState, hasContainerChildren: false, hasParseFailure: false,
  });
  type BadgeSource = (typeof h.decorations)[number] & { onDidChangeFileDecorations: (listener: (changed: unknown) => void) => unknown };
  const asVsCodeReReadsAnExpandedGroupOnTreeChange = (tree: RecordBrowser, group: RecordBrowserNode) => tree.getChildren(group);

  it('arrives as an M, and a change notice for the row, when mEdit reports the row changed', async () => {
    const { client, recordBrowser } = pluginsView();
    client.setQueryAnswer('getRecords', { items: [summary('None')], total: 1 });
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'NPC_', displayName: 'Non-Player Character' })]);
    const group = present((await recordBrowser.getPluginChildren({ name: 'Test.esp', origin: 'ModA' }))[0], 'the group row');
    const uri = present((await recordBrowser.getChildren(group))[0]?.resourceUri, "the row's resource URI");
    const badges = present(h.decorations.find((provider): provider is BadgeSource => 'onDidChangeFileDecorations' in provider), 'the record badge provider');
    const badgeChanges: unknown[] = [];
    badges.onDidChangeFileDecorations((changed) => { badgeChanges.push(changed); });
    expect(badges.provideFileDecoration(uri)).toBeUndefined();

    client.setQueryAnswer('getRecords', { items: [summary('Modified')], total: 1 });
    client.emit({ ...rowsChanged, keys: [FORM_KEY] });
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
  const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));
  const pluginReads = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPlugins').length;

  function filtering() {
    const { client, recordBrowser, reporters } = pluginsView();
    client.setQueryAnswer('setFilter', null);
    client.setQueryAnswer('clearFilter', null);
    const reporter = present(reporters.get('recordFilter'), 'the record filter reporter');
    const recordBrowserRefreshes: unknown[] = [];
    recordBrowser.onDidChangeTreeData((changed) => recordBrowserRefreshes.push(changed));
    const readsBefore = pluginReads(client);
    return {
      client, reporter, recordBrowserRefreshes,
      description: () => present(h.views[0], 'the Plugins tree view').description,
      lensOn: (sql: string) => present(h.lenses[0], 'the code lens provider').provideCodeLenses({ getText: () => sql })[0]?.command?.command,
      filterActive: () => h.contexts.filter(([name]) => name === 'modbench.record.filterActive').map(([, value]) => value),
      pluginFactsReread: async () => { await flushed(); return pluginReads(client) > readsBefore; },
      filter: (...args: unknown[]) => present(h.commands.get('modbench.record.filter'), 'the modbench.record.filter handler')(...args),
      clearFilter: () => present(h.commands.get('modbench.record.clearFilter'), 'the modbench.record.clearFilter handler')(),
      setCalls: () => client.calls.filter((call) => call.method === 'setFilter'),
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
      expect(await view.pluginFactsReread()).toBe(true);
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
      view.client.setQueryFailure('getActiveFilter', new Error('boom'));

      await view.filter(untitled);

      expect(view.reporter.reports).toEqual([{ severity: 'error', message: 'Could not read the record filter', detail: 'boom' }]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
    });
  });

  describe('a record filter the index could not apply again', () => {
    const cleared = (source: string) => ({
      kind: 'record-filter-cleared', plugin: '', origin: '', keys: [], sequence: 0,
      recordFilterCleared: { source, reason: 'Conversion Error' },
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
      await flushed();

      expect(view.description()).toBeUndefined();
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.filter');
      expect(view.filterActive()).toEqual([true, false]);
      expect(view.recordBrowserRefreshes).toHaveLength(1);
      expect(view.reporter.reports).toEqual(warned);
    });

    it('keeps a newer filter mEdit holds, and only logs a clearing of an older one', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source: 'a' });

      view.client.emit(cleared('older.sql'));
      await flushed();

      expect(view.description()).toBe('records: a');
      expect(view.reporter.reports).toEqual([]);
      expect(view.reporter.shownFailures).toEqual([
        { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
      ]);
    });

    it('warns when the clearing of another source leaves the view without the filter it showed', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);

      view.client.emit(cleared('older.sql'));
      await flushed();

      expect(view.description()).toBeUndefined();
      expect(view.reporter.reports).toEqual([
        { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
      ]);
    });

    it('shows no filter when the clearing outruns the reply to the set it clears', async () => {
      h.document = { uri: { scheme: 'untitled', path: 'a' }, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      view.client.setQueryAnswer('getActiveFilter', null);

      const applying = view.filter({ scheme: 'untitled', path: 'a' });
      await flushed();
      view.client.emit(cleared('a'));
      await flushed();
      replied(null);
      await applying;
      await flushed();

      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([false, false]);
      expect(view.reporter.reports).toEqual(warned);
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
      await flushed();
      view.client.setQueryAnswerOnce('setFilter', null);
      await view.filter(documentNamed('b'));

      repliedToA(null);
      await applyingA;
      await flushed();

      expect(view.description()).toBe('records: b');
    });

    it('shows the later read when an earlier read of what mEdit holds is handled after it', async () => {
      const view = filtering();
      let readForA!: (held: { sql: string; source: string }) => void;
      view.client.setQueryAnswerOnce('getActiveFilter', new Promise((resolve) => { readForA = resolve; }));
      view.holds('b');
      const applyingA = view.filter(documentNamed('a'));
      await flushed();
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
      await flushed();

      view.client.emit({
        kind: 'record-filter-cleared', plugin: '', origin: '', keys: [], sequence: 0,
        recordFilterCleared: { source: 'a', reason: 'Conversion Error' },
      });
      await flushed();
      replied(null);
      await reapplying;
      await flushed();

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
      await view.pluginFactsReread();
      const reads = pluginReads(view.client);

      await view.clearFilter();
      await flushed();

      expect(pluginReads(view.client)).toBeGreaterThan(reads);
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
      await flushed();
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
    "Game folder not found: set modbench.mods.gameDirectory. The Toolbox's Game row names each place Modbench looked.";
  const heldPlugin = (name: string, hasMatchingRecords: boolean): PluginMetadata => ({
    name, path: `/fixture/${name}`, loadOrderIndex: 0, isLight: false, isMaster: false, isBlueprint: false, masters: [], recordCount: 0,
    isImmutable: false, origin: 'SomeMod', masterIssues: [], inLoadOrder: true, hasMatchingRecords, isTracked: false,
    hasParseFailure: false, pluginSourceUnreadable: null,
  });
  const NO_MATCH = 'No matches for "zzznomatch".';
  const currentBox = currentBoxOf(h.state);
  const messageIs = (expected: string | undefined, label: string) =>
    waitForMessage(h.views[0] ?? {}, (m) => m === expected, label);

  async function applyFilter(client: InMemoryMEditClient, source: string | undefined) {
    if (source === undefined) {
      client.emit(rowsChanged);
    } else {
      client.setQueryAnswer('setFilter', null);
      client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source });
      h.files.set(source, ARMOR_SQL);
      await present(h.commands.get('modbench.record.filter'), 'the modbench.record.filter handler')(workspaceUri(source));
    }
    await settle();
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

    it('clears the message once a line lands', async () => {
      const { rows, instance } = await shown(found());
      await messageIs(NO_PLUGINS_MESSAGE, 'the empty-list message');

      instance.publish(found('TestMod.esp'));
      await rows();

      await messageIs(undefined, 'the message clearing');
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
      await settle();

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
    const badges = present(h.decorations.find((provider) => 'onDidChangeFileDecorations' in provider), 'the record badge provider');

    badges.provideFileDecoration(uri);
    await settled();
    const collapsed = badges.provideFileDecoration(uri)?.badge;
    h.toggle.expand(row);
    const expanded = badges.provideFileDecoration(uri)?.badge;
    h.toggle.collapse(row);

    expect([collapsed, expanded, badges.provideFileDecoration(uri)?.badge]).toEqual(['•', undefined, '•']);
  });

  it('puts a failed read of the states beneath on the view\'s message line', async () => {
    const { client, rows, view } = pluginsView(instanceValueFixture({
      plugins: [{ name: 'A.esp', path: '/fixture/A.esp', origin: 'SomeMod', line: 0, enabled: true, winning: true }],
      gameFolder: FOUND,
    }));
    client.setQueryFailure('getWorkingTreeStatesBeneath', new Error('boom'));
    const row = expectInstanceOf((await rows())[0], PluginNode);
    const badges = present(h.decorations.find((provider) => 'onDidChangeFileDecorations' in provider), 'the record badge provider');

    badges.provideFileDecoration(present(row.resourceUri, 'the row\'s resourceUri'));
    await settled();

    expect(view().message).toContain('Failed to load: boom');
  });
});
