import { vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState } from '../../test/vscodeMock';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

export const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
export const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
export const pickRecord = vi.fn<(...args: unknown[]) => Promise<string | null>>();
export const applyEdit = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
export const tabGroups: { viewColumn: number; tabs: unknown[] }[] = [];

/** The `vscode` the Editor's commands and record grid call, for a test's `vi.mock('vscode', ...)`.
 *  This module loads nothing that imports `vscode`, so the hoisted mock can read it. */
export const recordGridVscode = {
  TreeItem, TreeItemCollapsibleState, Range,
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
};

export const reporter = { report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() };

export const executed = () => executeCommand.mock.calls.filter(([id]) => id !== 'setContext');

export function forgetRegistrations(): void {
  commandHandlers.clear();
  executeCommand.mockReset();
  pickRecord.mockReset();
}

interface Registered {
  selection?: () => readonly unknown[];
  meditClient?: InMemoryMEditClient;
  outputChannel?: { debug: () => void; info: () => void; warn: (message: string) => void };
}

/** Creates the Editor with the view `test.view` selecting `selection`. */
export async function register({
  selection = () => [], meditClient, outputChannel = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}: Registered = {}): Promise<void> {
  const vscode = await import('vscode');
  const { createEditor } = await import('..');
  const { createFocusedView } = await import('../../drivingLib/focusedView');
  const { InMemoryMEditClient } = await import('../../client/test/InMemoryMEditClient');
  const focusedView = createFocusedView();
  createEditor({
    context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
    meditClient: meditClient ?? new InMemoryMEditClient(),
    outputChannel,
    reporterFor: () => reporter,
    ask: vi.fn(),
    focusedView,
    recordViewIds: ['test.view'],
    modFacts: { trackedMods: () => new Set(), modDirs: () => new Map(), standingOf: () => ({ kind: 'enabled' }), onChange: () => ({ dispose: () => undefined }) },
    recordWrite: (command) => command(),
    refreshSourceControlFor: () => undefined,
  });
  focusedView.follow('test.view', {
    get selection() { return selection(); },
    onDidChangeSelection: (listener: (event: { selection: readonly unknown[] }) => void) => { listener({ selection: selection() }); return { dispose: () => undefined }; },
  });
}
