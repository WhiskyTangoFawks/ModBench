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
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon,
  Disposable: class {
    constructor(public dispose: () => void) {}
    static from(...parts: { dispose(): void }[]) { return { dispose: () => parts.forEach((part) => part.dispose()) }; }
  },
  Uri: { from: uriFrom, joinPath: (...parts: unknown[]) => parts.join('/') },
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
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
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
import { recordUri } from '../recordUri';
import { renderedDocumentUri } from '../renderedDocument';
import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { ReferencedByTreeProvider } from '../ReferencedByTreeProvider';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { comparisonOf } from '../../test/comparison';

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
  openCustomDocument(uri: unknown): unknown;
  resolveCustomEditor(document: unknown, panel: unknown): void;
}

const isRecordEditorProvider = (value: unknown): value is RecordEditorProvider =>
  typeof value === 'object' && value !== null && 'openCustomDocument' in value && 'resolveCustomEditor' in value;

interface RecordFileEditorProvider {
  resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>;
}

const isRecordFileEditorProvider = (value: unknown): value is RecordFileEditorProvider =>
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
    provider.resolveCustomEditor(provider.openCustomDocument(recordUri(formKey)), panel);
    return panel;
  };
  const fileProvider = h.editorProviders.get('modbench.recordFile');
  if (!isRecordFileEditorProvider(fileProvider)) throw new Error('no record file editor registered');
  const openDocument = async (uri: unknown): Promise<FakePanel> => {
    const panel = fakePanel();
    await fileProvider.resolveCustomTextEditor({ uri }, panel);
    return panel;
  };
  const openFile = (fsPath: string): Promise<FakePanel> => openDocument({ scheme: 'file', fsPath });
  return { editor, open, openFile, openDocument, referencedBy, focusedView, outputChannel };
}

beforeEach(() => {
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
  const assigned = new RegExp(`window\\.${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(panel.webview.html ?? '')?.[1];
  return assigned === undefined ? undefined : JSON.parse(assigned);
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
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: MOVED });
    await settle();
    await editField(OLD);

    expect(editedFormKeys(client)).toEqual([OLD, MOVED, OLD]);
  });
});

describe('a record gesture from the palette', () => {
  it('opens the records selected in a view the Editor is handed, while that view has the focus', async () => {
    const plugins = { selection: [{ formKey: '000803:A.esp', kind: 'placed' }], onDidChangeSelection: (listener: (event: { selection: unknown[] }) => void) => { listener({ selection: [] }); return { dispose: () => undefined }; } };
    const { focusedView } = makeEditor(new InMemoryMEditClient(), new Map([['modbench.pluginListTree', () => plugins.selection]]));
    focusedView.follow('modbench.pluginListTree', plugins);

    await h.commands.get('modbench.record.open')?.();

    expect(h.contextKeys.get('modbench.record.selectionIn')).toBe('modbench.pluginListTree');
    expect(opened()).toEqual([recordUri('000803:A.esp')]);
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

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN });
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
});

describe('an untracked copy\'s tab', () => {
  it('shows the copy\'s record, followed by Referenced By, with no file for mEdit to name it by', async () => {
    const GUN = '000801:A.esp';
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    const { openDocument, referencedBy } = makeEditor(client);

    const tab = await openDocument(renderedDocumentUri({ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } }, 'Gun.json'));

    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect((await recordOf(referencedBy)).description).toBe('Gun');
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
  });
});

describe('a child record\'s tab', () => {
  it('shows the child\'s record, not its container\'s, titled with the child\'s name once its read is answered', async () => {
    const PLACED = '000803:A.esp';
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(PLACED, [{ plugin: 'A.esp', isWinner: true, editorId: 'SharedRef' }]));
    client.setQueryAnswer('getPlugins', []);
    const { openDocument } = makeEditor(client);
    const uri = { scheme: 'modbench-child-record', path: '/mods/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA' };

    const tab = await openDocument(uri);
    expect(pageGlobal(tab, 'mEditFormKey')).toBe(PLACED);
    expect(tab.title).toBe(PLACED);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED });
    await settle();

    expect(tab.title).toBe('SharedRef');
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
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
