// Shared building blocks for the hand-rolled `vi.mock('vscode', ...)` factories that unit tests
// exercising a tree/decoration provider need (TreeItem, EventEmitter, ThemeIcon, ...). Before
// this file, seven test files each redeclared their own near-identical copies (#640).
//
// This module exports its pieces individually rather than one assembled object on purpose: each
// consuming file's own `vi.mock('vscode', () => ({ ... }))` factory imports and lists only the
// names it needs, so a member this file provides but a given test doesn't import stays absent
// from that test's `vscode` mock — production code reaching for a `vscode` API a test didn't ask
// for still throws there, exactly as it did before this file existed. A single assembled object
// re-exported wholesale would silently hand every test the union of what any of them ever needed,
// which is the dedup this file deliberately does not do.
//
// Same pattern already established by modmanager/test/fakeVscodeWatcher.ts for the watcher
// family; this one lives at src/test/, alongside the tests for the composition-root modules
// that live in modbench/src/ itself (PluginsTreeComposite.ts, nameFilter.ts,
// LoadoutHeaderProvider.ts) — src/test/ is where their shared test scaffolding belongs, because
// it is imported by both modmanager/ and medit/ test files and carries no domain vocabulary of
// either context — nothing here says "mod" or "record".

// Deliberately declares only the two constructor-assigned fields. The optional VS Code
// TreeItem properties (description, tooltip, contextValue, iconPath, resourceUri, command,
// checkboxState, id, ...) are never declared here — every real subclass under test assigns them
// dynamically (`this.checkboxState = ...`) exactly as it would against the real vscode.TreeItem,
// and a plain, undeclared JS assignment works with no base-class field needed. Declaring them
// here instead would (under native/esbuild class-field semantics) make every instance carry an
// own `undefined`-valued property for each one — which is observable: PluginsTreeComposite.test.ts
// asserts `'checkboxState' in item` is false for nodes the composite never touches. A declared
// field here would make that assertion silently pass regardless (#640 guard-test finding).
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

// PluginListProvider.test.ts's ImplicitMasterNode resourceUri assertion (`toEqual({ fsPath })`)
// fails against the richer `uriFile` above — `toEqual` does not ignore an extra defined
// `toString` function the way it ignores undefined-valued properties, so that file needs the
// bare shape. Real drift, not incidental: keep both rather than picking one (#640 guard-test
// finding).
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
