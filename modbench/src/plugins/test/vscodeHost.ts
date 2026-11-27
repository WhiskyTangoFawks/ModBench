// The VS Code the Plugins box registers with: a test file mocks `vscode` with this module, and reads through `host`
// what the box registered and what it shows.

import type * as vscode from 'vscode';
import {
  DataTransfer, DataTransferItem, Diagnostic, DiagnosticSeverity, EventEmitter, FakeDiagnosticCollection, MarkdownString, Range, ThemeColor, ThemeIcon,
  TreeItem, TreeItemCheckboxState, TreeItemCollapsibleState, Uri as BaseUri, uriParse,
} from '../../test/vscodeMock';
import { FakeInputBox, FakeTreeViews } from '../../drivingLib/test/nameFilterViewHarness';

export {
  DataTransfer, DataTransferItem, Diagnostic, DiagnosticSeverity, EventEmitter, MarkdownString, Range, ThemeColor, ThemeIcon, TreeItem, TreeItemCheckboxState,
  TreeItemCollapsibleState,
};

type Handler = (...args: unknown[]) => unknown;
type Decorations = { provideFileDecoration: (uri: unknown) => vscode.ProviderResult<vscode.FileDecoration> };
type Lenses = { provideCodeLenses: (document: { uri: unknown; getText: () => string }) => vscode.CodeLens[] };
type Actions = { provideCodeActions: (document: { uri: unknown }, range: Range, context: { diagnostics: readonly unknown[] }) => vscode.ProviderResult<CodeAction[]> };

