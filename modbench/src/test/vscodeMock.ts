// Exported as individual pieces, not one assembled object: each consuming file's
// `vi.mock('vscode')` factory lists only the names it needs, so production code reaching for an
// API a test did not ask for still throws.

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

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  value: string;
  constructor(v = '') { this.value = v; }
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
