// The VS Code the Source language box registers with: a test file mocks `vscode` with this module, and
// reads through `host` what the box registered and what it shows.

import { Uri as BaseUri, uriParse, type FakeUri } from '../../test/vscodeMock';

interface Position { line: number; character: number }
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

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(...at: [Position, Position] | [number, number, number, number]) {
    [this.start, this.end] = at.length === 2 ? at : [{ line: at[0], character: at[1] }, { line: at[2], character: at[3] }];
  }
}

export class CompletionItem {
  insertText?: string;
  filterText?: string;
  range?: Range;
  constructor(readonly label: { label: string; description?: string }, readonly kind: number) {}
}

export class FileSystemError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class Diagnostic {
  source?: string;
  code?: { value: string; target: ReturnType<typeof uriParse> };
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}

/** The problems VS Code shows on each file, by its path. */
class DiagnosticCollection {
  readonly held = new Map<string, readonly unknown[]>();
  set(uri: FakeUri, diagnostics: readonly unknown[]): void { this.held.set(uri.fsPath, diagnostics); }
  delete(uri: FakeUri): void { this.held.delete(uri.fsPath); }
  dispose(): void { this.held.clear(); }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const CompletionItemKind = { EnumMember: 19 };
export const LanguageStatusSeverity = { Information: 0, Warning: 1, Error: 2 };
// As the real Uri, which writes a drive letter in lower case.
const file = (path: string): FakeUri => {
  const uri = BaseUri.file(path);
  const written = uri.toString().replace(/^file:\/\/([A-Z]):/, (_match: string, drive: string) => `file://${drive.toLowerCase()}:`);
  return Object.assign(uri, { toString: () => written });
};
export const Uri = { ...BaseUri, file, joinPath: (from: FakeUri, ...segments: string[]) => file(BaseUri.joinPath(from, ...segments).fsPath), parse: uriParse };

export interface FakeDocument { uri: FakeUri; isDirty: boolean; getText: () => string; offsetAt: (at: Position) => number; positionAt: (offset: number) => Position }

const opened = emitter<FakeDocument>();
const changed = emitter<{ document: FakeDocument }>();
const saved = emitter<FakeDocument>();
const closed = emitter<FakeDocument>();
const commandHandlers = new Map<string, Handler>();
const executed: unknown[][] = [];
const completionProviders: { provideCompletionItems: (document: FakeDocument, at: Position) => Promise<CompletionItem[] | undefined> }[] = [];
const collections = new Map<string, DiagnosticCollection>();
const statuses = new Map<string, { text: string; severity?: number }>();
const files = new Map<string, string | (() => Promise<string>)>();
const reads: string[] = [];
let documents: FakeDocument[] = [];

export const commands = {
  registerCommand: (id: string, handler: Handler) => { commandHandlers.set(id, handler); return new Disposable(() => { commandHandlers.delete(id); }); },
  executeCommand: (...args: unknown[]) => { executed.push(args); return Promise.resolve(); },
};

export const languages = {
  registerCompletionItemProvider: (_selector: unknown, provider: (typeof completionProviders)[number]) => {
    completionProviders.push(provider);
    return new Disposable(() => { completionProviders.splice(completionProviders.indexOf(provider), 1); });
  },
  createDiagnosticCollection: (name: string) => {
    const collection = new DiagnosticCollection();
    collections.set(name, collection);
    return collection;
  },
  createLanguageStatusItem: (id: string) => {
    const item = { text: '', severity: undefined as number | undefined, dispose: () => { statuses.delete(id); } };
    statuses.set(id, item);
    return item;
  },
};

export const workspace = {
  get textDocuments() { return documents; },
  onDidOpenTextDocument: opened.event,
  onDidChangeTextDocument: changed.event,
  onDidSaveTextDocument: saved.event,
  onDidCloseTextDocument: closed.event,
  fs: {
    readFile: async (uri: FakeUri) => {
      reads.push(uri.fsPath);
      const held = files.get(uri.fsPath);
      if (held === undefined) throw new FileSystemError('FileNotFound');
      return new TextEncoder().encode(typeof held === 'string' ? held : await held());
    },
  },
};

const positionAt = (text: string, offset: number): Position => {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

/** A document VS Code holds of `path`, unsaved unless `isDirty` says otherwise. */
export function document(path: string, text: string, { scheme = 'file', isDirty = true } = {}): FakeDocument & { text: string } {
  const made = {
    uri: Uri.from({ scheme, path }), isDirty, text,
    getText: () => made.text,
    offsetAt: ({ line, character }: Position) => made.text.split('\n').slice(0, line).reduce((sum, held) => sum + held.length + 1, 0) + character,
    positionAt: (offset: number) => positionAt(made.text, offset),
  };
  return made;
}

/** What the box registered with VS Code and what it shows, and the user's acts on them. */
export const host = {
  /** Runs the command as VS Code does for a menu or a key. */
  run: (id: string, ...args: unknown[]): Promise<unknown> => {
    const handler = commandHandlers.get(id);
    if (handler === undefined) throw new Error(`no command ${id} is registered`);
    return Promise.resolve(handler(...args));
  },
  /** Each command executed, with its arguments, setContext's included. */
  executed,
  /** The value setContext last gave the key. */
  context: (key: string): unknown => executed.filter(([id, held]) => id === 'setContext' && held === key).at(-1)?.[2],
  /** The completion VS Code shows at the bar in `marked`, the text of an unsaved document at `path`. */
  complete: async (path: string, marked: string) => {
    const held = document(path, marked.replace('|', ''));
    const at = held.positionAt(marked.indexOf('|'));
    const lists = await Promise.all(completionProviders.map((provider) => provider.provideCompletionItems(held, at)));
    return lists.flatMap((items) => items ?? []).map((item) => ({
      label: item.label.label, detail: item.label.description, insertText: item.insertText,
      replaces: item.range && held.text.slice(held.offsetAt(item.range.start), held.offsetAt(item.range.end)),
    }));
  },
  /** The problems the Problems panel shows on each file of the collection, by path. */
  problems: (name: string) => new Map([...collections.get(name)?.held ?? []].map(([path, shown]) => [path, shown
    .filter((diagnostic) => diagnostic instanceof Diagnostic)
    .map(({ range, message, code }) => ({
      message, start: range.start, end: range.end,
      ...code && { clearing: { label: code.value, command: code.target.path, args: JSON.parse(code.target.query) as unknown } },
    }))])),
  /** The text of each language status item shown. */
  statuses: (): string[] => [...statuses.values()].map(({ text }) => text),
  status: (id: string): string | undefined => statuses.get(id)?.text,
  /** The text VS Code reads off disk at a path, or the read that answers it. */
  files,
  /** Each path read off disk. */
  reads,
  /** Sets the documents VS Code holds, as at the start. */
  holds: (held: FakeDocument[]) => { documents = held; },
  open: (held: FakeDocument) => { documents = [...documents, held]; opened.fire(held); },
  change: (held: FakeDocument) => { changed.fire({ document: held }); },
  save: (held: FakeDocument) => { held.isDirty = false; saved.fire(held); },
  close: (held: FakeDocument) => { documents = documents.filter((each) => each !== held); closed.fire(held); },
  /** Forgets everything registered and held, as a fresh window. */
  reset: () => {
    for (const each of [opened, changed, saved, closed]) each.clear();
    for (const held of [commandHandlers, collections, statuses, files]) held.clear();
    executed.length = 0;
    reads.length = 0;
    completionProviders.length = 0;
    documents = [];
  },
};
