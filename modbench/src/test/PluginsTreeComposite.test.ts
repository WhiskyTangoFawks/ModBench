import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    tooltip?: string;
    description?: string;
    iconPath?: unknown;
    contextValue?: string;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
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

interface FakeRow { file?: string; kind: string; orderIssueMasters?: string[] }
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
    if (!cached.has(row)) {
      const item = new vscode.TreeItem(row.file ?? row.kind);
      // As PluginNode/ImplicitMasterNode do: the row states what kind of thing it is, and that is
      // what package.json's `view/item/context` clauses gate on.
      item.contextValue = row.kind;
      cached.set(row, item);
    }
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
  constructor(
    private readonly byPlugin: Record<string, FakeChild[]> = {},
  ) {}
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

function make(
  rows: FakeRow[],
  children = new FakeChildren(),
  hasMatchingRecords?: (file: string) => boolean | undefined,
  compileStaleOf?: (file: string) => { stale: boolean; lastCompiledAt: string | null } | undefined,
) {
  const rowSource = new FakeRows(rows);
  const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
    rows: rowSource,
    children,
    pluginFileOf: (row) => row.file,
    orderIssueMastersOf: (row) => row.orderIssueMasters,
    hasMatchingRecords,
    compileStaleOf,
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

describe('PluginsTreeComposite with no backend running', () => {
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

describe('PluginsTreeComposite when a mEdit starts', () => {
  it('makes rows in the load order collapsible', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('matches the load order case-insensitively, like every other plugins.txt name comparison', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['a.ESP']));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // A chevron on a row the load order never indexed would open onto an empty list, which reads as
  // "this plugin has no records" rather than "this plugin isn't loaded" (ADR-0026).
  it('leaves a row the load order does not hold as a leaf', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(OTHER_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('leaves a row that stands for no plugin file a leaf', async () => {
    const { composite, render } = make([ERROR_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(ERROR_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  // "without rebuilding or reordering the tree": the rows are the load order the user is looking
  // at, and re-reading plugins.txt here would cost them their filter and scroll position for a
  // change that has nothing to do with what is on disk.
  it('does not re-read the load order, and hands back the same rows in the same order', async () => {
    const { composite, rowSource, render } = make([PLUGIN_ROW, OTHER_ROW]);
    const before = await render();
    const readsBefore = rowSource.getChildrenCalls;

    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));

    expect(rowSource.getChildrenCalls).toBe(readsBefore);
    expect(await composite.getChildren()).toEqual(before);
  });

  it('fires a change event so the chevrons appear', () => {
    const { composite } = make([PLUGIN_ROW]);
    const fired: unknown[] = [];
    composite.onDidChangeTreeData((e) => fired.push(e));

    composite.setLoadOrder(new Set(['A.esp']));

    expect(fired).toHaveLength(1);
  });
});

// ADR-0035's dated §Filters amendment: while a
// record filter is active, a plugin with zero matching records is hidden entirely, not merely
// left unexpandable — a visible-but-inert row is still noise, and the point of a filter is to cut
// noise. Row omission and the chevron read the same fact (`hasMatchingRecords`), so a hidden row
// never gets far enough to have a chevron opinion at all.
describe('PluginsTreeComposite — a record filter hides a plugin with no matches (#396 / ADR-0035)', () => {
  it('omits a plugin with no matching records from the row set entirely', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW], new FakeChildren(), (file) => file !== 'A.esp');
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));

    expect(await render()).toEqual([OTHER_ROW]);
  });

  it('keeps a plugin the filter still matches visible and expandable', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW], new FakeChildren(), (file) => file !== 'A.esp');
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));
    await render();

    expect(composite.getTreeItem(OTHER_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // No filter machinery wired (the accessor absent) has to read the same as "no filter active" —
  // every existing load order-start test above already asserts a visible, expandable row with no
  // third argument at all, so this only has to hold the line rather than prove it fresh.
  it('keeps every load order row present and expandable when hasMatchingRecords is not wired', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    composite.setLoadOrder(new Set(['A.esp']));

    expect(await render()).toEqual([PLUGIN_ROW]);
    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // A row that stands for no plugin file (an error/empty-state row) has nothing for a record
  // filter to have an opinion about, so it is never a candidate for hiding — same as it was never
  // a candidate for the chevron.
  it('never hides a row that stands for no plugin file', async () => {
    const { composite, render } = make([PLUGIN_ROW, ERROR_ROW], new FakeChildren(), () => false);
    composite.setLoadOrder(new Set(['A.esp']));

    expect(await render()).toEqual([ERROR_ROW]);
  });

  it('restores a hidden plugin immediately, in load order, once the filter clears', async () => {
    let matches = false;
    const { composite, render } = make(
      [PLUGIN_ROW, OTHER_ROW], new FakeChildren(), (file) => file !== 'A.esp' || matches,
    );
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));
    expect(await render()).toEqual([OTHER_ROW]);

    // Stands in for LoadOrderController.clearFilter's real hand-off: refreshMatchingPlugins flips
    // the per-plugin fact, then fires the same re-render refreshDecorations does.
    matches = true;
    composite.refreshDecorations();

    expect(await composite.getChildren()).toEqual([PLUGIN_ROW, OTHER_ROW]);
  });

  // Drag/drop reorders through PluginListProvider directly — extension.ts wires
  // `dragAndDropController: pluginListProvider`, not this composite — and the composite itself
  // never caches row order (see the "does not re-read the load order" test above): every
  // getChildren() re-derives the visible set from a fresh rows.getChildren() call plus the
  // current hasMatchingRecords answer. So a reorder that happens while a row is hidden must still
  // land in its new position once the filter clears, not the position it had when hidden.
  it('restores a hidden row in its new position when the underlying order changed while it was hidden', async () => {
    let matches = false;
    const { composite, rowSource, render } = make(
      [PLUGIN_ROW, OTHER_ROW], new FakeChildren(), (file) => file !== 'A.esp' || matches,
    );
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));
    expect(await render()).toEqual([OTHER_ROW]);

    rowSource.rows.reverse();
    matches = true;
    composite.refreshDecorations();

    expect(await composite.getChildren()).toEqual([OTHER_ROW, PLUGIN_ROW]);
  });

  // This applies even to a plugin with a load error / missing
  // master that would normally always stay visible — a deliberate call. Both facts
  // ride the same setLoadOrder hand-off as hasMatchingRecords (extension.ts's LoadOrderPluginFiles),
  // and isHiddenByFilter reads only pluginFileOf/hasMatchingRecords — never masterIssues or
  // loadFailures — so a plugin flagged either way is hidden right along with an ordinary one.
  it('hides a plugin with a missing-master flag while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), () => false);
    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(await render()).toEqual([]);
  });

  it('hides a plugin that failed to load while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), () => false);
    composite.setLoadOrder(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

    expect(await render()).toEqual([]);
  });
});

