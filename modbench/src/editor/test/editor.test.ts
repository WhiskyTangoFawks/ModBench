import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, uriFrom, fakeUri } from '../../test/vscodeMock';

interface FakeTreeView {
  options: unknown;
  view: { selection: unknown[]; description?: string; message?: string; fireSelection(selection: unknown[]): void };
}

const h = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  contextKeys: new Map<string, unknown>(),
  executed: [] as unknown[][],
  editorProviders: new Map<string, unknown>(),
  editorProviderDisposals: 0,
  editorProviderOptions: new Map<string, unknown>(),
  treeViews: [] as FakeTreeView[],
  documentChanges: new Set<(event: { document: unknown; contentChanges: unknown[] }) => void>(),
  disk: new Map<string, string | Uint8Array>(),
  FileSystemError: class extends Error { code = ''; },
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, FileSystemError: h.FileSystemError,
  Disposable: class {
    constructor(public dispose: () => void) {}
    static from(...parts: { dispose(): void }[]) { return { dispose: () => parts.forEach((part) => part.dispose()) }; }
  },
  Uri: {
    from: (parts: Parameters<typeof uriFrom>[0]) => Object.defineProperty(uriFrom(parts), 'toString', {
      value: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}`,
    }),
    joinPath: (...parts: unknown[]) => parts.join('/'),
    file: (fsPath: string) => fakeUri(fsPath),
  },
  ViewColumn: { Active: -1, One: 1, Beside: -2 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      h.commands.set(id, handler);
      return { dispose: () => h.commands.delete(id) };
    },
    executeCommand: (id: string, ...args: unknown[]) => {
      h.executed.push([id, ...args]);
      if (id === 'setContext') h.contextKeys.set(String(args[0]), args[1]);
      return Promise.resolve(h.commands.get(id)?.(...args));
    },
  },
  workspace: {
    registerFileSystemProvider: () => ({ dispose: () => undefined }),
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    textDocuments: [],
    fs: {
      readFile: ({ fsPath, path }: { fsPath?: string; path?: string }) => {
        const held = h.disk.get(fsPath ?? path ?? '');
        if (held === undefined) return Promise.reject(Object.assign(new h.FileSystemError('no such file'), { code: 'FileNotFound' }));
        return Promise.resolve(typeof held === 'string' ? new TextEncoder().encode(held) : held);
      },
    },
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    openTextDocument: (uri: unknown) => Promise.resolve({ uri, getText: () => '{}' }),
    onDidChangeTextDocument: (listener: (event: { document: unknown; contentChanges: unknown[] }) => void) => {
      h.documentChanges.add(listener);
      return { dispose: () => h.documentChanges.delete(listener) };
    },
  },
  window: {
    createQuickPick: () => {
      const hidden: (() => void)[] = [];
      return {
        show: () => { hidden.forEach((listener) => { listener(); }); }, dispose: () => undefined,
        onDidChangeValue: () => undefined, onDidAccept: () => undefined, onDidHide: (listener: () => void) => { hidden.push(listener); },
      };
    },
    registerCustomEditorProvider: (viewType: string, provider: unknown, options: unknown) => {
      h.editorProviders.set(viewType, provider);
      h.editorProviderOptions.set(viewType, options);
      return { dispose: () => { h.editorProviderDisposals++; } };
    },
    createTreeView: (_id: string, options: unknown) => {
      const listeners: ((event: unknown) => void)[] = [];
      const view: FakeTreeView['view'] & { onDidChangeSelection: unknown; dispose(): void } = {
        selection: [],
        onDidChangeSelection: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return { dispose: () => undefined };
        },
        fireSelection: (selection: unknown[]) => {
          view.selection = selection;
          listeners.forEach((listener) => { listener({ selection }); });
        },
        dispose: () => undefined,
      };
      h.treeViews.push({ options, view });
      return view;
    },
  },
}));

import * as vscode from 'vscode';
import { createEditor } from '..';
import type { ModFacts } from '../modsByOrigin';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { createFocusedView } from '../../drivingLib/focusedView';
import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { ReferencedByTreeProvider } from '../ReferencedByTreeProvider';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { comparisonOf } from '../../test/comparison';
import { pluginMetadataFixture } from '../../client/test/fixtures';

const COPY_PLUGIN = { name: 'A.esp', origin: 'ModA' };
const renderedUri = (formKey: string, fileName: string) => vscode.Uri.from({
  scheme: 'modbench-rendered', path: `/ModA/A.esp/${fileName}`, query: `formKey=${formKey.replace(':', '%3A')}&name=A.esp&origin=ModA`,
});
const isShowColumns = (message: unknown) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'showColumns';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakePanel {
  title: string;
  active: boolean;
  viewColumn: number | undefined;
  webview: { postMessage: ReturnType<typeof vi.fn>; options?: unknown; html?: string; cspSource: string; asWebviewUri: (uri: unknown) => unknown; onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void } };
  onDidDispose: (listener: () => void) => { dispose(): void };
  onDidChangeViewState: (listener: () => void) => { dispose(): void };
  focus(): void;
  close(): void;
  receive(message: unknown): void;
}

function fakePanel(): FakePanel {
  const disposed: (() => void)[] = [];
  const viewState: (() => void)[] = [];
  const received: ((message: unknown) => void)[] = [];
  const panel: FakePanel = {
    title: '', active: true, viewColumn: 2,
    webview: {
      postMessage: vi.fn(() => Promise.resolve(true)), cspSource: 'csp', asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (listener) => { received.push(listener); return { dispose: () => undefined }; },
    },
    onDidDispose: (listener) => { disposed.push(listener); return { dispose: () => undefined }; },
    onDidChangeViewState: (listener) => { viewState.push(listener); return { dispose: () => undefined }; },
    focus: () => { viewState.forEach((listener) => { listener(); }); },
    close: () => { disposed.forEach((listener) => { listener(); }); },
    receive: (message) => { received.forEach((listener) => { listener(message); }); },
  };
  return panel;
}

interface RecordEditorProvider {
  resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>;
}

const isRecordEditorProvider = (value: unknown): value is RecordEditorProvider =>
  typeof value === 'object' && value !== null && 'resolveCustomTextEditor' in value;

const NO_MODS: ModFacts = { trackedMods: () => new Set<string>(), modDirs: () => new Map<string, string>(), onChange: () => ({ dispose: () => undefined }) };

function makeEditor(
  client = new InMemoryMEditClient(), viewSelections = new Map<string, () => readonly unknown[]>(), modFacts = NO_MODS,
) {
  const focusedView = createFocusedView();
  const outputChannel = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const editor = createEditor({
    context: { extensionUri: fakeUri('/ext') },
    meditClient: client,
    outputChannel,
    reporterFor: () => ({ report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() }),
    ask: vi.fn(),
    focusedView,
    viewSelections,
    recordWrite: (command) => command(),
    refreshSourceControlFor: () => undefined,
    modFacts,
  });
  const provider = h.editorProviders.get('modbench.record');
  if (!isRecordEditorProvider(provider)) throw new Error('no record editor registered');
  const referencedBy = h.treeViews.at(-1);
  if (!referencedBy) throw new Error('no Referenced By view');
  const open = (formKey: string): FakePanel => {
    const panel = fakePanel();
    void provider.resolveCustomTextEditor({ uri: renderedUri(formKey, `${formKey}.json`) }, panel);
    return panel;
  };
  const openDocument = async (uri: unknown, document: object = {}): Promise<FakePanel> => {
    const panel = fakePanel();
    await provider.resolveCustomTextEditor(Object.assign(document, { uri }), panel);
    return panel;
  };
  const openFile = (fsPath: string, document?: object): Promise<FakePanel> => openDocument({ scheme: 'file', fsPath }, document);
  const tabs = new Map<string, FakePanel>();
  const vsCodeOpensTabs = () => {
    h.commands.set('vscode.openWith', async (uri: unknown) => {
      if (tabs.has(String(uri))) return;
      const panel = fakePanel();
      tabs.set(String(uri), panel);
      await provider.resolveCustomTextEditor({ uri }, panel);
    });
    return (uri: unknown) => tabs.get(String(uri));
  };
  return { editor, open, openFile, openDocument, referencedBy, focusedView, outputChannel, vsCodeOpensTabs };
}

beforeEach(() => {
  h.disk.clear();
  h.commands.clear();
  h.contextKeys.clear();
  h.executed.length = 0;
});

const rowsOf = ({ options }: FakeTreeView): ReferencedByTreeProvider =>
  expectInstanceOf(typeof options === 'object' && options !== null ? Reflect.get(options, 'treeDataProvider') : undefined, ReferencedByTreeProvider);

const recordOf = async (referencedBy: FakeTreeView) => {
  await rowsOf(referencedBy).getChildren();
  await settle();
  return { description: referencedBy.view.description, message: referencedBy.view.message };
};

const pageGlobal = (panel: FakePanel, name: string): unknown => {
  const html = panel.webview.html ?? '';
  const at = html.indexOf(`window.${name} = `);
  if (at < 0) return undefined;
  const start = at + `window.${name} = `.length;
  const nextAssignment = html.indexOf('; window.', start);
  return JSON.parse(html.slice(start, nextAssignment >= 0 ? nextAssignment : html.indexOf(';</script>', start)));
};

const comparisonsAsked = (client: InMemoryMEditClient) =>
  client.calls.filter(({ method }) => method === 'getComparison').map(({ args }) => args);

const changeDocument = (change: { document: unknown; contentChanges: unknown[] }) => {
  h.documentChanges.forEach((listener) => { listener(change); });
};

const activeA = [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', inLoadOrder: true })];
const inactiveA = [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', loadOrderIndex: null, inLoadOrder: false })];

const opened = () => h.executed.filter(([id]) => id === 'vscode.openWith').map(([, uri]) => uri);

describe('Referenced By follows the record tab in focus', () => {
  function followed() {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    const { open, referencedBy } = makeEditor(client);
    return { open, aboutNow: () => recordOf(referencedBy) };
  }

  it('names the record of the tab opened, then of the tab focused', async () => {
    const { open, aboutNow } = followed();

    const first = open('000801:A.esp');
    expect((await aboutNow()).description).toBe('000801:A.esp');
    open('000802:A.esp');
    expect((await aboutNow()).description).toBe('000802:A.esp');
    first.focus();
    expect((await aboutNow()).description).toBe('000801:A.esp');
  });

  it('keeps the record of a tab that closes while other record tabs stay open, until another is focused', async () => {
    const { open, aboutNow } = followed();
    const first = open('000801:A.esp');
    const second = open('000802:A.esp');
    second.focus();
    first.focus();
    await aboutNow();

    first.close();
    expect((await aboutNow()).description).toBe('000801:A.esp');
    second.focus();
    expect((await aboutNow()).description).toBe('000802:A.esp');
  });

  it('asks for a record once the last record tab closes, even when it was not the tab last in focus', async () => {
    const { open, aboutNow } = followed();
    const first = open('000801:A.esp');
    const second = open('000802:A.esp');
    first.focus();
    await aboutNow();

    first.close();
    second.close();
    expect((await aboutNow()).message).toBe('Open a record to see what references it.');
  });
});

describe('Referenced By, as record tabs retarget and close', () => {
  const GUN = '000801:A.esp';
  function followed() {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    const { open, referencedBy } = makeEditor(client);
    const referencesAsked = () => client.calls.filter(({ method }) => method === 'getReferences').length;
    return { client, open, referencedBy, referencesAsked, aboutNow: () => recordOf(referencedBy) };
  }

  it('asks nothing again when the tab already in focus is reported in focus again', async () => {
    const { open, aboutNow, referencesAsked } = followed();
    const tab = open(GUN);
    await aboutNow();
    const asked = referencesAsked();

    tab.focus();
    await aboutNow();

    expect(referencesAsked()).toBe(asked);
  });

  it('keeps the record in focus when a tab out of focus closes', async () => {
    const { open, aboutNow } = followed();
    const first = open(GUN);
    open('000802:A.esp');
    await aboutNow();

    first.close();

    expect((await aboutNow()).description).toBe('000802:A.esp');
  });

  describe('as an edit of a FormID moves the record its tabs show', () => {
    const [OLD, MOVED, OTHER] = ['000800:A.esp', '000900:A.esp', '000802:A.esp'];

    it('names the new FormKey for the tab in focus, and keeps the record of the tab in focus when another tab moves', async () => {
      const client = new InMemoryMEditClient();
      client.setQueryAnswer('getReferences', []);
      client.setQueryAnswer('getComparison', null);
      client.setQueryAnswer('getPlugins', activeA);
      client.setQueryAnswer('getRecordFile', { path: '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json' });
      client.setQueryAnswer('getRecordOfFile', { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin });
      client.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], documents: [] });
      const { open, referencedBy } = makeEditor(client);
      const moving = open(OLD);
      open(OTHER);
      const edit = () => h.commands.get('modbench.record.editField')?.(
        { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });

      await edit();
      expect((await recordOf(referencedBy)).description).toBe(OTHER);

      moving.focus();
      expect((await recordOf(referencedBy)).description).toBe(MOVED);
    });
  });
});

describe('the focused cell of the record tab in focus', () => {
  it('publishes its keys, enters the record grid as the focused view and is what copy value copies from it', () => {
    const { editor, open, focusedView } = makeEditor();
    const panel = open('000801:A.esp');

    panel.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { webviewSection: 'field', copyText: 'Iron' }, entered: true });

    expect(h.contextKeys.get('modbench.record.focusedCellSection')).toBe('field');
    expect(focusedView.id()).toBe('modbench.recordGrid');
    expect(editor.copyValue.map(({ text }) => text({ view: 'modbench.recordGrid' }, undefined))).toEqual(['Iron', undefined]);
  });

  const cell = (webviewSection: string) => ({ webviewSection });
  const focusedSection = () => h.contextKeys.get('modbench.record.focusedCellSection');

  it('is the cell of the tab in focus, whichever tab reported one, and follows the focus', () => {
    const { open } = makeEditor();
    const [first, second] = [open('000801:A.esp'), open('000802:A.esp')];
    first.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('first'), entered: false });
    expect(focusedSection()).toBeUndefined();

    second.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('second'), entered: false });
    expect(focusedSection()).toBe('second');
    first.focus();
    expect(focusedSection()).toBe('first');
  });

  it('is gone with the tab that held it', () => {
    const { open } = makeEditor();
    const tab = open('000801:A.esp');
    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('field'), entered: false });

    tab.close();

    expect(focusedSection()).toBeUndefined();
  });

  it('enters the record grid as the focused view when a tab gains the focus, and not when a re-read refreshes its cell', () => {
    const { open, focusedView } = makeEditor();
    const tab = open('000801:A.esp');
    expect(focusedView.id()).toBe('modbench.recordGrid');
    focusedView.enter('modbench.modList');

    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('field'), entered: false });
    expect(focusedView.id()).toBe('modbench.modList');
    tab.focus();
    expect(focusedView.id()).toBe('modbench.recordGrid');
  });

  it('answers the palette\'s copy value with the focused cell\'s text, empty or not, and defers for another view or a cell with none', () => {
    const { editor, open } = makeEditor();
    const tab = open('000801:A.esp');
    const copy = () => editor.copyValue.map(({ text }) => text({ view: 'modbench.recordGrid' }, undefined))[0];

    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { webviewSection: 'field', copyText: '' }, entered: false });
    expect(copy()).toBe('');
    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('field'), entered: false });
    expect(copy()).toBeUndefined();
    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { webviewSection: 'field', copyText: 'Iron' }, entered: false });
    expect(editor.copyValue.map(({ text }) => text({ view: 'modbench.modList' }, undefined))[0]).toBeUndefined();
  });
});

describe('the Referenced By selection', () => {
  it('says whether every row selected is a plugin\'s copy of a referrer', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', [{
      formKey: '000900:A.esp', plugin: 'A.esp', origin: 'ModA', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon', editorId: null,
    }]);
    client.setQueryAnswer('getComparison', null);
    const { open, referencedBy } = makeEditor(client);
    open('000801:A.esp');
    const [referrer] = await rowsOf(referencedBy).getChildren();
    const holders = await rowsOf(referencedBy).getChildren(referrer);

    referencedBy.view.fireSelection(holders);
    expect(h.contextKeys.get('modbench.referencedBy.allHolders')).toBe(true);
    referencedBy.view.fireSelection([referrer]);
    expect(h.contextKeys.get('modbench.referencedBy.allHolders')).toBe(false);
  });
});

describe('conflicts computed', () => {
  it('has every open record tab read its record again', () => {
    const { editor, open } = makeEditor();
    const tabs = [open('000801:A.esp'), open('000802:A.esp')];

    editor.announceConflictsComputed();

    expect(tabs.map((tab) => tab.webview.postMessage.mock.calls)).toEqual([
      [[{ type: 'loadRecord', formKey: '000801:A.esp' }]],
      [[{ type: 'loadRecord', formKey: '000802:A.esp' }]],
    ]);
  });
});

describe('a record tab whose record an edit of its FormID moved', () => {
  const [OLD, MOVED] = ['000800:Mod.esp', '000900:Mod.esp'];
  const editField = (formKey: string) => h.commands.get('modbench.record.editField')?.(
    { formKey, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin }, { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: 'x' });
  const editedFormKeys = (client: InMemoryMEditClient) => client.calls.filter(c => c.method === 'getEditChanges').map(c => c.args[0]);

  it('sends an edit of the moved plugin addressed with the old FormKey to the new one until the tab\'s read of it is answered, and not after', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', activeA);
    client.setQueryAnswer('getRecordFile', { path: '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json' });
    client.setQueryAnswer('getRecordOfFile', { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin });
    const { open } = makeEditor(client);
    const tab = open(OLD);
    client.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], documents: [] });
    await editField(OLD);
    client.setQueryAnswer('getEditChanges', { applied: true, moves: [], documents: [] });
    client.emit({ kind: 'rows-changed', plugin: 'Mod.esp', origin: 'ModA', keys: [OLD, MOVED], sequence: 2 });
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: MOVED }]]);

    await editField(OLD);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: MOVED, columns: [] });
    await settle();
    await editField(OLD);

    expect(editedFormKeys(client)).toEqual([OLD, MOVED, OLD]);
  });
});

describe('an edit of a FormID, fired with no panel', () => {
  const [OLD, MOVED, ELSEWHERE] = ['000800:A.esp', '000900:A.esp', '000801:A.esp'];

  it('moves every tab showing the record to its new FormKey, and no other, with one edit', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getRecordFile', { path: '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json' });
    client.setQueryAnswer('getRecordOfFile', { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin });
    client.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], documents: [] });
    const { open } = makeEditor(client);
    const [one, other, elsewhere] = [open(OLD), open(OLD), open(ELSEWHERE)];

    await h.commands.get('modbench.record.editField')?.(
      { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });
    client.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: [OLD, MOVED], sequence: 2 });

    expect([one, other, elsewhere].map((tab) => tab.webview.postMessage.mock.calls))
      .toEqual([[[{ type: 'loadRecord', formKey: MOVED }]], [[{ type: 'loadRecord', formKey: MOVED }]], []]);
    expect(client.calls.filter(({ method }) => method === 'getEditChanges')).toHaveLength(1);
  });
});

describe('a record gesture from the palette', () => {
  it('opens the records selected in a view the Editor is handed, while that view has the focus', async () => {
    const plugins = { selection: [{ formKey: '000803:A.esp', kind: 'placed' }], onDidChangeSelection: (listener: (event: { selection: unknown[] }) => void) => { listener({ selection: [] }); return { dispose: () => undefined }; } };
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordOwner', COPY_PLUGIN);
    client.setQueryAnswer('getRecordFile', { path: null });
    client.setQueryAnswer('getRenderedDocument', { fileName: 'Placed.json', text: '{}' });
    const { focusedView } = makeEditor(client, new Map([['modbench.pluginListTree', () => plugins.selection]]));
    focusedView.follow('modbench.pluginListTree', plugins);

    await h.commands.get('modbench.record.open')?.();

    expect(h.contextKeys.get('modbench.record.selectionIn')).toBe('modbench.pluginListTree');
    expect(opened()).toEqual([renderedUri('000803:A.esp', 'Placed.json')]);
  });
});

describe('a record file\'s tab', () => {
  const GUN = '000801:A.esp';
  const FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const holding = (formKey: string) => ({ formKey, plugin: 'A.esp', origin: 'ModA' });
  function fileClient(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    client.setQueryAnswer('getPlugins', []);
    return client;
  }

  it('shows the record mEdit says the file holds, followed by Referenced By and read again as any record tab is', async () => {
    const client = fileClient();
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { editor, openFile, referencedBy } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(client.calls).toContainEqual({ method: 'getRecordOfFile', args: [FILE] });
    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect((await recordOf(referencedBy)).description).toBe('Gun');
    editor.announceConflictsComputed();
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });

  it('keeps the file\'s name as its title once its read is answered', async () => {
    const client = fileClient();
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile } = makeEditor(client);
    const tab = await openFile(FILE);
    tab.title = 'Gun.json';

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await settle();

    expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recordLoadAnswered', ok: true }));
    expect(tab.title).toBe('Gun.json');
  });

  it('shows "Failed to load:" and mEdit\'s reason when the file holds no record, with a line in the Output', async () => {
    const client = fileClient();
    const why = `${FILE} declares no FormKey, so it is no record's document.`;
    client.setQueryFailure('getRecordOfFile', new Error(why));
    const { openFile, outputChannel } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(pageGlobal(tab, 'mEditLoadError')).toBe(why);
    expect(pageGlobal(tab, 'mEditFormKey')).toBeUndefined();
    expect(outputChannel.warn).toHaveBeenCalledWith(`Failed to read ${FILE}: ${why}`);
  });

  it('asks again on mEdit\'s next load-order status, and shows the record once mEdit answers', async () => {
    const client = fileClient();
    client.setQueryFailureOnce('getRecordOfFile', new Error('mEdit has not started'));
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile } = makeEditor(client);
    const tab = await openFile(FILE);
    expect(pageGlobal(tab, 'mEditLoadError')).toBe('mEdit has not started');

    client.emit({
      kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
      loadOrderStatus: { state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: false, failures: [], version: 1 },
    });
    await settle();

    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect(pageGlobal(tab, 'mEditLoadError')).toBeUndefined();
  });

  describe('and its document', () => {
    const fileDocument = (text: string, isDirty: boolean) => ({ text, isDirty, getText() { return this.text; } });
    const typed = { range: {}, text: 'x' };
    function holdingClient(): InMemoryMEditClient {
      const client = fileClient();
      client.setQueryAnswer('getRecordOfFile', holding(GUN));
      return client;
    }
    async function readOf(document: object, plugins = inactiveA): Promise<unknown[][]> {
      const client = holdingClient();
      client.setQueryAnswer('getPlugins', plugins);
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, document);
      Object.assign(document, { text: '{ "EditorID": "Typed" }' });
      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await settle();
      return comparisonsAsked(client);
    }

    it('reads the file\'s column from the unsaved text as it is when the read is asked, its plugin active or not', async () => {
      const typedCopy = { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Typed" }' };
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', true), activeA)).toEqual([[GUN, typedCopy]]);
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', true), inactiveA)).toEqual([[GUN, typedCopy]]);
    });

    it('reads the file\'s column from mEdit once the document is saved and its plugin is active, as the read model\'s value wins', async () => {
      h.disk.set(FILE, '{ "EditorID": "OnDisk" }');
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false), activeA)).toEqual([[GUN, undefined]]);
    });

    it('reads the file\'s column from the unsaved text beside the other records the tab shows', async () => {
      const client = holdingClient();
      client.setQueryAnswer('getRecordsComparison', null);
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{ "EditorID": "Typed" }', true));
      const column = { formKey: '000900:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [column] });
      await settle();

      expect(client.calls.filter(({ method }) => method === 'getRecordsComparison').map(({ args }) => args))
        .toEqual([[[{ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Typed" }' }, column]]]);
    });

    it('reads the file\'s column from the file on disk once the document is saved and its plugin is not active, as mEdit compares no copy of it', async () => {
      h.disk.set(FILE, '{ "EditorID": "OnDisk" }');
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false)))
        .toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }' }]]);
    });

    it('reads the saved file without its byte order mark, as its document\'s text has none', async () => {
      h.disk.set(FILE, '\uFEFF{ "EditorID": "OnDisk" }');
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false)))
        .toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }' }]]);
    });

    it('reads the file\'s column from mEdit once the saved document is gone from disk', async () => {
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false))).toEqual([[GUN, undefined]]);
    });

    it('fails the read, saying why, when the saved file on disk is not text', async () => {
      h.disk.set(FILE, new Uint8Array([0xff, 0xfe, 0xfd]));
      const client = holdingClient();
      client.setQueryAnswer('getPlugins', inactiveA);
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{}', false));

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await settle();

      expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recordLoadAnswered', ok: false }));
      expect(comparisonsAsked(client)).toEqual([]);
    });

    it('reads the file\'s column from the file on disk when mEdit cannot say whether its plugin is active, so it shows either way', async () => {
      h.disk.set(FILE, '{ "EditorID": "OnDisk" }');
      const client = holdingClient();
      client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{}', false));

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await settle();

      expect(comparisonsAsked(client)).toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }' }]]);
    });

    it('reads again when its text changes, and not when another document\'s does or a save leaves its text as it was', async () => {
      const { openFile } = makeEditor(holdingClient());
      const document = fileDocument('{}', true);
      const tab = await openFile(FILE, document);

      changeDocument({ document: fileDocument('{}', true), contentChanges: [typed] });
      changeDocument({ document, contentChanges: [] });
      changeDocument({ document, contentChanges: [typed] });

      expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
    });
  });
});

