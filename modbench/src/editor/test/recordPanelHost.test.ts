import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
const pickRecord = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const applyEdit = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
const tabGroups: { viewColumn: number; tabs: unknown[] }[] = [];

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
  Disposable: class {
    constructor(public dispose: () => void) {}
    static from(...parts: { dispose(): void }[]) { return { dispose: () => parts.forEach((part) => part.dispose()) }; }
  },
  ViewColumn: { Active: -1, One: 1, Beside: -2 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: (...args: unknown[]) => executeCommand(...args),
  },
  workspace: {
    registerFileSystemProvider: () => ({ dispose: () => undefined }),
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: () => ({ dispose: () => undefined }),
    textDocuments: [],
    openTextDocument: (uri: unknown) => Promise.resolve({ uri, getText: () => '{}', isDirty: false }),
    applyEdit: () => applyEdit(),
  },
  TabInputCustom: class { constructor(readonly uri: unknown, readonly viewType: string) {} },
  window: {
    tabGroups: { get all() { return tabGroups; }, close: () => Promise.resolve(true) },
    registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    createTreeView: () => ({ selection: [], onDidChangeSelection: () => ({ dispose: () => undefined }), dispose: () => undefined }),
    registerCustomEditorProvider: (...args: unknown[]) => registerCustomEditorProvider(...args),
  },
}));

import * as vscode from 'vscode';
import { createEditor } from '..';
import { createFocusedView } from '../../drivingLib/focusedView';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const reporter = { report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() };

function isPanel(candidate: unknown): candidate is vscode.WebviewPanel {
  return typeof candidate === 'object' && candidate !== null && 'webview' in candidate;
}

interface Registered {
  selection?: () => readonly unknown[];
  meditClient?: InMemoryMEditClient;
  outputChannel?: { debug: () => void; info: () => void; warn: (message: string) => void };
}

function register({
  selection = () => [], meditClient = new InMemoryMEditClient(), outputChannel = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}: Registered = {}): void {
  const focusedView = createFocusedView();
  createEditor({
    context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
    meditClient,
    outputChannel,
    reporterFor: () => reporter,
    ask: vi.fn(),
    focusedView,
    recordViewIds: ['test.view'],
    modFacts: { trackedMods: () => new Set(), modDirs: () => new Map(), onChange: () => ({ dispose: () => undefined }) },
    recordWrite: (command) => command(),
    refreshSourceControlFor: () => undefined,
  });
  focusedView.follow('test.view', {
    get selection() { return selection(); },
    onDidChangeSelection: (listener: (event: { selection: readonly unknown[] }) => void) => { listener({ selection: selection() }); return { dispose: () => undefined }; },
  });
}

const executed = () => executeCommand.mock.calls.filter(([id]) => id !== 'setContext');

beforeEach(() => {
  commandHandlers.clear();
  executeCommand.mockReset();
  pickRecord.mockReset();
});

