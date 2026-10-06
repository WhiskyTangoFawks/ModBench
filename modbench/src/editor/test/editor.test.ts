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
  treeViews: [] as FakeTreeView[],
  documentChanges: new Set<(event: { document: unknown; contentChanges: unknown[] }) => void>(),
  disk: new Map<string, string>(),
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon,
  Disposable: class {
    constructor(public dispose: () => void) {}
    static from(...parts: { dispose(): void }[]) { return { dispose: () => parts.forEach((part) => part.dispose()) }; }
  },
  Uri: {
    from: (parts: Parameters<typeof uriFrom>[0]) => Object.defineProperty(uriFrom(parts), 'toString', {
      value: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}`,
    }),
    joinPath: (...parts: unknown[]) => parts.join('/'),
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
        const text = h.disk.get(fsPath ?? path ?? '');
        return text === undefined ? Promise.reject(new Error('no such file')) : Promise.resolve(new TextEncoder().encode(text));
      },
    },
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: (listener: (event: { document: unknown; contentChanges: unknown[] }) => void) => {
      h.documentChanges.add(listener);
      return { dispose: () => h.documentChanges.delete(listener) };
    },
  },
  window: {
    registerCustomEditorProvider: (viewType: string, provider: unknown) => {
      h.editorProviders.set(viewType, provider);
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

import { createEditor } from '..';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { createFocusedView } from '../../drivingLib/focusedView';
import { renderedDocumentUri } from '../../drivingLib/recordDocument';
import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { ReferencedByTreeProvider } from '../ReferencedByTreeProvider';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { comparisonOf } from '../../test/comparison';

const COPY_PLUGIN = { name: 'A.esp', origin: 'ModA' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakePanel {
  title: string;
  active: boolean;
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
    title: '', active: true,
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

function makeEditor(client = new InMemoryMEditClient(), viewSelections = new Map<string, () => readonly unknown[]>()) {
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
  });
  const provider = h.editorProviders.get('modbench.record');
  if (!isRecordEditorProvider(provider)) throw new Error('no record editor registered');
  const referencedBy = h.treeViews.at(-1);
  if (!referencedBy) throw new Error('no Referenced By view');
  const open = (formKey: string): FakePanel => {
    const panel = fakePanel();
    void provider.resolveCustomTextEditor({ uri: renderedDocumentUri({ formKey, plugin: COPY_PLUGIN }, `${formKey}.json`) }, panel);
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

describe('the focused cell of the record tab in focus', () => {
  it('publishes its keys, enters the record grid as the focused view and is what copy value copies from it', () => {
    const { editor, open, focusedView } = makeEditor();
    const panel = open('000801:A.esp');

    panel.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { webviewSection: 'field', copyText: 'Iron' }, entered: true });

    expect(h.contextKeys.get('modbench.record.focusedCellSection')).toBe('field');
    expect(focusedView.id()).toBe('modbench.recordGrid');
    expect(editor.copyValue.map(({ text }) => text({ view: 'modbench.recordGrid' }, undefined))).toEqual(['Iron', undefined]);
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
    { formKey, plugin: 'Mod.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: 'x' });
  const editedFormKeys = (client: InMemoryMEditClient) => client.calls.filter(c => c.method === 'editRecord').map(c => c.args[0]);

  it('sends an edit of the moved plugin addressed with the old FormKey to the new one until the tab\'s read of it is answered, and not after', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', []);
    const { open } = makeEditor(client);
    const tab = open(OLD);
    client.setCommandResult('editRecord', { applied: true, newFormKey: MOVED });
    await editField(OLD);
    client.setCommandResult('editRecord', { applied: true });
    client.emit({ kind: 'rows-changed', plugin: 'Mod.esp', origin: 'ModA', keys: [OLD, MOVED], sequence: 2 });
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: MOVED }]]);

    await editField(OLD);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: MOVED, columns: [] });
    await settle();
    await editField(OLD);

    expect(editedFormKeys(client)).toEqual([OLD, MOVED, OLD]);
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
    expect(opened()).toEqual([renderedDocumentUri({ formKey: '000803:A.esp', plugin: COPY_PLUGIN }, 'Placed.json')]);
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
    async function readOf(document: object): Promise<unknown[][]> {
      const client = holdingClient();
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, document);
      Object.assign(document, { text: '{ "EditorID": "Typed" }' });
      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await settle();
      return comparisonsAsked(client);
    }

    it('reads the file\'s column from the unsaved text as it is when the read is asked', async () => {
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', true)))
        .toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Typed" }' }]]);
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

    it('reads the file\'s column from the file on disk once the document is saved, which VS Code may not have read, whatever its plugin\'s state', async () => {
      h.disk.set(FILE, '{ "EditorID": "OnDisk" }');
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false)))
        .toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }' }]]);
    });

    it('reads the file\'s column from mEdit once the saved document is gone from disk', async () => {
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false))).toEqual([[GUN, undefined]]);
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

describe('an untracked copy\'s tab', () => {
  const GUN = '000801:A.esp';
  const RENDERED = renderedDocumentUri({ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } }, 'Gun.json');

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

  it('reads every column from mEdit, its document being mEdit\'s own copy', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(RENDERED, { getText: () => '{}' });

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await settle();

    expect(comparisonsAsked(client)).toEqual([[GUN, undefined]]);
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

  async function readOf(document: object): Promise<unknown[][]> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(CHILD, document);

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });
    await settle();
    return comparisonsAsked(client);
  }

  it('reads the child\'s column from its container\'s unsaved text, out of which mEdit reads the child', async () => {
    expect(await readOf({ isDirty: true, getText: () => '{ "EditorID": "Cell" }' }))
      .toEqual([[PLACED, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Cell" }' }]]);
  });

  it('reads the child\'s column from its container\'s file on disk once it is saved', async () => {
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
  const gunDocument = renderedDocumentUri({ formKey: GUN, plugin: COPY_PLUGIN }, 'Gun.json');
  const openSeveral = (placement?: 'beside') => h.commands.get('modbench.record.open')?.(
    [{ formKey: GUN, plugin: COPY_PLUGIN, placement }, { formKey: AMMO, placement }, { formKey: KNIFE, plugin: knifeIn, placement }]);
  function severalClient(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOwner', winner);
    client.setQueryAnswer('getRecordFile', { path: null });
    client.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    client.setQueryAnswer('getPlugins', []);
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
    const elsewhere = await openDocument(gunDocument);
    elsewhere.active = false;

    await openSeveral();

    expect(tabOn(gunDocument)?.webview.postMessage.mock.calls).toEqual([[{
      type: 'showColumns', columns: [{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }],
    }]]);
    expect(elsewhere.webview.postMessage).not.toHaveBeenCalled();
  });

  it('leave the tab they opened to show every active plugin\'s copy again when its record is opened alone onto it', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await openSeveral();

    await h.commands.get('modbench.record.open')?.({ formKey: GUN, plugin: COPY_PLUGIN });

    expect(tabOn(gunDocument)?.webview.postMessage.mock.calls).toEqual([[{ type: 'showColumns', columns: [] }]]);
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

describe('the Editor disposed', () => {
  it('lets go of what it registered once, however often it is disposed', () => {
    const { editor } = makeEditor();
    h.editorProviderDisposals = 0;

    editor.dispose();
    editor.dispose();

    expect(h.editorProviderDisposals).toBe(h.editorProviders.size);
  });
});
