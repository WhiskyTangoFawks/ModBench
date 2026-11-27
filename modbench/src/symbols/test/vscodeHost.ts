// The VS Code the Symbols box registers with: a test file mocks `vscode` with this module, and reads through `host`
// what the box registered and what it shows.

import { ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri as BaseUri, uriParse, type FakeUri } from '../../test/vscodeMock';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';

export { ThemeIcon, TreeItem, TreeItemCollapsibleState };

type Listener<T> = (event: T) => void;
type Handler = (...args: unknown[]) => unknown;

function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    event: (listener: Listener<T>) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    fire: (event: T) => { for (const listener of [...listeners]) listener(event); },
    clear: () => { listeners.clear(); },
  };
}

export class Disposable {
  constructor(readonly dispose: () => void) {}
  static from(...all: { dispose: () => unknown }[]): Disposable { return new Disposable(() => { for (const each of all) each.dispose(); }); }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(...at: [Position, Position] | [number, number, number, number]) {
    [this.start, this.end] = at.length === 2 ? at : [new Position(at[0], at[1]), new Position(at[2], at[3])];
  }
}

export class Location {
  readonly range: Range;
  constructor(readonly uri: FakeUri, at: Range | Position) { this.range = at instanceof Range ? at : new Range(at, at); }
}

export class MarkdownString {
  constructor(readonly value = '') {}
}

export class Hover {
  constructor(readonly contents: MarkdownString, readonly range: Range) {}
}

export class CompletionItem {
  insertText?: string;
  filterText?: string;
  range?: Range;
  constructor(readonly label: { label: string; description?: string }, readonly kind: number) {}
}

export class CompletionList {
  constructor(readonly items: CompletionItem[], readonly isIncomplete: boolean) {}
}

export class SymbolInformation {
  constructor(readonly name: string, readonly kind: number, readonly containerName: string, public location: Location) {}
}

export class WorkspaceEdit {}

export class Diagnostic {
  source?: string;
  code?: unknown;
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}

class DiagnosticCollection {
  readonly held = new Map<string, readonly unknown[]>();
  set(uri: FakeUri, diagnostics: readonly unknown[] | undefined): void {
    if (diagnostics === undefined) this.held.delete(uri.fsPath);
    else this.held.set(uri.fsPath, diagnostics);
  }
  delete(uri: FakeUri): void { this.held.delete(uri.fsPath); }
  clear(): void { this.held.clear(); }
  dispose(): void { this.held.clear(); }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Object: 18 };
export const CompletionItemKind = { File: 16, Folder: 18, Class: 6, Reference: 17 };
export const Uri = { ...BaseUri, parse: uriParse };

interface At { line: number; character: number }
export interface FakeDocument {
  uri: FakeUri; isDirty: boolean; languageId: string; version: number; getText: () => string;
  offsetAt: (at: At) => number; positionAt: (offset: number) => Position; lineAt: (line: number) => { text: string };
}

interface Token { isCancellationRequested: boolean }
interface Providers {
  hover: { provideHover: (document: FakeDocument, at: Position, token: Token) => Promise<Hover | undefined> };
  completion: { provideCompletionItems: (document: FakeDocument, at: Position, token: Token) => Promise<CompletionList | undefined> };
  definition: { provideDefinition: (document: FakeDocument, at: Position, token: Token) => Promise<Location | undefined> };
  references: { provideReferences: (document: FakeDocument, at: Position, context: unknown, token: Token) => Promise<Location[] | undefined> };
  workspaceSymbols: {
    provideWorkspaceSymbols: (query: string, token: Token) => Promise<SymbolInformation[]>;
    resolveWorkspaceSymbol: (symbol: SymbolInformation) => Promise<SymbolInformation>;
  };
  rename: {
    prepareRename: (document: FakeDocument, at: Position) => Promise<{ range: Range; placeholder: string }>;
    provideRenameEdits: (document: FakeDocument, at: Position, newName: string) => Promise<WorkspaceEdit>;
  };
}