describe('modbench.record.open from the palette, with no Argument', () => {
  const open = () => commandHandlers.get('modbench.record.open')?.();
  const winner = { name: 'A.esp', origin: 'ModA' };
  const rowOf = (formKey: string) => ({ argument: { kind: 'record', plugin: winner, formKey } });
  const renderingTheWinner = (): { meditClient: InMemoryMEditClient } => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOwner', winner);
    meditClient.setQueryAnswer('getRecordFile', { path: null });
    meditClient.setQueryAnswer('getRenderedDocument', { fileName: 'Gun.json', text: '{}' });
    return { meditClient };
  };

  it('opens the records selected in the focused view as one grid, pinned, on the first record\'s document', async () => {
    register({ selection: () => [rowOf('000801:A.esp'), rowOf('000802:A.esp')], ...renderingTheWinner() });

    await open();

    expect(executed().filter(([id]) => id === 'vscode.openWith')).toEqual([[
      'vscode.openWith', '/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: false },
    ]]);
  });

  it('asks for a record when the focused view has none selected, and opens the one picked as a preview', async () => {
    pickRecord.mockResolvedValue('000801:A.esp');
    register({ selection: () => [{ kind: 'recordType' }], ...renderingTheWinner() });

    await open();

    expect(pickRecord.mock.calls).toEqual([[{ meditClient: expect.any(InMemoryMEditClient) as unknown, reporter }, '', []]]);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith', '/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record',
      { viewColumn: -1, preview: true });
  });

  it('opens nothing when the picker is dismissed', async () => {
    pickRecord.mockResolvedValue(null);
    register();

    await open();

    expect(executed()).toEqual([]);
  });

  it('refuses, saying why, when it is given something that names no record', async () => {
    reporter.report.mockClear();
    register();

    await commandHandlers.get('modbench.record.open')?.({ kind: 'recordType' });

    expect(reporter.report).toHaveBeenCalledWith('error', 'Could not open a record.', 'What was given names no record.');
    expect(pickRecord).not.toHaveBeenCalled();
    expect(executed()).toEqual([]);
  });

  it('reports a record VS Code could not open', async () => {
    reporter.report.mockClear();
    register({ selection: () => [rowOf('000801:A.esp')], ...renderingTheWinner() });
    executeCommand.mockRejectedValueOnce(new Error('no editor'));

    await open();

    expect(reporter.report.mock.calls).toEqual([['error', 'Failed to open "000801:A.esp".', 'no editor']]);
  });

  it('does not ask when the selection holds a record', async () => {
    register({ selection: () => [rowOf('000801:A.esp')] });

    await open();

    expect(pickRecord).not.toHaveBeenCalled();
  });
});

