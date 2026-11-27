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
type Lenses = { provideCodeLenses: (document: { getText: () => string }) => vscode.CodeLens[] };
type Actions = { provideCodeActions: (document: { uri: unknown }, range: unknown, context: { diagnostics: readonly unknown[] }) => vscode.ProviderResult<CodeAction[]> };

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
const executed: unknown[][] = [];
const contexts = new Map<string, unknown>();
const collections = new Map<string, FakeDiagnosticCollection>();
const decorations: Decorations[] = [];
const lenses: Lenses[] = [];
const actions: Actions[] = [];
const statusBarItems: StatusBarItem[] = [];
const inputBoxes: FakeInputBox[] = [];
const quickPicks: { items: string[]; placeHolder: string | undefined }[] = [];
const inputs: { prompt: string | undefined; value: string | undefined }[] = [];
const files = new Map<string, string>();
const shownDocuments: unknown[] = [];
const statusMessages: string[] = [];
let pick: (labels: readonly string[]) => string | undefined = () => undefined;
let input: (asked: { prompt?: string; value?: string }) => string | undefined = () => undefined;

const workspacePath = (path: string) => path.replace(/^\/workspace\//, '');
const labelOf = (item: string | vscode.QuickPickItem) => (typeof item === 'string' ? item : item.label);

export const commands = {
  registerCommand: (id: string, handler: Handler) => { commandHandlers.set(id, handler); return new Disposable(() => { commandHandlers.delete(id); }); },
  executeCommand: (...args: unknown[]) => {
    executed.push(args);
    if (args[0] === 'setContext') contexts.set(String(args[1]), args[2]);
    return Promise.resolve();
  },
};

export const window = {
  createTreeView: (id: string, options: vscode.TreeViewOptions<unknown>) => treeViews.create(id, options),
  registerFileDecorationProvider: (provider: Decorations) => { decorations.push(provider); return new Disposable(() => undefined); },
  createStatusBarItem: () => {
    const item: StatusBarItem = {
      text: '', shown: false, disposed: false, show: () => { item.shown = true; }, hide: () => { item.shown = false; }, dispose: () => { item.disposed = true; },
    };
    statusBarItems.push(item);
    return item;
  },
  withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
  showQuickPick: async <T extends string | vscode.QuickPickItem>(items: readonly T[] | Promise<readonly T[]>, options?: { placeHolder?: string }) => {
    const offered = await items;
    const labels = offered.map(labelOf);
    quickPicks.push({ items: labels, placeHolder: options?.placeHolder });
    const picked = pick(labels);
    return offered.find((item) => labelOf(item) === picked);
  },
  showInputBox: async (options: { prompt?: string; value?: string; validateInput?: (value: string) => unknown } = {}) => {
    inputs.push({ prompt: options.prompt, value: options.value });
    const answer = input(options);
    if (answer !== undefined && await options.validateInput?.(answer)) return undefined;
    return answer;
  },
  showTextDocument: (document: unknown) => { shownDocuments.push(document); return Promise.resolve(); },
  createInputBox: () => {
    const box = new FakeInputBox();
    inputBoxes.push(box);
    return box;
  },
  setStatusBarMessage: (message: string) => { statusMessages.push(message); return new Disposable(() => undefined); },
};

export const workspace = {
  findFiles: (glob: string) => Promise.resolve([...files.keys()].filter((name) => glob !== '**/*.sql' || name.endsWith('.sql')).map((name) => Uri.file(`/workspace/${name}`))),
  openTextDocument: (target: { path: string } | { language: string }): Promise<{ uri: unknown; getText: () => string }> => Promise.resolve('language' in target
    ? { uri: uriParse('untitled:Untitled-1'), getText: () => '' }
    : { uri: target, getText: () => files.get(workspacePath(target.path)) ?? '' }),
  asRelativePath: (uri: { path: string }) => workspacePath(uri.path),
};

export const languages = {
  createDiagnosticCollection: (name: string) => {
    const collection = new FakeDiagnosticCollection();
    collections.set(name, collection);
    return collection;
  },
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
  registered: (id: string) => commandHandlers.has(id),
  /** Each command executed, with its arguments, setContext's included. */
  executed,
  /** The last value each context key was set to. */
  contexts,
  treeView: (id?: string) => treeViews.view(id),
  /** The problems the Problems panel shows on each file of the collection, by path. */
  problems: (name: string) => new Map([...collections.get(name) ?? []].map(([uri, shown]) => [uri.fsPath, shown.map(({ message, severity }) => ({ message, severity }))])),
  diagnostics: (name: string) => collections.get(name),
  /** What each decoration provider draws on the row at `uri`, in registration order. */
  decorate: (uri: unknown) => Promise.all(decorations.map((provider) => Promise.resolve(provider.provideFileDecoration(uri)))),
  lenses: (text: string) => lenses.flatMap((provider) => provider.provideCodeLenses({ getText: () => text })),
  codeActions: async (path: string, diagnostics: readonly unknown[]) =>
    (await Promise.all(actions.map((provider) => Promise.resolve(provider.provideCodeActions({ uri: Uri.file(path) }, undefined, { diagnostics }))))).flatMap((each) => each ?? []),
  statusBarItems,
  inputBoxes,
  /** Each quick pick shown, its labels and placeholder. */
  quickPicks,
  /** Each input box asked, its prompt and value. */
  inputs,
  /** Picks the item whose label `answer` returns. */
  picks: (answer: (labels: readonly string[]) => string | undefined) => { pick = answer; },
  /** Types the answer `answer` returns into each input box. */
  types: (answer: (asked: { prompt?: string; value?: string }) => string | undefined) => { input = answer; },
  /** The workspace's files, by path from its root. */
  files,
  shownDocuments,
  statusMessages,
  /** Forgets everything registered and held, as a fresh window. */
  reset: () => {
    treeViews.clear();
    for (const held of [commandHandlers, contexts, collections, files]) held.clear();
    for (const held of [executed, decorations, lenses, actions, statusBarItems, inputBoxes, quickPicks, inputs, shownDocuments, statusMessages]) held.length = 0;
    pick = () => undefined;
    input = () => undefined;
  },
};
