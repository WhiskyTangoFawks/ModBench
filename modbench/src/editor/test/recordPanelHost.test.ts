import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const registerFileSystemProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
const pickRecord = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const applyEdit = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));

vi.mock('../recordPicker', () => ({ pickRecord: (...args: unknown[]) => pickRecord(...args) }));

vi.mock('vscode', async () => ({
  TreeItem: (await import('../../test/vscodeMock')).TreeItem,
  TreeItemCollapsibleState: (await import('../../test/vscodeMock')).TreeItemCollapsibleState,
  Range: (await import('../../test/vscodeMock')).Range,
  WorkspaceEdit: class { renameFile() { return undefined; } createFile() { return undefined; } replace() { return undefined; } },
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire() { return undefined; } dispose() { return undefined; } },
  Uri: { from: ({ path, query }: { path: string; query?: string }) => (query ? `${path}?${query}` : path), file: (path: string) => ({
    scheme: 'file', path, fsPath: path,
    toString: () => `file://${path}`, with: ({ scheme, query }: { scheme: string; query: string }) => `${scheme}:${path}?${query}`,
  }), joinPath: vi.fn() },
  Disposable: class { constructor(public dispose: () => void) {} },
  ViewColumn: { Active: -1, One: 1, Beside: -2 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: (...args: unknown[]) => executeCommand(...args),
  },
  workspace: {
    registerFileSystemProvider: (...args: unknown[]) => registerFileSystemProvider(...args),
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: () => ({ dispose: () => undefined }),
    openTextDocument: (uri: unknown) => Promise.resolve({ uri, getText: () => '{}', isDirty: false }),
    applyEdit: () => applyEdit(),
  },
  window: {
    registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    registerCustomEditorProvider: (...args: unknown[]) => registerCustomEditorProvider(...args),
  },
}));

import * as vscode from 'vscode';
import { registerEditorCommands } from '../recordPanelHost';
import { ActiveRecordTracker } from '../ActiveRecordTracker';
import { EditsInFlight } from '../followRecord';
import { FocusedCells } from '../focusedCells';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { renderedDocumentUri } from '../../drivingLib/recordDocument';

const reporter = { report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() };

function isPanel(candidate: unknown): candidate is vscode.WebviewPanel {
  return typeof candidate === 'object' && candidate !== null && 'webview' in candidate;
}

function fakePanel(postMessage: () => Promise<boolean> = vi.fn(() => Promise.resolve(true)), title = ''): vscode.WebviewPanel {
  const panel = { title, webview: { postMessage } };
  if (!isPanel(panel)) throw new Error('not a panel');
  return panel;
}

interface Registered {
  selection?: () => readonly unknown[];
  recordPanels?: Set<vscode.WebviewPanel>;
  tracker?: ActiveRecordTracker<vscode.WebviewPanel>;
  meditClient?: InMemoryMEditClient;
}

function register({
  selection = () => [], recordPanels = new Set(), tracker = new ActiveRecordTracker(), meditClient = new InMemoryMEditClient(),
}: Registered = {}): void {
  registerEditorCommands({
    context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
    recordPanels,
    activeRecordTracker: tracker,
    editsInFlight: new EditsInFlight(tracker),
    focusedCells: new FocusedCells(() => tracker.activePanel(), () => undefined, () => undefined),
    meditClient,
    focusedViewSelection: selection,
    viewSelections: new Map(),
    recordWrite: (command) => command(),
    refreshSourceControlFor: () => undefined,
    outputChannel: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    reporterFor: () => reporter,
    ask: vi.fn(),
  });
}

beforeEach(() => {
  commandHandlers.clear();
  registerFileSystemProvider.mockClear();
  executeCommand.mockReset();
  pickRecord.mockReset();
});

describe('registerEditorCommands', () => {
  it('keeps a record tab\'s page alive while it is hidden, so it is as I left it on return', () => {
    register();

    expect(registerCustomEditorProvider).toHaveBeenCalledWith(
      'modbench.record', expect.anything(), { webviewOptions: { retainContextWhenHidden: true } },
    );
  });
});

describe('the Editor\'s file systems', () => {
  it('are registered as soon as the Editor is: a field\'s, writable and read-only, and a child record\'s', () => {
    register();

    expect(registerFileSystemProvider.mock.calls.map(([scheme]) => scheme))
      .toEqual(['modbench-field', 'modbench-field-readonly', 'modbench-child-record']);
  });
});

