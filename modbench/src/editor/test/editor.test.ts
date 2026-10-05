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
  editorProviders: [] as unknown[],
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
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
  },
  window: {
    registerCustomEditorProvider: (_viewType: string, provider: unknown) => {
      h.editorProviders.push(provider);
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
import { InMemoryMEditClient } from '../../client';
import { createFocusedView } from '../../drivingLib/focusedView';
import { recordUri } from '../recordUri';
import { ReferencedByTreeProvider } from '../ReferencedByTreeProvider';
import { expectInstanceOf } from '../../test/expectInstanceOf';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakePanel {
  title: string;
  active: boolean;
  webview: { postMessage: ReturnType<typeof vi.fn>; options?: unknown; html?: string; cspSource: string; asWebviewUri: (uri: unknown) => unknown; onDidReceiveMessage: () => { dispose(): void } };
  onDidDispose: (listener: () => void) => { dispose(): void };
  onDidChangeViewState: (listener: () => void) => { dispose(): void };
  focus(): void;
  close(): void;
}

function fakePanel(): FakePanel {
  const disposed: (() => void)[] = [];
  const viewState: (() => void)[] = [];
  const panel: FakePanel = {
    title: '', active: true,
    webview: {
      postMessage: vi.fn(() => Promise.resolve(true)), cspSource: 'csp', asWebviewUri: (uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
    },
    onDidDispose: (listener) => { disposed.push(listener); return { dispose: () => undefined }; },
    onDidChangeViewState: (listener) => { viewState.push(listener); return { dispose: () => undefined }; },
    focus: () => { viewState.forEach((listener) => { listener(); }); },
    close: () => { disposed.forEach((listener) => { listener(); }); },
  };
  return panel;
}

interface RecordEditorProvider {
  openCustomDocument(uri: unknown): unknown;
  resolveCustomEditor(document: unknown, panel: unknown): void;
}

const isRecordEditorProvider = (value: unknown): value is RecordEditorProvider =>
  typeof value === 'object' && value !== null && 'openCustomDocument' in value && 'resolveCustomEditor' in value;

function makeEditor(client = new InMemoryMEditClient(), viewSelections = new Map<string, () => readonly unknown[]>()) {
  const focusedView = createFocusedView();
  const editor = createEditor({
    context: { extensionUri: fakeUri('/ext') },
    meditClient: client,
    outputChannel: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    reporterFor: () => ({ report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() }),
    ask: vi.fn(),
    focusedView,
    viewSelections,
    recordWrite: (command) => command(),
    refreshSourceControlFor: () => undefined,
  });
  const provider = h.editorProviders.at(-1);
  if (!isRecordEditorProvider(provider)) throw new Error('no record editor registered');
  const referencedBy = h.treeViews.at(-1);
  if (!referencedBy) throw new Error('no Referenced By view');
  const open = (formKey: string): FakePanel => {
    const panel = fakePanel();
    provider.resolveCustomEditor(provider.openCustomDocument(recordUri({ formKey })), panel);
    return panel;
  };
  return { editor, open, referencedBy, focusedView };
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
    open('000801:A.esp');

    editor.focusRecordCell({ webviewSection: 'field', copyText: 'Iron' });

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

describe('a record gesture from the palette', () => {
  it('opens the records selected in a view the Editor is handed, while that view has the focus', async () => {
    const plugins = { selection: [{ formKey: '000803:A.esp', kind: 'placed' }], onDidChangeSelection: (listener: (event: { selection: unknown[] }) => void) => { listener({ selection: [] }); return { dispose: () => undefined }; } };
    const { focusedView } = makeEditor(new InMemoryMEditClient(), new Map([['modbench.pluginListTree', () => plugins.selection]]));
    focusedView.follow('modbench.pluginListTree', plugins);

    await h.commands.get('modbench.record.open')?.();

    expect(h.contextKeys.get('modbench.record.selectionIn')).toBe('modbench.pluginListTree');
    expect(opened()).toEqual([recordUri({ formKey: '000803:A.esp' })]);
  });
});

describe('the Editor disposed', () => {
  it('lets go of what it registered once, however often it is disposed', () => {
    const { editor } = makeEditor();
    h.editorProviderDisposals = 0;

    editor.dispose();
    editor.dispose();

    expect(h.editorProviderDisposals).toBe(1);
  });
});
