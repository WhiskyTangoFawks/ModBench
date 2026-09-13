// Exported as individual pieces, not one assembled object: each consuming file's
// `vi.mock('vscode')` factory lists only the names it needs, so production code reaching for an
// API a test did not ask for still throws.

import type * as vscode from 'vscode';

// Only the two constructor-assigned fields are declared. Declaring the optional TreeItem
// properties would, under native class-field semantics, give every instance an own
// `undefined`-valued property — observable as `'checkboxState' in item`.
export class TreeItem {
  label: string;
  collapsibleState: number;
  constructor(label: string, collapsibleState = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };

export class EventEmitter<T = unknown> {
  private readonly handlers: ((e: T) => void)[] = [];
  get event() {
    return (h: (e: T) => void) => {
      this.handlers.push(h);
      return { dispose: () => { /* no-op */ } };
    };
  }
  fire(e: T) { this.handlers.forEach((h) => h(e)); }
  dispose() { /* no-op */ }
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class MarkdownString {
  value: string;
  constructor(v = '') { this.value = v; }
}

export class Range {
  constructor(
    public readonly startLine: number, public readonly startChar: number,
    public readonly endLine: number, public readonly endChar: number,
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  constructor(public range: Range, public message: string, public severity: number = DiagnosticSeverity.Error) {}
}

export const uriFile = (p: string) => ({ fsPath: p, toString: () => `file://${p}` });

// PluginsTreeProvider.test.ts's resourceUri assertion (`toEqual({ fsPath })`) fails against the
// richer `uriFile` above: `toEqual` does not ignore an extra defined `toString`. Real drift, so
// both shapes stay.
export const uriFilePlain = (p: string) => ({ fsPath: p });

export const uriFrom = (opts: { scheme: string; path: string; query?: string }) =>
  ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' });

// Every member `vscode.DataTransferItem`/`vscode.DataTransfer` declare, so a test can pass one
// where production code's own parameter is typed `vscode.DataTransfer` — no cast at the seam.
export class DataTransferItem {
  constructor(public readonly value: unknown) {}
  asString(): Promise<string> { return Promise.resolve(String(this.value)); }
  asFile(): undefined { return undefined; }
}

export class DataTransfer {
  private readonly map = new Map<string, DataTransferItem>();
  set(mime: string, item: DataTransferItem) { this.map.set(mime, item); }
  get(mime: string) { return this.map.get(mime); }
  forEach(callback: (item: DataTransferItem, mime: string, dataTransfer: DataTransfer) => void) {
    this.map.forEach((item, mime) => callback(item, mime, this));
  }
  [Symbol.iterator](): IterableIterator<[string, DataTransferItem]> {
    return this.map.entries();
  }
}

/** A `vscode.CancellationToken` that is never cancelled — for a call whose token parameter it
 *  ignores, so a test states that plainly instead of casting past the parameter. */
export class FakeCancellationToken {
  readonly isCancellationRequested = false;
  onCancellationRequested() { return { dispose: () => { /* no-op */ } }; }
}

/** Every member `vscode.Uri` declares, for a call whose parameter is typed `vscode.Uri` — the
 *  real class is `private`-constructed, so nothing but a structural double can stand in for it. */
export interface FakeUri {
  fsPath: string; scheme: string; authority: string; path: string; query: string; fragment: string;
  with: (change: {
    scheme?: string; authority?: string; path?: string; query?: string; fragment?: string;
  }) => FakeUri;
  toString: () => string;
  toJSON: () => unknown;
}

export function fakeUri(fsPath: string): FakeUri {
  const uri: FakeUri = {
    fsPath, scheme: 'file', authority: '', path: fsPath, query: '', fragment: '',
    with: () => uri, toString: () => fsPath, toJSON: () => ({ fsPath }),
  };
  return uri;
}

/** Every member `vscode.DiagnosticCollection` declares — a test asserts on which URIs it holds,
 *  not on a raw call log. */
type FakeDiagnostics = readonly vscode.Diagnostic[];

export class FakeDiagnosticCollection {
  readonly name = 'fake';
  private readonly entries = new Map<string, { uri: FakeUri; diagnostics: FakeDiagnostics }>();

  set(uri: FakeUri, diagnostics: FakeDiagnostics | undefined): void;
  set(entries: ReadonlyArray<[FakeUri, FakeDiagnostics | undefined]>): void;
  set(
    uriOrEntries: FakeUri | ReadonlyArray<[FakeUri, FakeDiagnostics | undefined]>,
    diagnostics?: FakeDiagnostics,
  ): void {
    if ('fsPath' in uriOrEntries) {
      this.setOne(uriOrEntries, diagnostics);
    } else {
      for (const [uri, list] of uriOrEntries) this.setOne(uri, list);
    }
  }

  private setOne(uri: FakeUri, diagnostics: FakeDiagnostics | undefined): void {
    if (diagnostics === undefined) { this.entries.delete(uri.fsPath); return; }
    this.entries.set(uri.fsPath, { uri, diagnostics });
  }

  delete(uri: FakeUri): void { this.entries.delete(uri.fsPath); }
  clear(): void { this.entries.clear(); }
  get(uri: FakeUri): FakeDiagnostics | undefined { return this.entries.get(uri.fsPath)?.diagnostics; }
  has(uri: FakeUri): boolean { return this.entries.has(uri.fsPath); }
  dispose(): void { this.clear(); }

  forEach(callback: (uri: FakeUri, diagnostics: FakeDiagnostics, collection: this) => void): void {
    for (const { uri, diagnostics } of this.entries.values()) callback(uri, diagnostics, this);
  }

  [Symbol.iterator](): IterableIterator<[FakeUri, FakeDiagnostics]> {
    return [...this.entries.values()].map((e): [FakeUri, FakeDiagnostics] => [e.uri, e.diagnostics])[Symbol.iterator]();
  }
}