describe('a record tab closed while its read is in flight', () => {
  it('is told nothing and keeps its title when the read lands', async () => {
    const PLACED = '000803:A.esp';
    const client = new InMemoryMEditClient();
    let land: (answer: ReturnType<typeof comparisonOf>) => void = () => undefined;
    client.setQueryAnswerOnce('getComparison', new Promise((resolve) => { land = resolve; }));
    client.setQueryAnswer('getPlugins', []);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument({
      scheme: 'modbench-child-record', path: '/mods/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA',
    });
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });

    tab.close();
    land(comparisonOf(PLACED, [{ plugin: 'A.esp', origin: 'ModA', isWinner: true, editorId: 'SharedRef' }]));
    await settle();

    expect(tab.webview.postMessage).not.toHaveBeenCalled();
    expect(tab.title).toBe(PLACED);
  });
});

describe('what a record tab\'s webview posts', () => {
  const GUN = '000801:A.esp';
  const compare = comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]);
  const loadRequest = { type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: GUN, columns: [] };
  const answered = (tab: FakePanel) => tab.webview.postMessage.mock.calls.map((call: unknown[]) => call[0]);
  const loadAnswered = (tab: FakePanel) => answered(tab).filter((message) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'recordLoadAnswered');

  function client(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', compare);
    client.setQueryAnswer('getPlugins', activeA);
    return client;
  }

  describe('an edit of a field', () => {
    const [FORM_KEY, MODDED] = ['000800:A.esp', '000900:A.esp'];
    const path = [{ kind: 'member', name: 'Keywords' }];
    function editing(): InMemoryMEditClient {
      const editing = client();
      editing.setQueryAnswer('getRecordFile', { path: '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json' });
      editing.setQueryAnswer('getRecordOfFile', { formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA' });
      editing.setQueryAnswer('getEditChanges', { applied: true, moves: [], documents: [] });
      return editing;
    }
    const edits = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getEditChanges').map(({ args }) => args.slice(0, 3));

    it('is sent to mEdit for the column\'s (origin, filename), with the envelope the grid posted', async () => {
      const mEdit = editing();
      const { open } = makeEditor(mEdit);
      const envelope = { op: 'set', path: [{ kind: 'member', name: 'Height' }], value: 0.75 };

      open(FORM_KEY).receive({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', envelope });
      await settle();

      expect(edits(mEdit)).toEqual([[FORM_KEY, { name: 'A.esp', origin: 'ModA' }, envelope]]);
    });

    it('is sent with the value a drop supplies, for an element added', async () => {
      const mEdit = editing();
      const { open } = makeEditor(mEdit);
      const context = { webviewSection: 'arrayParent', formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', path, preventDefaultContextMenuItems: true };

      open(FORM_KEY).receive({ type: WEBVIEW_TO_EXTENSION.ADD_ELEMENT, context, value: { Keyword: GUN } });
      await settle();

      expect(edits(mEdit)).toEqual([[FORM_KEY, { name: 'A.esp', origin: 'ModA' }, { op: 'add', path, value: { Keyword: GUN } }]]);
    });

    it('from a right-click, on a record the tab\'s last edit moved, is sent to the FormKey the record is at now', async () => {
      const mEdit = editing();
      mEdit.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MODDED, moves: [], documents: [] });
      const { open } = makeEditor(mEdit);
      const tab = open(FORM_KEY);
      const context = { webviewSection: 'arrayParent', formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', path, preventDefaultContextMenuItems: true };
      await h.commands.get('modbench.record.editField')?.(
        { formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA' }, { op: 'set', path, value: 'x' });
      mEdit.setQueryAnswer('getEditChanges', { applied: true, moves: [], documents: [] });

      await h.commands.get('modbench.record.addElement')?.(context);

      expect(edits(mEdit).map(([formKey]) => formKey)).toEqual([FORM_KEY, MODDED]);
      expect(tab.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('that names nothing the host knows', () => {
    it.each([
      ['a type this build does not know', { type: 'somethingElse' }],
      ['a string', 'not an object'],
      ['null', null],
      ['a FormKey of the wrong type', { type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: 123, plugin: 'A.esp', origin: 'ModA', envelope: { op: 'set', path: [] } }],
    ])('is ignored, as %s', async (_, message) => {
      const mEdit = client();
      const { open } = makeEditor(mEdit);
      const tab = open(GUN);
      const [executed, asked] = [h.executed.length, mEdit.calls.length];

      tab.receive(message);
      await settle();

      expect([h.executed.length, mEdit.calls.length]).toEqual([executed, asked]);
      expect(tab.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  it('opens nothing for a click on a column\'s header in a tab VS Code has not shown', () => {
    const { open } = makeEditor(client());
    const tab = open(GUN);
    tab.viewColumn = undefined;

    tab.receive({ type: WEBVIEW_TO_EXTENSION.OPEN_IN_PLACE, records: [{ formKey: '000803:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }] });

    expect(h.executed.filter(([id]) => id === 'modbench.record.open')).toEqual([]);
  });

  it('answers a request for a FormKey the picker was dismissed on with null, correlated by requestId', async () => {
    const { open } = makeEditor(client());
    const tab = open(GUN);

    tab.receive({ type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: [] });
    await settle();

    expect(tab.webview.postMessage).toHaveBeenCalledWith({ type: 'formKeyPicked', requestId: 'r1', formKey: null });
  });

  describe('a request for the record', () => {
    it('is answered with the comparison, the plugin list, whether conflicts are computed, the plugins mEdit cannot read and the plugin the tab\'s document holds', async () => {
      const mEdit = client();
      const { open } = makeEditor(mEdit);
      const tab = open(GUN);
      const failure = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };
      mEdit.emit({
        kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
        loadOrderStatus: { state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: true, failures: [failure], version: 1 },
      });

      tab.receive(loadRequest);
      await settle();

      expect(loadAnswered(tab)).toEqual([{
        type: 'recordLoadAnswered', requestId: 'r1', ok: true, compare, plugins: activeA, conflictsComputed: true,
        loadFailures: [failure], documentPlugin: COPY_PLUGIN, modsByOrigin: {},
      }]);
      expect(comparisonsAsked(mEdit)).toEqual([[GUN, undefined]]);
    });

    it('is answered with a null comparison, not a failure, for a record no active plugin holds', async () => {
      const mEdit = client();
      mEdit.setQueryAnswer('getComparison', null);
      const { open } = makeEditor(mEdit);
      const tab = open(GUN);

      tab.receive(loadRequest);
      await settle();

      expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, compare: null, conflictsComputed: false, loadFailures: [] })]);
    });

    it('is answered with a null plugin list, rather than failed, when only the list fails', async () => {
      const mEdit = client();
      mEdit.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));
      const { openDocument } = makeEditor(mEdit);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });

      tab.receive(loadRequest);
      await settle();

      expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, compare, plugins: null })]);
    });

    it.each([
      ['an active plugin in a tracked mod', activeA, 'ModA', { ModA: 'tracked' }],
      ['a disabled plugin in a tracked mod', inactiveA, 'ModA', { ModA: 'tracked' }],
      ['an active plugin in an untracked mod', activeA, 'ModB', { ModB: 'untracked' }],
      ['a disabled plugin in an untracked mod', inactiveA, 'ModB', { ModB: 'untracked' }],
      ['a plugin in a mod whose folder spells the origin in another case', activeA, 'modb', { modb: 'untracked' }],
      ['a plugin in the game folder', activeA, 'Data', {}],
      ['a plugin in Overwrite', activeA, 'Overwrite', {}],
    ])('is answered with the repository state of the mod each origin names, for %s', async (_what, plugins, origin, modsByOrigin) => {
      const mEdit = client();
      mEdit.setQueryAnswer('getPlugins', plugins);
      mEdit.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin, isWinner: true, editorId: 'Gun' }]));
      const modFacts = { ...NO_MODS, trackedMods: () => new Set(['ModA']), modDirs: () => new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB']]) };
      const { openDocument } = makeEditor(mEdit, undefined, modFacts);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });

      tab.receive(loadRequest);
      await settle();

      expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, modsByOrigin })]);
    });

    it('tells the tab the repository state of the origins it showed when the instance changes, and no longer once the tab is closed', async () => {
      const mEdit = client();
      mEdit.setQueryAnswer('getPlugins', activeA);
      mEdit.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: 'ModB', isWinner: true, editorId: 'Gun' }]));
      let tracked = new Set<string>();
      const changed: (() => void)[] = [];
      const modFacts = {
        trackedMods: () => tracked, modDirs: () => new Map([['ModB', '/mods/ModB']]),
        onChange: (listener: () => void) => { changed.push(listener); return { dispose: () => undefined }; },
      };
      const { openDocument } = makeEditor(mEdit, undefined, modFacts);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });
      tab.receive(loadRequest);
      await settle();
      const told = () => tab.webview.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'modsChanged');

      tracked = new Set(['ModB']);
      changed.forEach((listener) => { listener(); });

      expect(told()).toEqual([{ type: 'modsChanged', modsByOrigin: { ModB: 'tracked' } }]);
      tab.close();
      changed.forEach((listener) => { listener(); });
      expect(told()).toHaveLength(1);
    });

    it('is failed, naming the record in the Output and leaving the tab\'s title, when the comparison fails', async () => {
      const mEdit = client();
      mEdit.setQueryFailure('getComparison', new Error('ECONNREFUSED'));
      const { openDocument, outputChannel } = makeEditor(mEdit);
      const tab = await openDocument({
        scheme: 'modbench-child-record', path: '/mods/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000801%3AA.esp&name=A.esp&origin=ModA',
      });

      tab.receive(loadRequest);
      await settle();

      expect(loadAnswered(tab)).toEqual([{ type: 'recordLoadAnswered', requestId: 'r1', ok: false, error: 'ECONNREFUSED' }]);
      expect(outputChannel.warn).toHaveBeenCalledWith(`Failed to read ${GUN}: ECONNREFUSED`);
      expect(tab.title).toBe(GUN);
    });
  });
});

