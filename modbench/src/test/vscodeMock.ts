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
  fire(e?: T) { this.handlers.forEach((h) => h(e as T)); }
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

// PluginListProvider.test.ts's resourceUri assertion (`toEqual({ fsPath })`) fails against the
// richer `uriFile` above: `toEqual` does not ignore an extra defined `toString`. Real drift, so
// both shapes stay.
export const uriFilePlain = (p: string) => ({ fsPath: p });

export const uriFrom = (opts: { scheme: string; path: string; query?: string }) =>
  ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' });

export class DataTransferItem {
  constructor(public value: unknown) {}
}

export class DataTransfer {
  private readonly map = new Map<string, unknown>();
  set(mime: string, item: unknown) { this.map.set(mime, item); }
  get(mime: string) { return this.map.get(mime); }
}