export class Disposable {
  constructor(readonly dispose: () => void) {}
  static from(...all: { dispose: () => unknown }[]): Disposable { return new Disposable(() => { for (const each of all) each.dispose(); }); }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class CodeLens {
  constructor(readonly range: unknown, readonly command: vscode.Command) {}
}

export class CodeAction {
  command?: vscode.Command;
  diagnostics?: unknown[];
  constructor(readonly title: string, readonly kind: string) {}
}

export const CodeActionKind = { QuickFix: 'quickfix' };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const Uri = { ...BaseUri, parse: uriParse };

interface StatusBarItem { text: string; tooltip?: string; command?: string; shown: boolean; disposed: boolean; show: () => void; hide: () => void; dispose: () => void }

const treeViews = new FakeTreeViews();
const commandHandlers = new Map<string, Handler>();
const decorations: Decorations[] = [];
const lenses: Lenses[] = [];
const actions: Actions[] = [];
const statusBarItems: StatusBarItem[] = [];
const quickPicks: { items: string[]; placeHolder: string | undefined; canPickMany: boolean }[] = [];
const files = new Map<string, string>();
const progress: string[] = [];
const checkboxListeners: ((event: { items: readonly [unknown, number][] }) => unknown)[] = [];
let pick: (labels: readonly string[]) => string | readonly string[] | undefined = () => undefined;

const workspacePath = (path: string) => path.replace(/^\/workspace\//, '');
const labelOf = (item: string | vscode.QuickPickItem) => (typeof item === 'string' ? item : item.label);

export const commands = {
  registerCommand: (id: string, handler: Handler) => { commandHandlers.set(id, handler); return new Disposable(() => { commandHandlers.delete(id); }); },
  executeCommand: () => Promise.resolve(),
};

export const window = {
  createTreeView: (id: string, options: vscode.TreeViewOptions<unknown>) => {
    const onDidChangeCheckboxState = (listener: (event: { items: readonly [unknown, number][] }) => unknown) => {
      checkboxListeners.push(listener);
      return new Disposable(() => undefined);
    };
    return Object.assign(treeViews.create(id, options), { onDidChangeCheckboxState });
  },
  registerFileDecorationProvider: (provider: Decorations) => { decorations.push(provider); return new Disposable(() => undefined); },
  createStatusBarItem: () => {
    const item: StatusBarItem = {
      text: '', shown: false, disposed: false, show: () => { item.shown = true; }, hide: () => { item.shown = false; }, dispose: () => { item.disposed = true; },
    };
    statusBarItems.push(item);
    return item;
  },
  withProgress: async (options: { location: { viewId: string } | number }, task: () => Promise<unknown>) => {
    progress.push(`opens on ${typeof options.location === 'number' ? options.location : options.location.viewId}`);
    try { return await task(); } finally { progress.push('closes'); }
  },
  showQuickPick: async <T extends string | vscode.QuickPickItem>(items: readonly T[] | Promise<readonly T[]>, options?: { placeHolder?: string; canPickMany?: boolean }) => {
    const offered = await items;
    const labels = offered.map(labelOf);
    quickPicks.push({ items: labels, placeHolder: options?.placeHolder, canPickMany: options?.canPickMany === true });
    const picked = pick(labels);
    if (options?.canPickMany === true) return picked && offered.filter((item) => [picked].flat().includes(labelOf(item)));
    return offered.find((item) => labelOf(item) === picked);
  },
  showInputBox: () => Promise.resolve(undefined),
  showTextDocument: () => Promise.resolve(),
  createInputBox: () => new FakeInputBox(),
  setStatusBarMessage: () => new Disposable(() => undefined),
};

export const workspace = {
  findFiles: (glob: string) => Promise.resolve([...files.keys()].filter((name) => glob !== '**/*.sql' || name.endsWith('.sql')).map((name) => Uri.file(`/workspace/${name}`))),
  openTextDocument: (target: { path: string } | { language: string }): Promise<{ uri: unknown; getText: () => string }> => Promise.resolve('language' in target
    ? { uri: uriParse('untitled:Untitled-1'), getText: () => '' }
    : { uri: target, getText: () => files.get(workspacePath(target.path)) ?? '' }),
  asRelativePath: (uri: { path: string }) => workspacePath(uri.path),
};

export const languages = {
  createDiagnosticCollection: () => new FakeDiagnosticCollection(),
  registerCodeLensProvider: (_selector: unknown, provider: Lenses) => { lenses.push(provider); return new Disposable(() => undefined); },
  registerCodeActionsProvider: (_selector: unknown, provider: Actions) => { actions.push(provider); return new Disposable(() => undefined); },
};

/** What the box registered with VS Code and what it shows, and the user's acts on them. */
export const host = {
  /** Runs the command as VS Code does for a menu or a key. */
  run: (id: string, ...args: unknown[]): Promise<unknown> => {
    const handler = commandHandlers.get(id);
    if (handler === undefined) throw new Error(`no command ${id} is registered`);
    return Promise.resolve(handler(...args));
  },
  treeView: (id?: string) => treeViews.view(id),
  /** What each decoration provider draws on the row at `uri`, in registration order. */
  decorate: (uri: unknown) => Promise.all(decorations.map((provider) => Promise.resolve(provider.provideFileDecoration(uri)))),
  /** The code lenses on a document of `text` at `path`. */
  lenses: (text: string, path = '/scripts/filter.sql') => lenses.flatMap((provider) => provider.provideCodeLenses({ uri: Uri.file(path), getText: () => text })),
  /** The code actions offered on `line` of the file at `path`. */
  codeActions: async (path: string, line: number) => {
    const at = new Range(line, 0, line, 0);
    return (await Promise.all(actions.map((provider) => Promise.resolve(provider.provideCodeActions({ uri: Uri.file(path) }, at, { diagnostics: [] }))))).flatMap((each) => each ?? []);
  },
  statusBarItems,
  /** Each quick pick shown, its labels and placeholder. */
  quickPicks,
  /** Picks the items whose labels `answer` returns. */
  picks: (answer: (labels: readonly string[]) => string | readonly string[] | undefined) => { pick = answer; },
  /** The workspace's files, by path from its root. */
  files,
  /** The user clicks the check boxes of `items`, each to its state; settles once every listener has. */
  check: (items: readonly [unknown, number][]) => Promise.all(checkboxListeners.map((listener) => listener({ items }))),
  /** Each progress opened and closed, in turn. */
  progress,
  /** Forgets everything registered and held, as a fresh window. */
  reset: () => {
    treeViews.clear();
    for (const held of [commandHandlers, files]) held.clear();
    for (const held of [decorations, lenses, actions, statusBarItems, quickPicks, progress, checkboxListeners]) held.length = 0;
    pick = () => undefined;
  },
};