const opened = emitter<FakeDocument>();
const changed = emitter<{ document: FakeDocument; contentChanges: readonly unknown[] }>();
const closed = emitter<FakeDocument>();
const willRename = emitter<unknown>();
const didRename = emitter<unknown>();
const extensionsChanged = emitter<undefined>();
const commandHandlers = new Map<string, Handler>();
const executed: unknown[][] = [];
const providers: { [K in keyof Providers]?: Providers[K] } = {};
const collections = new Map<string, DiagnosticCollection>();
const referencesShown: ReferencesViewInput[] = [];
const quickPicks: ReturnType<typeof fakeQuickPick<{ label: string }>>[] = [];
const unopenable = new Set<string>();
let documents: FakeDocument[] = [];
let referencesViewEnabled = true;

const register = <K extends keyof Providers>(kind: K) => (provider: Providers[K]) => {
  providers[kind] = provider;
  return new Disposable(() => { Reflect.deleteProperty(providers, kind); });
};

export const commands = {
  registerCommand: (id: string, handler: Handler) => { commandHandlers.set(id, handler); return new Disposable(() => { commandHandlers.delete(id); }); },
  executeCommand: (...args: unknown[]) => { executed.push(args); return Promise.resolve(); },
};

export const languages = {
  registerHoverProvider: (_selector: unknown, provider: Providers['hover']) => register('hover')(provider),
  registerCompletionItemProvider: (_selector: unknown, provider: Providers['completion']) => register('completion')(provider),
  registerDefinitionProvider: (_selector: unknown, provider: Providers['definition']) => register('definition')(provider),
  registerReferenceProvider: (_selector: unknown, provider: Providers['references']) => register('references')(provider),
  registerRenameProvider: (_selector: unknown, provider: Providers['rename']) => register('rename')(provider),
  registerWorkspaceSymbolProvider: (provider: Providers['workspaceSymbols']) => register('workspaceSymbols')(provider),
  createDiagnosticCollection: (name: string) => {
    const collection = new DiagnosticCollection();
    collections.set(name, collection);
    return collection;
  },
};

const positionAt = (text: string, offset: number): Position => {
  const lines = text.slice(0, offset).split('\n');
  return new Position(lines.length - 1, lines.at(-1)?.length ?? 0);
};

/** A document VS Code holds of `path`, saved unless `isDirty` says otherwise. */
export function document(path: string, text: string, { scheme = 'file', isDirty = false, languageId = 'json' } = {}): FakeDocument & { text: string } {
  const made = {
    uri: Uri.from({ scheme, path }), isDirty, languageId, version: 1, text,
    getText: () => made.text,
    offsetAt: ({ line, character }: At) => made.text.split('\n').slice(0, line).reduce((sum, held) => sum + held.length + 1, 0) + character,
    positionAt: (offset: number) => positionAt(made.text, offset),
    lineAt: (line: number) => ({ text: made.text.split('\n')[line]?.replace(/\r$/, '') ?? '' }),
  };
  return made;
}

export const workspace = {
  get textDocuments() { return documents; },
  openTextDocument: (uri: FakeUri) => (unopenable.has(uri.fsPath)
    ? Promise.reject(new Error('The file is gone.'))
    : Promise.resolve(documents.find((held) => held.uri.toString() === uri.toString()) ?? document(uri.fsPath, ''))),
  onDidOpenTextDocument: opened.event,
  onDidChangeTextDocument: changed.event,
  onDidCloseTextDocument: closed.event,
  onWillRenameFiles: willRename.event,
  onDidRenameFiles: didRename.event,
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
};

export const window = {
  createQuickPick: () => {
    const made = fakeQuickPick<{ label: string }>();
    quickPicks.push(made);
    return made.qp;
  },
};

export const extensions = {
  getExtension: (id: string) => (id === 'vscode.references-view' && referencesViewEnabled
    ? { activate: () => Promise.resolve({ setInput: (input: ReferencesViewInput) => { referencesShown.push(input); } }) }
    : undefined),
  onDidChange: extensionsChanged.event,
};

const NOT_CANCELLED: Token = { isCancellationRequested: false };

const provider = <K extends keyof Providers>(kind: K): Providers[K] => {
  const held = providers[kind];
  if (held === undefined) throw new Error(`no ${kind} provider is registered`);
  return held;
};

const marking = (path: string, marked: string) => {
  const held = document(path, marked.replace('|', ''));
  return { held, at: held.positionAt(marked.indexOf('|')) };
};

/** What the box registered with VS Code and what it shows, and the user's acts on them. A `marked` text is a saved
 *  document's at `path`, with a bar at the place asked about. */
