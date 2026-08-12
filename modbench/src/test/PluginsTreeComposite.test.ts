import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    private readonly handlers: ((e: unknown) => void)[] = [];
    get event() {
      return (h: (e: unknown) => void) => {
        this.handlers.push(h);
        return { dispose: () => { /* no-op */ } };
      };
    }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
    dispose() { /* no-op */ }
  },
}));

import * as vscode from 'vscode';
import { PluginsTreeComposite } from '../PluginsTreeComposite';

// The composite is the one place the two bounded contexts touch, so its tests speak in neither
// context's vocabulary either: a "row" is whatever the load-order provider hands out and a "child"
// is whatever the record provider hands back. Both fakes are structural — the real providers
// satisfy the same shapes without an adapter.

interface FakeRow { file?: string; kind: string }
interface FakeChild { id: string }

class FakeRows {
  private readonly emitter = new vscode.EventEmitter<FakeRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  getChildrenCalls = 0;
  constructor(readonly rows: FakeRow[]) {}
  getChildren(): Promise<FakeRow[]> {
    this.getChildrenCalls++;
    return Promise.resolve(this.rows);
  }
  getTreeItem(row: FakeRow): vscode.TreeItem {
    // Mirrors both real providers: the node *is* the TreeItem, returned by identity.
    const cached = (this.items ??= new Map<FakeRow, vscode.TreeItem>());
    if (!cached.has(row)) cached.set(row, new vscode.TreeItem(row.file ?? row.kind));
    return cached.get(row)!;
  }
  fire(row?: FakeRow) { this.emitter.fire(row); }
  private items?: Map<FakeRow, vscode.TreeItem>;
}

class FakeChildren {
  private readonly emitter = new vscode.EventEmitter<FakeChild | undefined | null>();
  readonly onDidChangeTreeData = this.emitter.event;
  pluginChildrenCalls: string[] = [];
  getChildrenCalls: FakeChild[] = [];
  constructor(private readonly byPlugin: Record<string, FakeChild[]> = {}) {}
  getPluginChildren(file: string): Promise<FakeChild[]> {
    this.pluginChildrenCalls.push(file);
    return Promise.resolve(this.byPlugin[file] ?? []);
  }
  getChildren(child: FakeChild): Promise<FakeChild[]> {
    this.getChildrenCalls.push(child);
    return Promise.resolve([]);
  }
  getTreeItem(child: FakeChild): vscode.TreeItem {
    return new vscode.TreeItem(child.id);
  }
  fire(child?: FakeChild) { this.emitter.fire(child); }
}

function make(rows: FakeRow[], children = new FakeChildren()) {
  const rowSource = new FakeRows(rows);
  const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
    rows: rowSource,
    children,
    pluginFileOf: (row) => row.file,
  });
  // The composite tells rows from children by having handed the rows out, so every test renders
  // the root first — which is what VS Code does, and what its TreeDataProvider contract
  // guarantees: getTreeItem is only ever called with an element getChildren returned.
  const render = () => composite.getChildren();
  return { composite, rowSource, children, render };
}

const PLUGIN_ROW: FakeRow = { file: 'A.esp', kind: 'plugin' };
const OTHER_ROW: FakeRow = { file: 'B.esp', kind: 'plugin' };
const ERROR_ROW: FakeRow = { kind: 'error' };