describe('a record panel and the notifications', () => {
  it('subscribes to rows-changed reports and to reconnects as soon as it is registered', () => {
    const meditClient = new InMemoryMEditClient();
    const onReconnected = vi.spyOn(meditClient, 'onReconnected');
    register({ meditClient });

    expect(meditClient.calls).toContainEqual({ method: 'onNotification', args: ['rows-changed'] });
    expect(onReconnected).toHaveBeenCalled();
  });
});

describe('modbench.record.open from the palette, with no Argument', () => {
  const open = () => commandHandlers.get('modbench.record.open')?.();
  const winner = { name: 'A.esp', origin: 'ModA' };
  const renderingTheWinner = (): { meditClient: InMemoryMEditClient } => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getRecordFile', { path: null });
    meditClient.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    return { meditClient };
  };

  it('opens the records selected in the focused view as one grid, pinned, on the first record\'s document', async () => {
    register({ selection: () => [{ formKey: '000801:A.esp', kind: 'placed' }, { kind: 'record', record: { formKey: '000802:A.esp' } }], ...renderingTheWinner() });

    await open();

    expect(executeCommand.mock.calls.filter(([id]) => id === 'vscode.openWith')).toEqual([[
      'vscode.openWith', renderedDocumentUri({ formKey: '000801:A.esp', plugin: winner }, 'Gun.json'), 'modbench.record',
      { viewColumn: -1, preview: false },
    ]]);
  });

  it('asks for a record when the focused view has none selected, and opens the one picked as a preview', async () => {
    pickRecord.mockResolvedValue('000801:A.esp');
    register({ selection: () => [{ kind: 'recordType' }], ...renderingTheWinner() });

    await open();

    expect(pickRecord.mock.calls).toEqual([[{ meditClient: expect.any(InMemoryMEditClient) as unknown, reporter }, '', []]]);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith', renderedDocumentUri({ formKey: '000801:A.esp', plugin: winner }, 'Gun.json'), 'modbench.record',
      { viewColumn: -1, preview: true });
  });

  it('opens nothing when the picker is dismissed', async () => {
    pickRecord.mockResolvedValue(null);
    register();

    await open();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses, saying why, when it is given something that names no record', async () => {
    reporter.report.mockClear();
    register();

    await commandHandlers.get('modbench.record.open')?.({ kind: 'recordType' });

    expect(reporter.report).toHaveBeenCalledWith('error', 'Could not open a record.', 'What was given names no record.');
    expect(pickRecord).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a record VS Code could not open', async () => {
    reporter.report.mockClear();
    executeCommand.mockRejectedValueOnce(new Error('no editor'));
    register({ selection: () => [{ formKey: '000801:A.esp', kind: 'placed' }], ...renderingTheWinner() });

    await open();

    expect(reporter.report.mock.calls).toEqual([['error', 'Failed to open "000801:A.esp".', 'no editor']]);
  });

  it('does not ask when the selection holds a record', async () => {
    register({ selection: () => [{ formKey: '000801:A.esp', kind: 'placed' }] });

    await open();

    expect(pickRecord).not.toHaveBeenCalled();
  });
});

