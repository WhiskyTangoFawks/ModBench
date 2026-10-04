import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range,
  FakeDiagnosticCollection, uriFile, uriFrom,
} from '../../test/vscodeMock';
import { filterBoxCommandsMock, filterBoxWindowMock, makeFilterBoxState } from '../../drivingLib/test/nameFilterViewHarness';

type SqlLens = { provideCodeLenses(document: Pick<vscode.TextDocument, 'getText'>): vscode.CodeLens[] };

const h = vi.hoisted(() => ({
  lenses: [] as SqlLens[],
  views: [] as { description?: string; message?: string }[],
}));

vi.mock('vscode', () => {
  const disposable = () => ({ dispose: () => undefined });
  const state = makeFilterBoxState();
  return {
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Range,
    Uri: { file: uriFile, from: uriFrom },
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
      registerFileDecorationProvider: disposable,
      withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
    },
    languages: {
      createDiagnosticCollection: () => new FakeDiagnosticCollection(),
      registerCodeLensProvider: (_selector: unknown, provider: SqlLens) => {
        h.lenses.push(provider);
        return disposable();
      },
    },
    commands: filterBoxCommandsMock(state),
  };
});

import { createPluginsView, pluginsViewProgress } from '../pluginsView';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const ARMOR_SQL = 'SELECT form_key FROM "armo"';

const rowsChanged: NotificationEvent = { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1 };

function pluginsView() {
  const client = new InMemoryMEditClient();
  const recordBrowser = new PluginTreeProvider(client);
  const plugins = createPluginsView({
    instance: new FakeInstance(instanceValueFixture()), access: accessTo('/instance'), recordBrowser, client,
    syncPlugins: () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }), channel: { error: vi.fn(), info: vi.fn() },
    dataFolderFile: () => undefined, log: () => undefined, reporterFor: recordingReporter,
    statusBar: { ready: vi.fn(), showMEditState: vi.fn(), dispose: vi.fn() }, notifyConflictsComputed: vi.fn(),
  });
  return { client, recordBrowser, plugins };
}

beforeEach(() => {
  h.lenses.length = 0;
  h.views.length = 0;
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

  it('hears no push once disposed', () => {
    const { client, recordBrowser, plugins } = pluginsView();
    const refresh = vi.spyOn(recordBrowser, 'refresh');

    plugins.dispose();
    client.emit(rowsChanged);

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
