import { vi } from 'vitest';
import {
  Range, EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon,
} from '../../test/vscodeMock';

/** The VS Code the Editor runs against, for a test's `vi.mock('vscode', () => editorVscode)`, and the state it keeps.
 *  This module loads nothing that imports `vscode`, so the hoisted mock can read it. */
export const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const contextKeys = new Map<string, unknown>();
export const editorProviders = new Map<string, unknown>();
export const editorProviderOptions = new Map<string, unknown>();
export const editorProviderDisposals = { count: 0 };
export const fileSystems = new Map<string, unknown>();
export const openedDocuments: unknown[] = [];
export const documentChanges = new Set<(event: { document: unknown; contentChanges: unknown[] }) => void>();
export const disk = new Map<string, string | Uint8Array>();
export const tabGroups: { viewColumn: number; tabs: unknown[] }[] = [];
export const applyEdit = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
export const showQuickPick = vi.fn<(items: readonly unknown[], options?: unknown) => Promise<unknown>>();
export const showInputBox = vi.fn<(options: { value?: string }) => Promise<string | undefined>>();
export const showTextDocument = vi.fn<(document: unknown, options?: unknown) => Promise<unknown>>(() => Promise.resolve(undefined));
export const clipboard = { readText: vi.fn<() => Promise<string>>(), writeText: vi.fn<(text: string) => Promise<void>>() };
export const contentProviders = new Map<string, unknown>();
export const textDocuments: { uri: unknown }[] = [];
export const documentCloses = new Set<(document: { uri: unknown }) => void>();

function quickPickClosedAtOnce() {
  const hidden: (() => void)[] = [];
  return {
    show: () => { hidden.forEach((listener) => { listener(); }); }, dispose: () => undefined,
    onDidChangeValue: () => undefined, onDidAccept: () => undefined, onDidHide: (listener: () => void) => { hidden.push(listener); },
  };
}

/** Each quick pick the Editor makes: by default one that closes as it is shown. */
export const createQuickPick = vi.fn<() => unknown>(quickPickClosedAtOnce);

interface UriParts { scheme: string; path: string; query?: string }

function uriOf(parts: UriParts): object {
  const { scheme, path, query = '' } = parts;
  const text = scheme === 'file' && !query ? `file://${path}` : `${scheme}:${path}?${query}`;
  return Object.defineProperties({ scheme, authority: '', path, fsPath: path, query, fragment: '' }, {
    toString: { value: () => text },
    toJSON: { value: () => parts },
    with: { value: (change: Partial<UriParts>) => uriOf({ ...parts, ...change }) },
  });
}

class FileSystemError extends Error {
  code = '';
  static FileNotFound = (what: { path: string } | string) => new FileSystemError(`FileNotFound ${typeof what === 'string' ? what : what.path}`);
  static NoPermissions = (uri: { path: string }) => new FileSystemError(`NoPermissions ${uri.path}`);
}

function dispatch(...[id, ...args]: unknown[]): Promise<unknown> {
  if (id === 'setContext') contextKeys.set(String(args[0]), args[1]);
  return Promise.resolve(commandHandlers.get(String(id))?.(...args));
}

export const executeCommand = vi.fn<(...args: unknown[]) => unknown>(dispatch);

export const executed = () => executeCommand.mock.calls.filter(([id]) => id !== 'setContext');