describe('PluginsTreeComposite with no session', () => {
  it('renders exactly the load-order rows, in order', async () => {
    const { composite } = make([PLUGIN_ROW, OTHER_ROW]);

    expect(await composite.getChildren()).toEqual([PLUGIN_ROW, OTHER_ROW]);
  });

  it('leaves every row a leaf', async () => {
    const { composite, render } = make([PLUGIN_ROW, ERROR_ROW]);

    for (const row of await render()) {
      expect(composite.getTreeItem(row).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    }
  });

  it('never asks the record provider for anything', async () => {
    const { composite, children, render } = make([PLUGIN_ROW]);
    await render();

    await composite.getChildren(PLUGIN_ROW);

    expect(children.pluginChildrenCalls).toEqual([]);
  });
});

describe('PluginsTreeComposite when a session starts', () => {
  it('makes rows in the session collapsible', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('matches the session case-insensitively, like every other plugins.txt name comparison', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['a.ESP']));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // A chevron on a row the session never indexed would open onto an empty list, which reads as
  // "this plugin has no records" rather than "this plugin isn't loaded" (ADR-0026).
  it('leaves a row the session does not hold as a leaf', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']));

    expect(composite.getTreeItem(OTHER_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('leaves a row that stands for no plugin file a leaf', async () => {
    const { composite, render } = make([ERROR_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']));

    expect(composite.getTreeItem(ERROR_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  // "without rebuilding or reordering the tree": the rows are the load order the user is looking
  // at, and re-reading plugins.txt here would cost them their filter and scroll position for a
  // change that has nothing to do with what is on disk.
  it('does not re-read the load order, and hands back the same rows in the same order', async () => {
    const { composite, rowSource, render } = make([PLUGIN_ROW, OTHER_ROW]);
    const before = await render();
    const readsBefore = rowSource.getChildrenCalls;

    composite.setSession(new Set(['A.esp', 'B.esp']));

    expect(rowSource.getChildrenCalls).toBe(readsBefore);
    expect(await composite.getChildren()).toEqual(before);
  });

  it('fires a change event so the chevrons appear', () => {
    const { composite } = make([PLUGIN_ROW]);
    const fired: unknown[] = [];
    composite.onDidChangeTreeData((e) => fired.push(e));

    composite.setSession(new Set(['A.esp']));

    expect(fired).toHaveLength(1);
  });
});

describe('PluginsTreeComposite expansion', () => {
  const RECORD_TYPE: FakeChild = { id: 'Activator' };
  const WORLDSPACES: FakeChild = { id: 'Worldspaces' };

  it('expands a row into that plugin\'s children, asked for by filename', async () => {
    const children = new FakeChildren({ 'A.esp': [WORLDSPACES, RECORD_TYPE] });
    const { composite, render } = make([PLUGIN_ROW], children);
    await render();
    composite.setSession(new Set(['A.esp']));

    expect(await composite.getChildren(PLUGIN_ROW)).toEqual([WORLDSPACES, RECORD_TYPE]);
    expect(children.pluginChildrenCalls).toEqual(['A.esp']);
  });

  it('passes a child straight back to the record provider, whatever depth it is at', async () => {
    const children = new FakeChildren({ 'A.esp': [RECORD_TYPE] });
    const { composite, render } = make([PLUGIN_ROW], children);
    await render();
    composite.setSession(new Set(['A.esp']));
    const [recordType] = await composite.getChildren(PLUGIN_ROW);

    await composite.getChildren(recordType);

    expect(children.getChildrenCalls).toEqual([RECORD_TYPE]);
  });

  it('renders whatever the record provider returns for a failed fetch, rather than swallowing it', async () => {
    // The record provider answers a failed fetch with an error node (ADR-0026) — the composite
    // must not turn that into an empty list on its way through.
    const errorNode: FakeChild = { id: '⚠ Failed to load: boom' };
    const children = new FakeChildren({ 'A.esp': [errorNode] });
    const { composite, render } = make([PLUGIN_ROW], children);
    await render();
    composite.setSession(new Set(['A.esp']));

    expect(await composite.getChildren(PLUGIN_ROW)).toEqual([errorNode]);
  });

  it('forwards the record provider\'s targeted change events, so a load-more refreshes one parent', () => {
    const children = new FakeChildren();
    const { composite } = make([PLUGIN_ROW], children);
    const fired: unknown[] = [];
    composite.onDidChangeTreeData((e) => fired.push(e));

    children.fire(RECORD_TYPE);

    expect(fired).toEqual([RECORD_TYPE]);
  });

  it('forwards the load order\'s own change events', () => {
    const { composite, rowSource } = make([PLUGIN_ROW]);
    const fired: unknown[] = [];
    composite.onDidChangeTreeData((e) => fired.push(e));

    rowSource.fire(undefined);

    expect(fired).toEqual([undefined]);
  });
});

describe('PluginsTreeComposite when the session closes', () => {
  it('returns every row to a leaf', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setSession(new Set(['A.esp']));

    composite.setSession(undefined);

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('keeps the load order intact', async () => {
    const { composite, rowSource, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();
    composite.setSession(new Set(['A.esp', 'B.esp']));
    const readsBefore = rowSource.getChildrenCalls;

    composite.setSession(undefined);

    expect(rowSource.getChildrenCalls).toBe(readsBefore);
    expect(await composite.getChildren()).toEqual([PLUGIN_ROW, OTHER_ROW]);
  });
});