describe('PluginsTreeComposite expansion', () => {
  const RECORD_TYPE: FakeChild = { id: 'Activator' };
  const WORLDSPACES: FakeChild = { id: 'Worldspaces' };

  it('expands a row into that plugin\'s children, asked for by filename', async () => {
    const children = new FakeChildren({ 'A.esp': [WORLDSPACES, RECORD_TYPE] });
    const { composite, render } = make([PLUGIN_ROW], children);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    expect(await composite.getChildren(PLUGIN_ROW)).toEqual([WORLDSPACES, RECORD_TYPE]);
    expect(children.pluginChildrenCalls).toEqual(['A.esp']);
  });

  it('passes a child straight back to the record provider, whatever depth it is at', async () => {
    const children = new FakeChildren({ 'A.esp': [RECORD_TYPE] });
    const { composite, render } = make([PLUGIN_ROW], children);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));
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
    composite.setLoadOrder(new Set(['A.esp']));

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


describe('PluginsTreeComposite when the mEdit closes', () => {
  it('returns every row to a leaf', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    composite.setLoadOrder(undefined);

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('keeps the load order intact', async () => {
    const { composite, rowSource, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));
    const readsBefore = rowSource.getChildrenCalls;

    composite.setLoadOrder(undefined);

    expect(rowSource.getChildrenCalls).toBe(readsBefore);
    expect(await composite.getChildren()).toEqual([PLUGIN_ROW, OTHER_ROW]);
  });
});

// ADR-0035 § Live mutation: the composition root's gate for whether a load-order mutation
// (a checkbox toggle) has a running backend to apply itself to at all.
describe('PluginsTreeComposite.hasLoadOrder', () => {
  it('is false before any load order is set', () => {
    const { composite } = make([PLUGIN_ROW]);
    expect(composite.hasLoadOrder()).toBe(false);
  });

  it('is true once a load order is set, even an empty one', () => {
    const { composite } = make([PLUGIN_ROW]);
    composite.setLoadOrder(new Set());
    expect(composite.hasLoadOrder()).toBe(true);
  });

  it('is false again once the mEdit closes', () => {
    const { composite } = make([PLUGIN_ROW]);
    composite.setLoadOrder(new Set(['A.esp']));

    composite.setLoadOrder(undefined);

    expect(composite.hasLoadOrder()).toBe(false);
  });
});

// ADR-0035: read-only-for-editing (Editing's "Immutable plugin", medit/ApiClient.ts
// PluginMetadata.isImmutable) is decided and rendered here — the one place already exempted from
// contextBoundary.test.ts's import scan because it has to be able to say in prose what it joins —
// so that neither PluginListProvider.ts (Mod Management) nor PluginTreeProvider.ts (Editing) has
// to learn the other's vocabulary. One setter carries both facts a load order hands off (which files
// it holds, which of those are read-only), since the two never change independently: nothing in
// extension.ts calls one without the other. The other half — hiding editing actions from a
// read-only plugin's context menu — has no command to gate yet (no per-row editing command is
// contributed in package.json today), so it isn't tested here; see plugins.md.
describe('PluginsTreeComposite — read-only tooltip (#276 AC4/AC5)', () => {
  it('tags a read-only plugin\'s tooltip once the load order says so', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('matches read-only case-insensitively, like the load order set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(['a.ESP']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('leaves an editable plugin\'s tooltip untouched', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set());

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('defaults to no read-only plugins when the second argument is omitted', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('clears on mEdit close along with everything else', async () => {
    // Both real row providers return the row itself as its own TreeItem (getTreeItem(el) { return
    // el; }), so decorating it mutates the one object the tree keeps reusing across renders —
    // reading the tooltip *while* read-only, before it clears, is what makes this a real
    // regression test for accumulate-instead-of-reset, not just "never decorated in the first
    // place" (which the previous, pre-fix version of this test could not have told apart).
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Set(['A.esp']));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');

    composite.setLoadOrder(undefined);

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('appends to, rather than replacing, a tooltip the row provider already set', async () => {
    const rowSource = new FakeRows([PLUGIN_ROW]);
    const original = rowSource.getTreeItem(PLUGIN_ROW);
    original.tooltip = 'Master A.esp is not loaded before this plugin';
    const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
      rows: rowSource, children: new FakeChildren(), pluginFileOf: (row) => row.file,
    });
    await composite.getChildren();

    composite.setLoadOrder(new Set(['A.esp']), new Set(['A.esp']));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master A.esp is not loaded before this plugin');
    expect(tooltip).toContain('read-only');

    // Going read-only → editable on the same (reused) row object must restore exactly the row
    // provider's own tooltip, not leave the read-only note stuck on top of it.
    composite.setLoadOrder(new Set(['A.esp']), new Set());

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBe('Master A.esp is not loaded before this plugin');
  });
});

// ADR-0037: a plugin declaring a master absent from the load order is flagged
// with an error decoration and stays fully browsable — never deactivated, excluded or hidden.
// The wording distinguishes a directly-missing master from one that is itself unloadable, per
// ADR-0037's own examples ("Missing master: X.esm" vs. "Master Foo.esp cannot be loaded").
describe('PluginsTreeComposite — master-issue decoration (#277 / ADR-0037 AC1/AC2/AC4)', () => {
  it('flags a row with a directly-missing master', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    // The same red the Problems panel uses, not the plain foreground color a colorless
    // ThemeIcon renders in — otherwise indistinguishable at a glance in a large load order.
    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
  });

  it('flags a row whose master is itself unloadable, worded distinctly from directly-missing', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Broken.esm', kind: 'Unloadable' as const }]],
    ]));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master Broken.esm cannot be loaded');
    expect(tooltip).not.toContain('Missing master');
  });

  it('matches the plugin key case-insensitively, like the load order set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['A.ESP', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');
  });

  // Never deactivated, excluded or hidden. The leading slot (checkbox/lock) and the
  // row's expandability are both untouched by this decoration.
  it('never touches collapsibleState — AC2, and the leading slot stays the checkbox\'s alone', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect('checkboxState' in item).toBe(false);
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp', 'B.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  // The tooltip-only form of this bug happened once; this decoration also touches icon and
  // description, so the same reused-row hazard applies to both — restore, not just tooltip.
  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map());

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  // The generated wire type is `masterIssues?: MasterIssue[] | null` — optional and nullable —
  // even though the backend always emits an array; a backend predating this
  // field must degrade to "no issues", not throw. A fixture built from our own PluginMetadata
  // type can never produce this shape (it's non-optional there), so this bypasses the type at
  // the call site directly, the way a stale-backend response actually would.
  it('degrades to undecorated, without throwing, when a plugin\'s issue list is absent', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    expect(() => composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', undefined as unknown as { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' }[]],
    ]))).not.toThrow();

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// A tracked plugin whose source has moved past refs/medit/last-compile/<plugin> — "the game
// can't see your edits yet". Load-order-derived, same family as the master-issue/load-failure
// decorations above (icon/description/tooltip, append-never-replace, never the leading slot) rather
// than a FileDecorationProvider tint — this is a git-tracked-state fact, not a filesystem one, and
// it must coexist with whatever else already decorated the row.
describe('PluginsTreeComposite — compile-staleness decoration (#449)', () => {
  it('appends a description hint and tooltip to a stale row', async () => {
    const { composite, render } = make([PLUGIN_ROW], undefined, undefined, (file) =>
      file === 'a.esp' ? { stale: true, lastCompiledAt: '2026-08-20T12:00:00Z' } : undefined);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    const item = composite.getTreeItem(PLUGIN_ROW);

    expect(item.description).toContain('Source ahead');
    expect(item.tooltip).toContain('Source ahead of binary');
    expect(item.tooltip).toContain('last compiled');
  });

  it('never claims the icon slot — the description hint is the primary signal', async () => {
    const { composite, render } = make([PLUGIN_ROW], undefined, undefined, () => ({ stale: true, lastCompiledAt: null }));
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).iconPath).toBeUndefined();
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW], undefined, undefined, (file) =>
      file === 'a.esp' ? { stale: true, lastCompiledAt: null } : { stale: false, lastCompiledAt: null });
    await render();
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });

  // Unlike the master-issue reconciliation, there is nothing to reconcile here — this appends alongside
  // whatever the master-issue decoration already put on the row, never clobbering its icon or
  // overwriting (only extending) its description/tooltip text.
  it('coexists with an existing master-issue decoration on the same row, without stealing its icon', async () => {
    const { composite, render } = make([PLUGIN_ROW], undefined, undefined, () => ({ stale: true, lastCompiledAt: null }));
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
    expect(item.tooltip).toContain('Source ahead of binary');
    expect(item.description).toContain('Master issue');
    expect(item.description).toContain('Source ahead');
    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
  });

  it('clears once the plugin is recompiled (reused-row hazard, same as #276)', async () => {
    let stale = true;
    const { composite, render } = make([PLUGIN_ROW], undefined, undefined, () =>
      stale ? { stale: true, lastCompiledAt: null } : { stale: false, lastCompiledAt: null });
    await render();
    composite.setLoadOrder(new Set(['A.esp']));
    expect(composite.getTreeItem(PLUGIN_ROW).description).toContain('Source ahead');

    stale = false;
    composite.refreshDecorations();

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });

  it('never decorates when the accessor has nothing to say (untracked plugin, or not wired)', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });
});