describe('a click on a column\'s header', () => {
  it('opens the records it names in the place of the tab it was clicked in, as that tab stood when the click arrived', async () => {
    const gun = { formKey: '000801:A.esp', plugin: COPY_PLUGIN };
    const { openDocument } = makeEditor();
    const uri = renderedUri(gun.formKey, 'Gun.json');
    const tab = await openDocument(uri);
    const knife = { formKey: '000803:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

    tab.receive({ type: 'openInPlace', records: [knife] });
    tab.viewColumn = 3;

    expect(h.executed.filter(([id]) => id === 'modbench.record.open'))
      .toEqual([['modbench.record.open', [{ ...knife, placement: { document: String(uri), viewColumn: 2 } }]]]);
  });
});

describe('an untracked copy\'s tab', () => {
  const GUN = '000801:A.esp';
  const RENDERED = renderedUri(GUN, 'Gun.json');

  it('shows the copy\'s record, followed by Referenced By, with no file for mEdit to name it by', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    const { openDocument, referencedBy } = makeEditor(client);

    const tab = await openDocument(RENDERED);

    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect((await recordOf(referencedBy)).description).toBe('Gun');
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
  });

  async function readOf(plugins: typeof activeA): Promise<unknown[][]> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', plugins);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(RENDERED, { isDirty: false, getText: () => '{ "EditorID": "Rendered" }' });

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await settle();
    return comparisonsAsked(client);
  }

  it('reads every column from mEdit while the copy\'s plugin is active, its document being mEdit\'s own copy', async () => {
    expect(await readOf(activeA)).toEqual([[GUN, undefined]]);
  });

  it('reads the copy\'s column from its document while its plugin is not active, as mEdit compares no copy of it', async () => {
    expect(await readOf(inactiveA)).toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Rendered" }' }]]);
  });
});

