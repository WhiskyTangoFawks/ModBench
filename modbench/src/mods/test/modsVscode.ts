import type * as vscode from 'vscode';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, DataTransferItem, DataTransfer,
  Diagnostic, DiagnosticSeverity, Range, FakeDiagnosticCollection, Uri, uriParse,
} from '../../test/vscodeMock';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';
import { FakeTreeView, filterBoxCommandsMock, filterBoxWindowMock, type FakeInputBox } from '../../drivingLib/test/nameFilterViewHarness';
import { recordedWithProgress } from '../../test/recordedProgress';
import { taskModule } from '../../test/taskDouble';

type Handler = (...args: unknown[]) => unknown;
type Listener<E> = (event: E) => void;
const noDisposable = () => ({ dispose: () => undefined });

/** The Mods tree as VS Code holds it: what `FakeTreeView` holds, and the checkbox a user clicks. */
export class ModsTreeView extends FakeTreeView {
  private readonly checkboxListeners: Listener<vscode.TreeCheckboxChangeEvent<unknown>>[] = [];

  badge: vscode.ViewBadge | undefined;

  override onDidChangeCheckboxState = (listener: Listener<vscode.TreeCheckboxChangeEvent<unknown>> = () => undefined) => {
    this.checkboxListeners.push(listener);
    return noDisposable();
  };

  /** A click on each row's checkbox, setting it to `state`, as VS Code fires it. */
  check(items: readonly [unknown, vscode.TreeItemCheckboxState][]): void {
    this.checkboxListeners.forEach((listener) => { listener({ items }); });
  }
}

/** A webview panel: what the page was sent, and a message the page sends back. */
export class FakeWebviewPanel {
  title: string;
  disposed = false;
  readonly posted: unknown[] = [];
  private readonly heard: { message: Listener<unknown>[]; dispose: (() => void)[] } = { message: [], dispose: [] };
  readonly webview = {
    html: '', options: {}, cspSource: 'csp:',
    asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `webview:${uri.toString()}` }),
    postMessage: (message: unknown) => { this.posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (listener: Listener<unknown>) => { this.heard.message.push(listener); return noDisposable(); },
  };

  constructor(title = '') { this.title = title; }

  onDidDispose(listener: () => void) { this.heard.dispose.push(listener); return noDisposable(); }
  reveal(): void { /* already shown */ }
  dispose(): void { this.disposed = true; this.heard.dispose.forEach((listener) => { listener(); }); }
  receive(message: unknown): void { this.heard.message.forEach((listener) => { listener(message); }); }
}

class Disposable {
  constructor(readonly dispose: () => void) {}
  static from(...all: { dispose(): unknown }[]): Disposable { return new Disposable(() => { for (const one of all) one.dispose(); }); }
}

interface CustomEditor { openCustomDocument(uri: unknown): unknown; resolveCustomEditor(document: unknown, panel: FakeWebviewPanel): unknown }

const NOTIFICATION = 15;

/** What the Mods view showed and registered through VS Code in this test; `modsViewOn` empties it. */
export const seen = {
  commands: new Map<string, Handler>(),
  contextKeys: new Map<string, unknown>(),
  /** Each `executeCommand` but `setContext`, with its arguments. */
  executed: [] as unknown[][],
  boxes: [] as FakeInputBox[],
  views: new Map<string, ModsTreeView>(),
  decorationProviders: [] as vscode.FileDecorationProvider[],
  diagnostics: new Map<string, FakeDiagnosticCollection>(),
  customEditors: new Map<string, CustomEditor>(),
  /** Each panel a custom editor or `createWebviewPanel` opened, in order. */
  panels: [] as FakeWebviewPanel[],
  fileSystems: new Map<string, unknown>(),
  taskProviders: new Map<string, vscode.TaskProvider>(),
  /** The labels and options of each `showQuickPick`. */
  quickPicks: [] as { labels: string[]; options: unknown }[],
  createdQuickPicks: [] as ReturnType<typeof quickPickChoosing>[],
  inputBoxes: [] as vscode.InputBoxOptions[],
  /** What a notification's progress said, and whether it offered to cancel. */
  notifications: [] as { cancellable: boolean; messages: string[] }[],
  statusBar: [] as string[],
  openedExternally: [] as string[],
  workspaceFolders: undefined as { uri: vscode.Uri; name: string }[] | undefined,
};

/** What VS Code answers in this test; each defaults to the user pressing Esc. `modsViewOn` resets it. */
export const answers = {
  quickPick: (_items: readonly vscode.QuickPickItem[]): vscode.QuickPickItem | readonly vscode.QuickPickItem[] | undefined => undefined,
  createdQuickPick: (_items: readonly vscode.QuickPickItem[]): vscode.QuickPickItem | undefined => undefined,
  inputBox: (_options: vscode.InputBoxOptions): string | undefined => undefined,
  openDialog: (_options: vscode.OpenDialogOptions): vscode.Uri[] | undefined => undefined,
  settings: new Map<string, unknown>(),
};

const settingListeners: Listener<{ affectsConfiguration(section: string): boolean }>[] = [];
const cancels: (() => void)[] = [];