// ADR-0037: a plugin that fails to open or parse still has a row — Mod Management
// builds rows from plugins.txt, not from the load order — so this decorates an existing row with
// its recorded reason rather than synthesising a missing one. Data already crosses the wire via
// LoadOrderLoadResponse.failures (no new endpoint); this covers the tree receiving it.
describe('PluginsTreeComposite — load-failure decoration (#277 / ADR-0037 AC7)', () => {
  it('flags a row whose plugin failed to load, with the reason', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    // The reason can be a multi-line exception-chain summary (LoadOrder.PluginLoadFailure
    // joins outer through innermost message) — the tooltip must carry every line, readably.
    const reason = 'InvalidOperationException: Malformed record\nFormatException: bad subrecord at offset 12';
    composite.setLoadOrder(new Set(), new Set(), new Map(), new Map([['a.esp', reason]]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Failed to load: InvalidOperationException: Malformed record');
    expect(item.tooltip).toContain('FormatException: bad subrecord at offset 12');
  });

  // The row stays put — plugins.txt still lists it — but it never got indexed, so it's
  // honestly a leaf, the same non-expandable state a row not yet in the load order always has.
  it('never abandons the row, but it stays a leaf — it was never indexed', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('matches the plugin key case-insensitively', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(), new Set(), new Map(), new Map([['A.ESP', 'Malformed record']]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');
  });

  it('clears once the plugin is no longer reported failed', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map(), new Map());

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(new Set(['B.esp']), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// ADR-0037: the order-aware missing-master badge (Mod Management, no
// load order needed) and this load-order-derived state are one concept in the merged tree, never two
// decorations that can disagree.
describe('PluginsTreeComposite — reconciling the order-aware badge with load order state (#277 AC8)', () => {
  it('reports a master both signals flag only once, in the backend\'s richer wording', async () => {
    const row: FakeRow = { file: 'A.esp', kind: 'plugin', orderIssueMasters: ['Ghost.esm'] };
    const { composite, render } = make([row]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const tooltip = composite.getTreeItem(row).tooltip as string;
    expect(tooltip).toContain('Missing master: Ghost.esm');
    expect(tooltip).not.toContain('is not loaded before this plugin');
  });

  it('preserves the frontend-only signal for a master that loaded fine but is merely mis-sequenced', async () => {
    // The backend flags a different master; the order-aware badge separately flags "Late.esp",
    // which the backend has nothing to say about — it loaded, Mutagen resolves it regardless of
    // position, so MasterResolution.Classify never reports it.
    const row: FakeRow = { file: 'A.esp', kind: 'plugin', orderIssueMasters: ['Late.esp'] };
    const { composite, render } = make([row]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const tooltip = composite.getTreeItem(row).tooltip as string;
    expect(tooltip).toContain('Missing master: Ghost.esm');
    expect(tooltip).toContain('Master Late.esp is not loaded before this plugin');
  });

  it('leaves a frontend-only order badge completely untouched when the backend has nothing to add', async () => {
    const rowSource = new FakeRows([PLUGIN_ROW]);
    const original = rowSource.getTreeItem(PLUGIN_ROW);
    original.tooltip = 'A.esp\nMaster Ghost.esm is not loaded before this plugin';
    original.description = '✗ Master not loaded before this plugin';
    const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
      rows: rowSource, children: new FakeChildren(), pluginFileOf: (row) => row.file,
      orderIssueMastersOf: () => ['Ghost.esm'],
    });
    await composite.getChildren();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map());

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBe('A.esp\nMaster Ghost.esm is not loaded before this plugin');
    expect(item.description).toBe('✗ Master not loaded before this plugin');
  });

  it('works without a wired orderIssueMastersOf — the backend\'s own wording stands alone', async () => {
    const rowSource = new FakeRows([PLUGIN_ROW]);
    const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
      rows: rowSource, children: new FakeChildren(), pluginFileOf: (row) => row.file,
    });
    await composite.getChildren();

    composite.setLoadOrder(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master: Ghost.esm');
  });
});

// A mod-level change that alters which file a plugin name resolves to is absorbed
// automatically (`pluginDrift.ts` + `LoadOrderController.rereadPlugin`) — there is nothing
// for this composite to render about it. This guards that retirement: nothing in
// `PluginsTreeCompositeDeps` names drift (TypeScript itself refuses a `driftOf` field —
// the compiler-enforced half of the retirement), and no combination of inputs produces a
// `pluginDrifted` contextValue, an added tooltip line, or an added icon/description for an
// origin change. `PluginListProvider`'s own `contextValue: 'plugin'` is therefore the only value
// a plugin row can carry out of this composite.
describe('PluginsTreeComposite has no drift decoration left to apply (#356)', () => {
  it('renders every plugin row exactly as its own provider built it, regardless of load order state', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    composite.setLoadOrder(new Set(['A.esp', 'B.esp']));
    await render();

    for (const row of [PLUGIN_ROW, OTHER_ROW]) {
      const item = composite.getTreeItem(row);
      expect(item.contextValue).toBe('plugin');
      expect(item.description).toBeUndefined();
      expect(item.tooltip).toBeUndefined();
    }
  });
});

// A mod-level change alters no
// line of the load order, so the rows are the same rows — re-decorated, never rebuilt. Wiring a
// decoration refresh to the row provider's `invalidate()` instead breaks exactly this:
// "the row list is unchanged, so this must be the same reused row object".
describe('PluginsTreeComposite decoration refresh', () => {
  it('re-renders without asking the row provider to re-read', async () => {
    const { composite, rowSource, render } = make([PLUGIN_ROW]);
    await render();
    const heard: unknown[] = [];
    composite.onDidChangeTreeData(() => heard.push(true));

    composite.refreshDecorations();

    expect(heard.length).toBe(1);
    // Re-rendering hands back the rows already built, so a row keeps its identity — which is what
    // the decoration state (and the tree's selection) is keyed to.
    expect(await composite.getChildren()).toEqual([PLUGIN_ROW]);
    expect(rowSource.rows[0]).toBe(PLUGIN_ROW);
  });
});