export const editorVscode = {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, Range, FileSystemError,
  FileType: { File: 1 },
  FileChangeType: { Changed: 1 },
  env: { clipboard: { readText: () => clipboard.readText(), writeText: (text: string) => clipboard.writeText(text) } },
  WorkspaceEdit: class { renameFile() { return undefined; } createFile() { return undefined; } replace() { return undefined; } },
  Disposable: class {
    constructor(public dispose: () => void) {}
    static from(...parts: { dispose(): void }[]) { return { dispose: () => parts.forEach((part) => part.dispose()) }; }
  },
  Uri: {
    from: uriOf,
    joinPath: (...parts: unknown[]) => parts.join('/'),
    file: (fsPath: string) => uriOf({ scheme: 'file', path: fsPath }),
  },
  ViewColumn: { Active: -1, One: 1, Beside: -2 },
  Position: class { constructor(public line: number, public character: number) {} },
  Location: class { constructor(public uri: unknown, public range: unknown) {} },
  TabInputCustom: class { constructor(readonly uri: unknown, readonly viewType: string) {} },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    executeCommand: (...args: unknown[]) => executeCommand(...args),
  },
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: unknown) => {
      fileSystems.set(scheme, provider);
      return { dispose: () => undefined };
    },
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      contentProviders.set(scheme, provider);
      return { dispose: () => contentProviders.delete(scheme) };
    },
    get textDocuments() { return textDocuments; },
    fs: {
      readFile: ({ fsPath, path }: { fsPath?: string; path?: string }) => {
        const held = disk.get(fsPath ?? path ?? '');
        if (held === undefined) return Promise.reject(Object.assign(new FileSystemError('no such file'), { code: 'FileNotFound' }));
        return Promise.resolve(typeof held === 'string' ? new TextEncoder().encode(held) : held);
      },
    },
    onDidCloseTextDocument: (listener: (document: { uri: unknown }) => void) => {
      documentCloses.add(listener);
      return { dispose: () => documentCloses.delete(listener) };
    },
    onDidOpenTextDocument: () => ({ dispose: () => undefined }),
    onDidSaveTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeTextDocument: (listener: (event: { document: unknown; contentChanges: unknown[] }) => void) => {
      documentChanges.add(listener);
      return { dispose: () => documentChanges.delete(listener) };
    },
    openTextDocument: (uri: unknown) => {
      openedDocuments.push(uri);
      return Promise.resolve({ uri, getText: () => '{}', isDirty: false });
    },
    applyEdit: () => applyEdit(),
  },
  window: {
    tabGroups: { get all() { return tabGroups; }, close: () => Promise.resolve(true) },
    withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
    showTextDocument: (document: unknown, options?: unknown) => showTextDocument(document, options),
    showInputBox: (options: { value?: string }) => showInputBox(options),
    showQuickPick: (items: readonly unknown[], options?: unknown) => showQuickPick(items, options),
    registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    createTreeView: () => ({ selection: [], onDidChangeSelection: () => ({ dispose: () => undefined }), dispose: () => undefined }),
    createQuickPick: () => createQuickPick(),
    registerCustomEditorProvider: (viewType: string, provider: unknown, options: unknown) => {
      editorProviders.set(viewType, provider);
      editorProviderOptions.set(viewType, options);
      return { dispose: () => { editorProviderDisposals.count++; } };
    },
  },
};

export interface FakePanel {
  title: string;
  active: boolean;
  viewColumn: number | undefined;
  webview: {
    postMessage: ReturnType<typeof vi.fn>; options?: unknown; html?: string; cspSource: string;
    asWebviewUri: (uri: unknown) => unknown; onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void };
  };
  onDidDispose: (listener: () => void) => { dispose(): void };
  onDidChangeViewState: (listener: () => void) => { dispose(): void };
  focus(): void;
  close(): void;
  receive(message: unknown): void;
}

export function fakePanel({ title = '', active = true, viewColumn = 2 } = {}): FakePanel {
  const disposed: (() => void)[] = [];
  const viewState: (() => void)[] = [];
  const received: ((message: unknown) => void)[] = [];
  return {
    title, active, viewColumn,
    webview: {
      html: '', options: {}, postMessage: vi.fn(() => Promise.resolve(true)), cspSource: 'csp', asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (listener) => { received.push(listener); return { dispose: () => undefined }; },
    },
    onDidDispose: (listener) => { disposed.push(listener); return { dispose: () => undefined }; },
    onDidChangeViewState: (listener) => { viewState.push(listener); return { dispose: () => undefined }; },
    focus: () => { viewState.forEach((listener) => { listener(); }); },
    close: () => { disposed.forEach((listener) => { listener(); }); },
    receive: (message) => { received.forEach((listener) => { listener(message); }); },
  };
}

export function forgetVscode(): void {
  commandHandlers.clear();
  contextKeys.clear();
  fileSystems.clear();
  openedDocuments.length = 0;
  disk.clear();
  tabGroups.length = 0;
  executeCommand.mockReset();
  executeCommand.mockImplementation(dispatch);
  applyEdit.mockReset();
  applyEdit.mockResolvedValue(true);
  showQuickPick.mockReset();
  showInputBox.mockReset();
  showTextDocument.mockReset();
  showTextDocument.mockResolvedValue(undefined);
  clipboard.readText.mockReset();
  clipboard.writeText.mockReset();
  contentProviders.clear();
  textDocuments.length = 0;
  documentCloses.clear();
  createQuickPick.mockReset();
  createQuickPick.mockImplementation(quickPickClosedAtOnce);
}