describe('a child record\'s tab', () => {
  const PLACED = '000803:A.esp';
  const CHILD = { scheme: 'modbench-child-record', path: '/mods/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA' };

  it('shows the child\'s record, not its container\'s, titled with the opened copy\'s name once its read is answered', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(PLACED, [
      { plugin: 'A.esp', origin: 'ModA', isWinner: false, editorId: 'SharedRef' },
      { plugin: 'B.esp', origin: 'ModB', isWinner: true, editorId: 'RenamedRef' },
    ]));
    client.setQueryAnswer('getPlugins', []);
    const { openDocument } = makeEditor(client);

    const tab = await openDocument(CHILD);
    expect(pageGlobal(tab, 'mEditFormKey')).toBe(PLACED);
    expect(tab.title).toBe(PLACED);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });
    await settle();

    expect(tab.title).toBe('SharedRef');
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
  });

  async function readOf(document: object, plugins = inactiveA): Promise<unknown[][]> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', plugins);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(CHILD, document);

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });
    await settle();
    return comparisonsAsked(client);
  }

  it('reads the child\'s column from its container\'s unsaved text, out of which mEdit reads the child', async () => {
    expect(await readOf({ isDirty: true, getText: () => '{ "EditorID": "Cell" }' }, activeA))
      .toEqual([[PLACED, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Cell" }' }]]);
  });

  it('reads the child\'s column from mEdit once its container is saved and its plugin is active', async () => {
    h.disk.set(CHILD.path, '{ "EditorID": "OnDisk" }');
    expect(await readOf({ isDirty: false, getText: () => '{ "EditorID": "Cell" }' }, activeA)).toEqual([[PLACED, undefined]]);
  });

  it('reads the child\'s column from its container\'s file on disk once it is saved and its plugin is not active', async () => {
    h.disk.set(CHILD.path, '{ "EditorID": "OnDisk" }');
    expect(await readOf({ isDirty: false, getText: () => '{ "EditorID": "Cell" }' }))
      .toEqual([[PLACED, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }' }]]);
  });

  it('reads again when its container\'s text changes, and not when another document\'s does', async () => {
    const { openDocument } = makeEditor(new InMemoryMEditClient());
    const document = { isDirty: true, getText: () => '{}' };
    const tab = await openDocument(CHILD, document);
    const typed = { range: {}, text: 'x' };

    changeDocument({ document: { isDirty: true, getText: () => '{}' }, contentChanges: [typed] });
    changeDocument({ document, contentChanges: [typed] });

    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: PLACED }]]);
  });
});

