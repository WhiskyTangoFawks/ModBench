import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic,
  DiagnosticSeverity, FakeDiagnosticCollection, uriFile, uriFrom,
} from '../../test/vscodeMock';
import { filterBoxCommandsMock, filterBoxWindowMock, makeFilterBoxState } from '../../drivingLib/test/nameFilterViewHarness';

type SqlLens = { provideCodeLenses(document: Pick<vscode.TextDocument, 'getText'>): vscode.CodeLens[] };

const h = vi.hoisted(() => ({
  lenses: [] as SqlLens[],
  views: [] as { description?: string; message?: string }[],
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
  const state = makeFilterBoxState();
  h.commands = state.commands;
  return {
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range, Diagnostic,
    DiagnosticSeverity, Uri: { file: uriFile, from: uriFrom },
    Position: class { constructor(public line: number, public character: number) {} },
    CodeLens: class { constructor(public range: unknown, public command: unknown) {} },
    Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
    window: {
      ...filterBoxWindowMock(state),
      createTreeView: () => {
        const view: { description?: string; message?: string } & Record<string, unknown> = {
          selection: [], onDidChangeSelection: disposable, onDidChangeCheckboxState: disposable, dispose: () => undefined,
        };
        h.views.push(view);
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

import { createPluginsView, pluginsViewProgress } from '../pluginsView';
import { createPluginSync } from '../pluginSync';
import { PluginTreeProvider, RecordNode, RecordTypeNode } from '../PluginTreeProvider';
import type { RecordSummary } from '../../client';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const ARMOR_SQL = 'SELECT form_key FROM "armo"';
const workspaceUri = (name: string) => ({ scheme: 'file', path: `/workspace/${name}` });

const rowsChanged: NotificationEvent = { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1 };

const silentChannel = { error: vi.fn(), info: vi.fn() };

function pluginsView(value = instanceValueFixture()) {
  const client = new InMemoryMEditClient();
  const recordBrowser = new PluginTreeProvider(client);
  const reporters = new Map<string, RecordingReporter>();
  const plugins = createPluginsView({
    instance: new FakeInstance(value), access: accessTo('/instance'), recordBrowser, client,
    pluginSync: createPluginSync(() => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }), silentChannel),
    channel: silentChannel,
    dataFolderFile: () => undefined, log: () => undefined,
    reporterFor: (tag) => { const reporter = recordingReporter(); reporters.set(tag, reporter); return reporter; },
    statusBar: { ready: vi.fn(), showMEditState: vi.fn(), dispose: vi.fn() }, notifyConflictsComputed: vi.fn(),
  });
  return { client, recordBrowser, plugins, reporters };
}

beforeEach(() => {
  h.lenses.length = 0;
  h.views.length = 0;
  h.decorations.length = 0;
  h.diagnostics.clear();
  h.contexts.length = 0;
  h.files.clear();
  h.document = undefined;
  h.pick = undefined;
  h.picked.length = 0;
  h.opened.length = 0;
  h.shown.length = 0;
});

describe('modbench.plugin.move', () => {
  it('is registered with the view', () => {
    pluginsView();
    expect(h.commands.has('modbench.plugin.move')).toBe(true);
  });
});

describe('the Plugins view follows mEdit\'s pushes and shows the record filter', () => {
  it('re-reads the record browser and the plugin facts on mEdit\'s changed rows', () => {
    const { client, recordBrowser, plugins } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');
    const refreshFacts = vi.spyOn(plugins.tree, 'refreshFacts');

    client.emit(rowsChanged);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshFacts).toHaveBeenCalledTimes(1);
  });

  it('re-reads the record browser and the plugin facts on a changed plugin', () => {
    const { client, recordBrowser, plugins } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');
    const refreshFacts = vi.spyOn(plugins.tree, 'refreshFacts');

    client.emit({ ...rowsChanged, kind: 'plugin-changed' });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshFacts).toHaveBeenCalledTimes(1);
  });

  it('hears no push once disposed', () => {
    const { client, recordBrowser, plugins } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    plugins.dispose();
    client.emit(rowsChanged);
    client.emit({ ...rowsChanged, kind: 'plugin-changed' });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the record filter on its SQL document\'s lens and in the view\'s description', () => {
    const { plugins } = pluginsView();

    plugins.showRecordFilter({ sql: ARMOR_SQL, source: 'armor.sql' });

    const [lens] = present(h.lenses[0], 'the registered code lens provider').provideCodeLenses({ getText: () => ARMOR_SQL });
    expect(lens?.command?.command).toBe('modbench.record.clearFilter');
    expect(present(h.views[0], 'the Plugins tree view').description).toBe('records: armor.sql');
  });
});

describe('the Plugins view re-renders for a reconcile tick only when it landed something new, since a re-render re-fetches record types for every expanded row', () => {
  const tick = (over: Partial<NonNullable<NotificationEvent['loadOrderStatus']>> = {}): NotificationEvent => ({
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Reconciling', totalPlugins: 3, activePlugins: 3, indexedPlugins: [], conflictsComputed: false, failures: [], version: 1,
      ...over,
    },
  });
  const A = { name: 'A.esp', origin: 'SomeMod' };

  function reconciling() {
    const { client, plugins } = pluginsView();
    const rerenders: unknown[] = [];
    plugins.tree.onDidChangeTreeData((changed) => rerenders.push(changed));
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
      plugins: [{ name: 'Test.esp', path: onDisk, origin: 'ModA', slot: 0, enabled: true, winning: true }],
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
  const asVsCodeReReadsAnExpandedGroupOnTreeChange = (tree: PluginTreeProvider, group: RecordTypeNode) => tree.getChildren(group);

  it('arrives as an M, and a change notice for the row, when mEdit reports the row changed', async () => {
    const { client, recordBrowser } = pluginsView();
    client.setQueryAnswer('getRecords', { items: [summary('None')], total: 1 });
    const group = new RecordTypeNode('Test.esp', recordTypeCountFixture({ type: 'NPC_', displayName: 'Non-Player Character' }), 'ModA');
    const uri = present(expectInstanceOf((await recordBrowser.getChildren(group))[0], RecordNode).resourceUri, "the row's resource URI");
    const badges = present(h.decorations.find((provider): provider is BadgeSource => 'onDidChangeFileDecorations' in provider), 'the record badge provider');
    const badgeChanges: unknown[] = [];
    badges.onDidChangeFileDecorations((changed) => { badgeChanges.push(changed); });
    expect(badges.provideFileDecoration(uri)).toBeUndefined();

    client.setQueryAnswer('getRecords', { items: [summary('Modified')], total: 1 });
    client.emit({ ...rowsChanged, keys: [FORM_KEY] });
    await asVsCodeReReadsAnExpandedGroupOnTreeChange(recordBrowser, group);

    expect(badgeChanges).toEqual([[uri]]);
    expect(badges.provideFileDecoration(uri)?.badge).toBe('M');
  });
});

describe('the Plugins view\'s progress', () => {
  const held = () => {
    const view: { message?: string } = { message: 'Indexing 3/100…' };
    const nameFilter = { refresh: vi.fn() };
    return { view, nameFilter, progress: pluginsViewProgress(view, nameFilter) };
  };

  it('takes the message line without asking the name filter', () => {
    const { view, nameFilter, progress } = held();

    progress.say('Starting backend…');

    expect(view.message).toBe('Starting backend…');
    expect(nameFilter.refresh).not.toHaveBeenCalled();
  });

  it('gives a cleared line back to the name filter', () => {
    const { view, nameFilter, progress } = held();

    progress.say(undefined);

    expect(view.message).toBeUndefined();
    expect(nameFilter.refresh).toHaveBeenCalledOnce();
  });

  it('clears the line when the work it runs fails', async () => {
    const { view, nameFilter, progress } = held();

    await expect(progress.while(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(view.message).toBeUndefined();
    expect(nameFilter.refresh).toHaveBeenCalledOnce();
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

      await view.filter(untitled);

      expect(h.picked).toEqual([]);
      expect(view.setCalls()).toEqual([{ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'Untitled-1' }] }]);
      expect(view.description()).toBe('records: Untitled-1');
    });

    it('reports a refused set and touches nothing else', async () => {
      h.document = { uri: untitled, fileName: 'Untitled-1', getText: () => 'SELECT editor_id FROM "npc_"' };
      const view = filtering();
      view.client.setQueryAnswer('setFilter', 'Filter SQL must return a form_key column');

      await view.filter(untitled);

      expect(view.reporter.reports).toEqual([
        { severity: 'error', message: 'Filter failed — Filter SQL must return a form_key column', detail: undefined },
      ]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
      expect(view.recordBrowserRefreshes).toEqual([]);
      expect(await view.pluginFactsReread()).toBe(false);
    });
  });

  describe('modbench.record.clearFilter', () => {
    const source = { scheme: 'untitled', path: 'a' };
    const applied = async () => {
      h.document = { uri: source, fileName: 'a', getText: () => ARMOR_SQL };
      const view = filtering();
      await view.filter(source);
      view.recordBrowserRefreshes.length = 0;
      return view;
    };

    it('shows no filter and re-reads the records, as a set does', async () => {
      const view = await applied();

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
      expect(view.filterActive()).toEqual([true]);
      expect(view.recordBrowserRefreshes).toEqual([]);
    });
  });
});