describe('modbench.record.open on a copy, a record and the plugin it is in', () => {
  const GUN = '000801:A.esp';
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri, viewType]) => [uri, viewType]);

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

    expect(executed().map(([id, uri, ...rest]) => [id, String(uri), ...rest])).toEqual([
      ['vscode.openWith', `file://${FILE}`, 'modbench.record', { viewColumn: -1, preview: true }],
    ]);
  });

  it('opens an untracked copy, which has no file, as the document mEdit renders it as, in the record grid', async () => {
    registerAnswering({ path: null });

    await commandHandlers.get('modbench.record.open')?.({ formKey: GUN, plugin });

    expect(opened()).toEqual([['/ModA/A.esp/Gun.json?formKey=000801%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
  });

  it('opens an untracked plugin\'s header as the document mEdit renders it as', async () => {
    registerAnswering({ path: null }, '000000:A.esp', 'A.esp.json');

    await commandHandlers.get('modbench.record.open')?.({ header: plugin });

    expect(opened()).toEqual([['/ModA/A.esp/A.esp.json?formKey=000000%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
  });

  it('opens an untracked placed reference as its own rendered document, named by its own EditorID', async () => {
    const PLACED = '000803:A.esp';
    registerAnswering({ path: null }, PLACED, 'SharedRef - 000803_A.esp.json');

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', plugin, formKey: PLACED } });

    expect(opened()).toEqual([['/ModA/A.esp/SharedRef - 000803_A.esp.json?formKey=000803%3AA.esp&name=A.esp&origin=ModA', 'modbench.record']]);
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

    expect(opened()).toEqual([['/ModB/B.esp/Gun.json?formKey=000801%3AA.esp&name=B.esp&origin=ModB', 'modbench.record']]);
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

  it.each([
    ['refuses', () => Promise.resolve(false)],
    ['fails', () => Promise.reject(new Error('the file system said no'))],
  ])('hands nothing to a tab opened later on the path a move would have taken it to, when VS Code %s the edit', async (_, answer) => {
    applyEdit.mockImplementation(answer);
    const { provider, meditClient } = await editMovingTheFile();

    const later = await shownOn(provider, MOVED);

    expect(later.panel.webview.html).not.toContain('mEditViewState');
    expect(meditClient.calls.filter(({ method, args }) => method === 'getRecordOfFile' && args[0] === MOVED)).toHaveLength(1);
  });

});

describe('a child record\'s tab, on mEdit\'s report of its record', () => {
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const PLACED = '000801:A.esp';
  const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
  const OTHER_CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Other.json';
  const query = `formKey=${encodeURIComponent(PLACED)}&name=${plugin.name}&origin=${plugin.origin}`;
  const childUri = { scheme: 'modbench-child-record', path: CELL_FILE, query, toString: () => `modbench-child-record:${CELL_FILE}?${query}` };
  const changed = { kind: 'rows-changed' as const, plugin: plugin.name, origin: plugin.origin, keys: [PLACED], sequence: 1 };
  const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri]) => uri);

  function isDocument(candidate: unknown): candidate is vscode.TextDocument {
    return typeof candidate === 'object' && candidate !== null && 'uri' in candidate;
  }
  function isProvider(candidate: unknown): candidate is vscode.CustomTextEditorProvider {
    return typeof candidate === 'object' && candidate !== null && 'resolveCustomTextEditor' in candidate;
  }
  function isUri(candidate: unknown): candidate is vscode.Uri {
    return typeof candidate === 'object' && candidate !== null && 'scheme' in candidate;
  }

  async function childTabShown(meditClient: InMemoryMEditClient, inAGroup = true) {
    meditClient.setQueryAnswer('getRecordOfFile', { formKey: '000700:A.esp', plugin: plugin.name, origin: plugin.origin });
    const warn = vi.fn();
    register({ meditClient, outputChannel: { debug: vi.fn(), info: vi.fn(), warn } });
    const provider = registerCustomEditorProvider.mock.calls.at(-1)?.[1];
    if (!isProvider(provider)) throw new Error('no record grid registered');
    const document = { uri: childUri, getText: () => '{}', isDirty: false };
    const panel = {
      title: '', active: true, viewColumn: 1,
      webview: {
        html: '', options: {}, cspSource: '', asWebviewUri: () => ({ toString: () => '' }), postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeViewState: () => ({ dispose: () => undefined }),
    };
    if (!isDocument(document) || !isPanel(panel) || !isUri(childUri)) throw new Error('not a child record\'s tab');
    await provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    const group = { viewColumn: 1, tabs: [] as unknown[] };
    group.tabs.push({ group, input: new vscode.TabInputCustom(childUri, 'modbench.record'), isActive: true, isPreview: false });
    tabGroups.splice(0, tabGroups.length, ...(inAGroup ? [group] : []));
    return { warn };
  }

  it('follows it again for a report that arrives while it follows the one before', async () => {
    const meditClient = new InMemoryMEditClient();
    let answerFirst: (file: { path: string }) => void = () => undefined;
    meditClient.setQueryAnswerOnce('getRecordFile', new Promise<{ path: string }>((resolve) => { answerFirst = resolve; }));
    meditClient.setQueryAnswer('getRecordFile', { path: OTHER_CELL_FILE });
    await childTabShown(meditClient);

    meditClient.emit(changed);
    meditClient.emit({ ...changed, sequence: 2 });
    answerFirst({ path: CELL_FILE });

    await vi.waitFor(() => expect(opened()).toEqual([`modbench-child-record:${OTHER_CELL_FILE}?${query}`]));
    expect(meditClient.calls.filter(({ method }) => method === 'getRecordFile')).toHaveLength(2);
  });

  it('stays, saying why in the Output, when mEdit names no document carrying its record', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordFile', null);
    const { warn } = await childTabShown(meditClient);

    meditClient.emit(changed);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      `${PLACED}'s tab stays on modbench-child-record:${CELL_FILE}?${query}: A.esp (ModA) holds no ${PLACED}.`));
    expect(opened()).toEqual([]);
  });

  it('stays, saying why in the Output, when VS Code shows it in no group', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordFile', { path: OTHER_CELL_FILE });
    const { warn } = await childTabShown(meditClient, false);

    meditClient.emit(changed);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      `${PLACED}'s tab stays on modbench-child-record:${CELL_FILE}?${query}: VS Code shows the tab in no group.`));
    expect(opened()).toEqual([]);
  });
});