describe('modbench.record.open on a copy, a record and the plugin it is in', () => {
  const GUN = '000801:A.esp';
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const opened = () => executeCommand.mock.calls.filter(([id]) => id === 'vscode.openWith').map(([, uri, viewType]) => [uri, viewType]);

  function registerAnswering(file: { path: string | null } | null, holds = GUN, renderedName = 'Gun.json'): void {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordFile', file);
    meditClient.setQueryAnswer('getRenderedDocument', { fileName: renderedName, text: '{}' });
    meditClient.setQueryAnswer('getRecordOfFile', { formKey: holds, plugin: plugin.name, origin: plugin.origin });
    register({ meditClient });
  }

  it('opens a tracked copy\'s file in the record grid, as a preview', async () => {
    registerAnswering({ path: FILE });

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN, plugin });

    expect(executeCommand.mock.calls.map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toEqual([
      ['vscode.openWith', `file://${FILE}`, 'modbench.record', { viewColumn: -1, preview: true }],
    ]);
  });

  it('opens an untracked copy, which has no file, as the document mEdit renders it as, in the record grid', async () => {
    registerAnswering({ path: null });

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN, plugin });

    expect(opened()).toEqual([[renderedDocumentUri({ formKey: GUN, plugin }, 'Gun.json'), 'modbench.record']]);
  });

  it('opens an untracked plugin\'s header as the document mEdit renders it as', async () => {
    registerAnswering({ path: null }, '000000:A.esp', 'A.esp.json');

    await commandHandlers.get('modbench.record.open')?.({ header: plugin });

    expect(opened()).toEqual([[renderedDocumentUri({ formKey: '000000:A.esp', plugin }, 'A.esp.json'), 'modbench.record']]);
  });

  it('opens an untracked placed reference as its own rendered document, named by its own EditorID', async () => {
    const PLACED = '000803:A.esp';
    registerAnswering({ path: null }, PLACED, 'SharedRef - 000803_A.esp.json');

    await commandHandlers.get('modbench.record.open')?.({ kind: 'placed', formKey: PLACED, plugin: plugin.name, origin: plugin.origin });

    expect(opened()).toEqual([[renderedDocumentUri({ formKey: PLACED, plugin }, 'SharedRef - 000803_A.esp.json'), 'modbench.record']]);
  });

  it('opens a copy carried in another record\'s file, as a placed reference is in its cell\'s, in a tab of its own on that file', async () => {
    registerAnswering({ path: FILE }, '000700:A.esp');

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN, plugin });

    expect(opened()).toEqual([[`modbench-child-record:${FILE}?formKey=000801%3AA.esp&name=A.esp&origin=ModA`, 'modbench.record']]);
  });

  it('opens the winning copy\'s document for a record given without a plugin', async () => {
    const meditClient = new InMemoryMEditClient();
    const winner = { name: 'B.esp', origin: 'ModB' };
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getRecordFile', { path: null });
    meditClient.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN });

    expect(opened()).toEqual([[renderedDocumentUri({ formKey: GUN, plugin: winner }, 'Gun.json'), 'modbench.record']]);
  });

  it('refuses a record given without a plugin that no active plugin holds, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `No active plugin holds ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });

  it('refuses several records when no active plugin holds one given without a plugin, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', undefined);
    meditClient.setQueryAnswer('getRecordFile', { path: null });
    meditClient.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    register({ meditClient });

    await commandHandlers.get('modbench.record.open')?.([{ formKey: GUN, plugin }, { formKey: '000802:A.esp' }]);

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, 'No active plugin holds 000802:A.esp.']]);
    expect(opened()).toEqual([]);
  });

  it('refuses a copy the plugin does not hold, naming it, and opens nothing', async () => {
    reporter.report.mockClear();
    registerAnswering(null);

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN, plugin });

    expect(reporter.report.mock.calls).toEqual([['error', `Failed to open "${GUN}".`, `A.esp (ModA) holds no ${GUN}.`]]);
    expect(opened()).toEqual([]);
  });
});

describe('modbench.record.editField, fired with only the record, the plugin and the field path', () => {
  const MOVED = '000900:Mod.esp';

  it('moves every tab showing the record to its new FormKey, as an agent fires it with no panel', async () => {
    const tracker = new ActiveRecordTracker<vscode.WebviewPanel>();
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordFile', { path: '/mods/ModA/plugin-source/Mod.esp/Npcs/Npc.json' });
    meditClient.setQueryAnswer('getRecordOfFile', { formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' });
    meditClient.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], documents: [] });
    const [one, other, elsewhere] = [fakePanel(undefined, '000800:Mod.esp'), fakePanel(undefined, '000800:Mod.esp'), fakePanel()];
    tracker.setFormKey(one, '000800:Mod.esp');
    tracker.setFormKey(other, '000800:Mod.esp');
    tracker.setFormKey(elsewhere, '000801:Mod.esp');
    register({ recordPanels: new Set([one, other, elsewhere]), tracker, meditClient });

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });

    expect([tracker.formKeyOf(one), tracker.formKeyOf(other)]).toEqual([MOVED, MOVED]);
    expect(tracker.formKeyOf(elsewhere)).toBe('000801:Mod.esp');
    expect(meditClient.calls.filter(c => c.method === 'getEditChanges')).toHaveLength(1);
  });
});

describe('the record grid\'s F2', () => {
  it('opens the editor of the focused cell of the record tab in focus, and of no other tab', async () => {
    const [behind, inFocus] = [vi.fn(() => Promise.resolve(true)), vi.fn(() => Promise.resolve(true))];
    const tracker = new ActiveRecordTracker<vscode.WebviewPanel>();
    tracker.setActivePanel(fakePanel(behind));
    tracker.setActivePanel(fakePanel(inFocus));
    register({ tracker });

    await commandHandlers.get('modbench.recordGrid.editHere')?.();

    expect(inFocus).toHaveBeenCalledWith({ type: 'openCellEditor' });
    expect(behind).not.toHaveBeenCalled();
  });
});

describe('modbench.record.openToSide, the menus\' entry point', () => {
  it('fires open with the menu selection, each record placed beside', async () => {
    register();
    const [a, b] = [{ formKey: '000801:A.esp' }, { formKey: '000802:A.esp' }];

    await commandHandlers.get('modbench.record.openToSide')?.(a, [a, b]);

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', [
      { ...a, placement: 'beside' }, { ...b, placement: 'beside' },
    ]);
  });
});