/** The user changes a setting, as VS Code tells its listeners. */
export function changeSetting(key: string, value: unknown): void {
  answers.settings.set(key, value);
  settingListeners.forEach((listener) => { listener({ affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`) }); });
}

/** The user cancels the notification last shown. */
export const cancelNotification = (): void => { cancels.at(-1)?.(); };

export function forgetSeen(): void {
  for (const held of Object.values(seen)) {
    if (held instanceof Map) held.clear();
    else if (Array.isArray(held)) held.length = 0;
  }
  seen.workspaceFolders = undefined;
  answers.quickPick = () => undefined;
  answers.createdQuickPick = () => undefined;
  answers.inputBox = () => undefined;
  answers.openDialog = () => undefined;
  answers.settings.clear();
  settingListeners.length = 0;
  cancels.length = 0;
}

function openPanel(title: string): FakeWebviewPanel {
  const panel = new FakeWebviewPanel(title);
  seen.panels.push(panel);
  return panel;
}

// VS Code runs a registered command for `executeCommand`, and opens a custom editor for `vscode.openWith`.
function executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
  if (command === 'setContext' && typeof args[0] === 'string') {
    seen.contextKeys.set(args[0], args[1]);
    return Promise.resolve();
  }
  seen.executed.push([command, ...args]);
  const editor = command === 'vscode.openWith' && typeof args[1] === 'string' ? seen.customEditors.get(args[1]) : undefined;
  if (editor) return Promise.resolve(editor.resolveCustomEditor(editor.openCustomDocument(args[0]), openPanel('')));
  const handler = seen.commands.get(command);
  return Promise.resolve(handler?.(...args));
}

function withProgress(
  options: { location: { viewId: string } | number; cancellable?: boolean },
  task: (progress: { report(value: { message?: string }): void }, token: vscode.CancellationToken) => Promise<unknown>,
): Promise<unknown> {
  const { location } = options;
  const listeners: Listener<unknown>[] = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: Listener<unknown>) => { listeners.push(listener); return noDisposable(); },
  };
  if (typeof location !== 'number') return recordedWithProgress({ location }, () => task({ report: () => undefined }, token));
  const shown = { cancellable: options.cancellable === true, messages: [] as string[] };
  seen.notifications.push(shown);
  cancels.push(() => { token.isCancellationRequested = true; listeners.forEach((listener) => { listener(undefined); }); });
  return task({ report: ({ message }) => { if (message !== undefined) shown.messages.push(message); } }, token);
}

const { Task, CustomExecution, TaskScope } = taskModule();

/** The `vscode` module the Mods view runs against: `vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule)`. */
export const vscodeModule = {
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { ...Uri, parse: uriParse },
  DataTransferItem, DataTransfer, Diagnostic, DiagnosticSeverity, Range, Disposable, Task, CustomExecution, TaskScope,
  ProgressLocation: { Notification: NOTIFICATION },
  ViewColumn: { Active: -1 },
  FileType: { File: 1, Directory: 2 },
  FileSystemError: {
    NoPermissions: (what: { path: string }) => new Error(`NoPermissions ${what.path}`),
    FileNotFound: (what: { path: string }) => new Error(`FileNotFound ${what.path}`),
    Unavailable: (what: string) => new Error(`Unavailable ${what}`),
  },
  tasks: {
    registerTaskProvider: (type: string, provider: vscode.TaskProvider) => { seen.taskProviders.set(type, provider); return noDisposable(); },
  },
  languages: {
    createDiagnosticCollection: (name: string) => {
      const collection = new FakeDiagnosticCollection();
      seen.diagnostics.set(name, collection);
      return collection;
    },
  },
  env: { openExternal: (uri: { toString(): string }) => { seen.openedExternally.push(uri.toString()); return Promise.resolve(true); } },
  workspace: {
    ...fakeVscodeModule().workspace,
    getConfiguration: () => ({ get: (key: string) => answers.settings.get(key) }),
    onDidChangeConfiguration: (listener: Listener<{ affectsConfiguration(section: string): boolean }>) => { settingListeners.push(listener); return noDisposable(); },
    registerFileSystemProvider: (scheme: string, provider: unknown) => { seen.fileSystems.set(scheme, provider); return noDisposable(); },
    get workspaceFolders() { return seen.workspaceFolders; },
    updateWorkspaceFolders: (start: number, deleteCount: number, ...added: { uri: vscode.Uri; name: string }[]) => {
      const folders = [...(seen.workspaceFolders ?? [])];
      folders.splice(start, deleteCount, ...added);
      seen.workspaceFolders = folders;
      return true;
    },
    onDidChangeWorkspaceFolders: noDisposable,
  },
  window: {
    ...filterBoxWindowMock(seen),
    createTreeView: (id: string, { treeDataProvider, ...options }: vscode.TreeViewOptions<unknown>) => {
      const view = new ModsTreeView(treeDataProvider, options);
      seen.views.set(id, view);
      return view;
    },
    showQuickPick: (items: readonly vscode.QuickPickItem[], options?: unknown) => {
      seen.quickPicks.push({ labels: items.map(({ label }) => label), options });
      return Promise.resolve(answers.quickPick(items));
    },
    createQuickPick: () => {
      const pick = quickPickChoosing((items) => answers.createdQuickPick(items));
      seen.createdQuickPicks.push(pick);
      return pick;
    },
    showInputBox: (options: vscode.InputBoxOptions) => { seen.inputBoxes.push(options); return Promise.resolve(answers.inputBox(options)); },
    showOpenDialog: (options: vscode.OpenDialogOptions) => Promise.resolve(answers.openDialog(options)),
    setStatusBarMessage: (message: string) => { seen.statusBar.push(message); return noDisposable(); },
    withProgress,
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => { seen.decorationProviders.push(provider); return noDisposable(); },
    registerCustomEditorProvider: (viewType: string, provider: CustomEditor) => { seen.customEditors.set(viewType, provider); return noDisposable(); },
    createWebviewPanel: (_viewType: string, title: string) => openPanel(title),
  },
  commands: {
    ...filterBoxCommandsMock(seen),
    executeCommand,
  },
};