export const host = {
  /** Runs the command as VS Code does for a menu or a key. */
  run: (id: string, ...args: unknown[]): Promise<unknown> => {
    const handler = commandHandlers.get(id);
    if (handler === undefined) throw new Error(`no command ${id} is registered`);
    return Promise.resolve(handler(...args));
  },
  /** Each command executed, with its arguments, setContext's included. */
  executed,
  context: (key: string): unknown => executed.filter(([id, held]) => id === 'setContext' && held === key).at(-1)?.[2],
  hover: async (path: string, marked: string, token = NOT_CANCELLED) => {
    const { held, at } = marking(path, marked);
    const hover = await provider('hover').provideHover(held, at, token);
    return hover && { text: hover.contents.value, spans: held.text.slice(held.offsetAt(hover.range.start), held.offsetAt(hover.range.end)) };
  },
  complete: async (path: string, marked: string, token = NOT_CANCELLED) => {
    const { held, at } = marking(path, marked);
    const list = await provider('completion').provideCompletionItems(held, at, token);
    return list && {
      isIncomplete: list.isIncomplete,
      items: list.items.map((item) => ({
        label: item.label.label, detail: item.label.description, kind: item.kind, insertText: item.insertText,
        replaces: item.range && held.text.slice(held.offsetAt(item.range.start), held.offsetAt(item.range.end)),
      })),
    };
  },
  definition: (path: string, marked: string, token = NOT_CANCELLED) => {
    const { held, at } = marking(path, marked);
    return provider('definition').provideDefinition(held, at, token);
  },
  references: (path: string, marked: string, token = NOT_CANCELLED) => {
    const { held, at } = marking(path, marked);
    return provider('references').provideReferences(held, at, {}, token);
  },
  workspaceSymbols: (query: string, token = NOT_CANCELLED) => provider('workspaceSymbols').provideWorkspaceSymbols(query, token),
  resolveWorkspaceSymbol: (symbol: SymbolInformation) => provider('workspaceSymbols').resolveWorkspaceSymbol(symbol),
  prepareRename: async (path: string, marked: string) => {
    const { held, at } = marking(path, marked);
    const { range, placeholder } = await provider('rename').prepareRename(held, at);
    return { spans: held.text.slice(held.offsetAt(range.start), held.offsetAt(range.end)), placeholder };
  },
  rename: (path: string, marked: string, newName: string) => {
    const { held, at } = marking(path, marked);
    return provider('rename').provideRenameEdits(held, at, newName);
  },
  /** The problems the Problems panel shows on each file of the collection, by path. */
  problems: (name: string) => new Map([...collections.get(name)?.held ?? []].map(([path, shown]) => [path, shown
    .filter((diagnostic) => diagnostic instanceof Diagnostic)
    .map(({ range, message }) => ({ message, start: range.start, end: range.end }))])),
  /** Each list the References view was given. */
  referencesShown,
  /** Each quick pick the box showed, with the user's acts on it. */
  quickPicks,
  /** Each path VS Code fails to open, saying the file is gone. */
  unopenable,
  /** Sets the documents VS Code holds, as at the start. */
  holds: (held: FakeDocument[]) => { documents = held; },
  open: (held: FakeDocument) => { documents = [...documents, held]; opened.fire(held); },
  change: (held: FakeDocument) => { changed.fire({ document: held, contentChanges: [{}] }); },
  close: (held: FakeDocument) => { documents = documents.filter((each) => each !== held); closed.fire(held); },
  willRenameFiles: willRename.fire,
  didRenameFiles: didRename.fire,
  /** Disables or enables VS Code's References view. */
  referencesView: (enabled: boolean) => { referencesViewEnabled = enabled; extensionsChanged.fire(undefined); },
  /** Forgets everything registered and held, as a fresh window. */
  reset: () => {
    for (const each of [opened, changed, closed, willRename, didRename, extensionsChanged]) each.clear();
    for (const held of [commandHandlers, collections, unopenable]) held.clear();
    for (const kind of Object.keys(providers)) Reflect.deleteProperty(providers, kind);
    executed.length = 0;
    referencesShown.length = 0;
    quickPicks.length = 0;
    documents = [];
    referencesViewEnabled = true;
  },
};