describe('a record panel open while mEdit reports a plugin it cannot read', () => {
  const tick = (failures: { name: string; origin: string; reason: string }[]): NotificationEvent => ({
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: false, failures, version: 1,
    },
  });
  const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

  it('has the panels refreshed on a failure arriving and on it clearing, and not on an identical tick', () => {
    const meditClient = new InMemoryMEditClient();
    const postMessage = vi.fn(() => Promise.resolve(true));
    const panel = fakePanel(postMessage);
    const tracker = new ActiveRecordTracker<vscode.WebviewPanel>();
    tracker.setFormKey(panel, '000801:A.esp');
    register({ recordPanels: new Set([panel]), tracker, meditClient });

    meditClient.emit(tick([bad]));
    meditClient.emit(tick([bad]));
    meditClient.emit(tick([]));
    expect(postMessage.mock.calls).toEqual([
      [{ type: 'loadRecord', formKey: '000801:A.esp' }],
      [{ type: 'loadRecord', formKey: '000801:A.esp' }],
    ]);
  });
});

describe('a file\'s tab an edit moves the file of', () => {
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const NPC = '000800:A.esp';
  const FILE = '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json';
  const MOVED = '/mods/ModA/plugin-source/A.esp/Npcs/Renamed.json';
  const place = { collapsedRows: ['Bounds'], collapsedColumns: ['A.esp|ModA'], focusedCell: { rowKey: 'Bounds', plugin: null }, scroll: { top: 40, left: 12 } };

  function isDocument(candidate: unknown): candidate is vscode.TextDocument {
    return typeof candidate === 'object' && candidate !== null && 'uri' in candidate;
  }
  function isProvider(candidate: unknown): candidate is vscode.CustomTextEditorProvider {
    return typeof candidate === 'object' && candidate !== null && 'resolveCustomTextEditor' in candidate;
  }

  function webviewPanel() {
    const listeners: ((message: unknown) => void)[] = [];
    const panel = {
      title: '', active: true, viewColumn: 1,
      webview: {
        html: '', options: {}, cspSource: '', asWebviewUri: () => ({ toString: () => '' }),
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (listener: (message: unknown) => void) => { listeners.push(listener); return { dispose: () => undefined }; },
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeViewState: () => ({ dispose: () => undefined }),
    };
    if (!isPanel(panel)) throw new Error('not a panel');
    return { panel, tell: (message: unknown) => { for (const listener of listeners) listener(message); } };
  }

  async function shownOn(provider: vscode.CustomTextEditorProvider, path: string) {
    const tab = webviewPanel();
    const document = { uri: vscode.Uri.file(path), getText: () => '{}', isDirty: false };
    if (!isDocument(document)) throw new Error('not a document');
    await provider.resolveCustomTextEditor(document, tab.panel, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    return tab;
  }

  async function editMovingTheFile() {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOfFile', { formKey: NPC, plugin: plugin.name, origin: plugin.origin });
    meditClient.setQueryAnswer('getEditChanges', { applied: true, moves: [{ from: FILE, to: MOVED }], documents: [{ path: MOVED, text: '{}' }] });
    register({ meditClient });
    const provider = registerCustomEditorProvider.mock.calls.at(-1)?.[1];
    if (!isProvider(provider)) throw new Error('no record grid registered');
    const before = await shownOn(provider, FILE);
    before.tell({ type: 'viewState', state: place });

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: NPC, plugin: plugin.name, origin: plugin.origin }, { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' });

    return { provider, meditClient };
  }

  beforeEach(() => { applyEdit.mockReset(); applyEdit.mockResolvedValue(true); });

  it('shows, where the file lands, the rows and columns collapsed, the focused cell and the scroll it had', async () => {
    const { provider } = await editMovingTheFile();

    const after = await shownOn(provider, MOVED);

    expect(after.panel.webview.html).toContain(`window.mEditViewState = ${JSON.stringify(place)};`);
  });

  it('hands nothing to a tab opened later on the path a move VS Code did not make would have taken it to', async () => {
    applyEdit.mockResolvedValue(false);
    const { provider, meditClient } = await editMovingTheFile();

    const later = await shownOn(provider, MOVED);

    expect(later.panel.webview.html).not.toContain('mEditViewState');
    expect(meditClient.calls.filter(({ method, args }) => method === 'getRecordOfFile' && args[0] === MOVED)).toHaveLength(1);
  });
});