describe('several records opened at once', () => {
  const [GUN, AMMO, KNIFE] = ['000801:A.esp', '000802:A.esp', '000803:C.esp'];
  const winner = { name: 'B.esp', origin: 'ModB' };
  const knifeIn = { name: 'C.esp', origin: 'ModC' };
  const gunDocument = renderedUri(GUN, 'Gun.json');
  const columnsPosted = (tab: FakePanel | undefined) => tab?.webview.postMessage.mock.calls.filter(([message]) => isShowColumns(message));
  const firstRead = { type: 'requestRecordLoad', requestId: 'r0', formKey: GUN, columns: [] };
  const openSeveral = (placement?: 'beside') => h.commands.get('modbench.record.open')?.(
    [{ formKey: GUN, plugin: COPY_PLUGIN, placement }, { formKey: AMMO, placement }, { formKey: KNIFE, plugin: knifeIn, placement }]);
  function severalClient(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOwner', winner);
    client.setQueryAnswer('getRecordFile', { path: null });
    client.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    client.setQueryAnswer('getPlugins', activeA);
    client.setQueryAnswer('getComparison', null);
    return client;
  }

  it('open one grid, pinned: the first record\'s document, with the others as its columns in the order given, each without a plugin its winning copy', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();

    await openSeveral();

    expect(h.executed.filter(([id]) => id === 'vscode.openWith'))
      .toEqual([['vscode.openWith', gunDocument, 'modbench.record', { viewColumn: -1, preview: false }]]);
    const tab = tabOn(gunDocument);
    expect(pageGlobal(tab ?? fakePanel(), 'mEditColumns'))
      .toEqual([{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }]);
    expect(tab?.webview.postMessage).not.toHaveBeenCalled();
  });

  it('show the first record\'s tab already open, which takes the others as its columns, and leave its tab in another group alone', async () => {
    const { vsCodeOpensTabs, openDocument } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await h.commands.get('modbench.record.open')?.({ formKey: GUN, plugin: COPY_PLUGIN });
    tabOn(gunDocument)?.receive(firstRead);
    const elsewhere = await openDocument(gunDocument);
    elsewhere.active = false;

    await openSeveral();

    expect(columnsPosted(tabOn(gunDocument))).toEqual([[{
      type: 'showColumns', columns: [{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }],
    }]]);
    expect(elsewhere.webview.postMessage).not.toHaveBeenCalled();
  });

  it('hold the columns for a tab whose page has asked no read yet, which listens only once it has', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await h.commands.get('modbench.record.open')?.({ formKey: GUN, plugin: COPY_PLUGIN });
    const tab = tabOn(gunDocument);

    await openSeveral();
    await settle();
    expect(columnsPosted(tab)).toEqual([]);

    tab?.receive(firstRead);
    await settle();
    expect(columnsPosted(tab)).toHaveLength(1);
  });

  it('leave the tab they opened to show every active plugin\'s copy again when its record is opened alone onto it', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await openSeveral();
    tabOn(gunDocument)?.receive(firstRead);

    await h.commands.get('modbench.record.open')?.({ formKey: GUN, plugin: COPY_PLUGIN });

    expect(columnsPosted(tabOn(gunDocument))).toEqual([[{ type: 'showColumns', columns: [] }]]);
  });

  it('read the tab again when mEdit reports a record of another column changed, and not for a record it does not show', async () => {
    const client = severalClient();
    client.setQueryAnswer('getRecordsComparison', null);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(gunDocument);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [{ formKey: AMMO, plugin: winner }] });
    await settle();

    client.emit({ kind: 'rows-changed', plugin: 'C.esp', origin: 'ModC', keys: [KNIFE], sequence: 1 });
    client.emit({ kind: 'rows-changed', plugin: 'B.esp', origin: 'ModB', keys: [AMMO], sequence: 2 });

    expect(tab.webview.postMessage.mock.calls).toEqual([[expect.objectContaining({ type: 'recordLoadAnswered' })], [{ type: 'loadRecord', formKey: GUN }]]);
  });

  it('read the first record\'s copy and the columns the tab shows side by side, in that order', async () => {
    const client = severalClient();
    client.setQueryAnswer('getRecordsComparison', null);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(gunDocument);

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [{ formKey: AMMO, plugin: winner }] });
    await settle();

    expect(client.calls.filter(({ method }) => method === 'getRecordsComparison').map(({ args }) => args))
      .toEqual([[[{ formKey: GUN, plugin: COPY_PLUGIN }, { formKey: AMMO, plugin: winner }]]]);
    expect(comparisonsAsked(client)).toEqual([]);
  });
});

describe('mEdit\'s reports to an open record tab', () => {
  const GUN = '000801:A.esp';
  const reported = (kind: 'rows-changed' | 'plugin-changed', keys: string[]) =>
    ({ kind, plugin: 'A.esp', origin: 'ModA', keys, sequence: 1 }) as const;

  it('has a tab read its record again when a report names it, and not when a report names another record or a plugin\'s change', () => {
    const client = new InMemoryMEditClient();
    const { open } = makeEditor(client);
    const tab = open(GUN);

    client.emit(reported('rows-changed', ['000802:A.esp']));
    client.emit(reported('plugin-changed', [GUN]));
    expect(tab.webview.postMessage).not.toHaveBeenCalled();

    client.emit(reported('rows-changed', [GUN]));
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });

  it('is not heard once the Editor is disposed', () => {
    const client = new InMemoryMEditClient();
    const { editor, open } = makeEditor(client);
    const tab = open(GUN);

    editor.dispose();
    client.emit(reported('rows-changed', [GUN]));

    expect(tab.webview.postMessage).not.toHaveBeenCalled();
  });

  describe('of a plugin it cannot read', () => {
    const tick = (failures: { name: string; origin: string; reason: string }[]): NotificationEvent => ({
      kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
      loadOrderStatus: {
        state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: false, failures, version: 1,
      },
    });
    const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

    it('has the tabs read again on a failure arriving and on it clearing, and not on an identical tick', () => {
      const client = new InMemoryMEditClient();
      const { open } = makeEditor(client);
      const tab = open(GUN);

      client.emit(tick([bad]));
      client.emit(tick([bad]));
      client.emit(tick([]));

      expect(tab.webview.postMessage.mock.calls).toEqual([
        [{ type: 'loadRecord', formKey: GUN }],
        [{ type: 'loadRecord', formKey: GUN }],
      ]);
    });
  });
});

describe('a record tab', () => {
  it('keeps its page alive while it is hidden', () => {
    makeEditor();

    expect(h.editorProviderOptions.get('modbench.record')).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
  });
});

describe('the grid\'s F2', () => {
  it('opens the editor of the focused cell of the record tab in focus, and of no other tab', async () => {
    const { open } = makeEditor();
    const behind = open('000801:A.esp');
    const inFocus = open('000802:A.esp');

    await h.commands.get('modbench.recordGrid.editHere')?.();

    expect(inFocus.webview.postMessage).toHaveBeenCalledWith({ type: 'openCellEditor' });
    expect(behind.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('the Editor disposed', () => {
  it('lets go of what it registered once, however often it is disposed', () => {
    const { editor } = makeEditor();
    h.editorProviderDisposals = 0;

    editor.dispose();
    editor.dispose();

    expect(h.editorProviderDisposals).toBe(h.editorProviders.size);
  });
});
