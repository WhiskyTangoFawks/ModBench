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

function make(
  rows: FakeRow[],
  children = new FakeChildren(),
  driftOf?: (file: string) => { loadedOrigin: string; currentOrigin: string | null; currentPath: string | null } | undefined,
  hasMatchingRecords?: (file: string) => boolean | undefined,
) {
  const rowSource = new FakeRows(rows);
  const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
    rows: rowSource,
    children,
    pluginFileOf: (row) => row.file,
    orderIssueMastersOf: (row) => row.orderIssueMasters,
    driftOf,
    hasMatchingRecords,
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

// #396 / ADR-0035's dated §Filters amendment (reversing part of #278's own amendment): while a
// record filter is active, a plugin with zero matching records is hidden entirely, not merely
// left unexpandable — a visible-but-inert row is still noise, and the point of a filter is to cut
// noise. Row omission and the chevron read the same fact (`hasMatchingRecords`), so a hidden row
// never gets far enough to have a chevron opinion at all.
describe('PluginsTreeComposite — a record filter hides a plugin with no matches (#396 / ADR-0035)', () => {
  it('omits a plugin with no matching records from the row set entirely', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW], new FakeChildren(), undefined, (file) => file !== 'A.esp');
    composite.setSession(new Set(['A.esp', 'B.esp']));

    expect(await render()).toEqual([OTHER_ROW]);
  });

  it('keeps a plugin the filter still matches visible and expandable', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW], new FakeChildren(), undefined, (file) => file !== 'A.esp');
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    expect(composite.getTreeItem(OTHER_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // No filter machinery wired (the accessor absent) has to read the same as "no filter active" —
  // every existing session-start test above already asserts a visible, expandable row with no
  // third argument at all, so this only has to hold the line rather than prove it fresh.
  it('keeps every session row present and expandable when hasMatchingRecords is not wired', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    composite.setSession(new Set(['A.esp']));

    expect(await render()).toEqual([PLUGIN_ROW]);
    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // A row that stands for no plugin file (an error/empty-state row) has nothing for a record
  // filter to have an opinion about, so it is never a candidate for hiding — same as it was never
  // a candidate for the chevron.
  it('never hides a row that stands for no plugin file', async () => {
    const { composite, render } = make([PLUGIN_ROW, ERROR_ROW], new FakeChildren(), undefined, () => false);
    composite.setSession(new Set(['A.esp']));

    expect(await render()).toEqual([ERROR_ROW]);
  });

  it('restores a hidden plugin immediately, in load order, once the filter clears', async () => {
    let matches = false;
    const { composite, render } = make(
      [PLUGIN_ROW, OTHER_ROW], new FakeChildren(), undefined, (file) => file !== 'A.esp' || matches,
    );
    composite.setSession(new Set(['A.esp', 'B.esp']));
    expect(await render()).toEqual([OTHER_ROW]);

    // Stands in for SessionController.clearFilter's real hand-off: refreshMatchingPlugins flips
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
      [PLUGIN_ROW, OTHER_ROW], new FakeChildren(), undefined, (file) => file !== 'A.esp' || matches,
    );
    composite.setSession(new Set(['A.esp', 'B.esp']));
    expect(await render()).toEqual([OTHER_ROW]);

    rowSource.rows.reverse();
    matches = true;
    composite.refreshDecorations();

    expect(await composite.getChildren()).toEqual([OTHER_ROW, PLUGIN_ROW]);
  });

  // Issue #396's own explicit AC: "this applies even to a plugin with a load error / missing
  // master that would normally always stay visible — the maintainer's explicit call". Both facts
  // ride the same setSession hand-off as hasMatchingRecords (extension.ts's SessionPluginFiles),
  // and isHiddenByFilter reads only pluginFileOf/hasMatchingRecords — never masterIssues or
  // loadFailures — so a plugin flagged either way is hidden right along with an ordinary one.
  it('hides a plugin with a missing-master flag while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), undefined, () => false);
    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(await render()).toEqual([]);
  });

  it('hides a plugin that failed to load while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), undefined, () => false);
    composite.setSession(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

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

// #276 / ADR-0035: read-only-for-editing (Editing's "Immutable plugin", medit/ApiClient.ts
// PluginMetadata.isImmutable) is decided and rendered here — the one place already exempted from
// contextBoundary.test.ts's import scan because it has to be able to say in prose what it joins —
// so that neither PluginListProvider.ts (Mod Management) nor PluginTreeProvider.ts (Editing) has
// to learn the other's vocabulary. One setter carries both facts a session hands off (which files
// it holds, which of those are read-only), since the two never change independently: nothing in
// extension.ts calls one without the other. AC5's other half — hiding editing actions from a
// read-only plugin's context menu — has no command to gate yet (no per-row editing command is
// contributed in package.json today), so it isn't tested here; see plugins.md.
describe('PluginsTreeComposite — read-only tooltip (#276 AC4/AC5)', () => {
  it('tags a read-only plugin\'s tooltip once the session says so', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('matches read-only case-insensitively, like the session set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(['a.ESP']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('leaves an editable plugin\'s tooltip untouched', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set());

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('defaults to no read-only plugins when the second argument is omitted', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('clears on session close along with everything else', async () => {
    // Both real row providers return the row itself as its own TreeItem (getTreeItem(el) { return
    // el; }), so decorating it mutates the one object the tree keeps reusing across renders —
    // reading the tooltip *while* read-only, before it clears, is what makes this a real
    // regression test for accumulate-instead-of-reset, not just "never decorated in the first
    // place" (which the previous, pre-fix version of this test could not have told apart).
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setSession(new Set(['A.esp']), new Set(['A.esp']));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');

    composite.setSession(undefined);

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

    composite.setSession(new Set(['A.esp']), new Set(['A.esp']));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master A.esp is not loaded before this plugin');
    expect(tooltip).toContain('read-only');

    // Going read-only → editable on the same (reused) row object must restore exactly the row
    // provider's own tooltip, not leave the read-only note stuck on top of it.
    composite.setSession(new Set(['A.esp']), new Set());

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBe('Master A.esp is not loaded before this plugin');
  });
});

// #277 / ADR-0037 AC1/AC2/AC4: a plugin declaring a master absent from the session is flagged
// with an error decoration and stays fully browsable — never deactivated, excluded or hidden.
// The wording distinguishes a directly-missing master from one that is itself unloadable, per
// ADR-0037's own examples ("Missing master: X.esm" vs. "Master Foo.esp cannot be loaded").
describe('PluginsTreeComposite — master-issue decoration (#277 / ADR-0037 AC1/AC2/AC4)', () => {
  it('flags a row with a directly-missing master', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    // #395: the same red the Problems panel uses, not the plain foreground color a colorless
    // ThemeIcon renders in — otherwise indistinguishable at a glance in a large load order.
    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
  });

  it('flags a row whose master is itself unloadable, worded distinctly from directly-missing', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Broken.esm', kind: 'Unloadable' as const }]],
    ]));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master Broken.esm cannot be loaded');
    expect(tooltip).not.toContain('Missing master');
  });

  it('matches the plugin key case-insensitively, like the session set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['A.ESP', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');
  });

  // AC2: never deactivated, excluded or hidden. The leading slot (checkbox/lock, #276) and the
  // row's expandability are both untouched by this decoration.
  it('never touches collapsibleState — AC2, and the leading slot stays the checkbox\'s alone', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect('checkboxState' in item).toBe(false);
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setSession(new Set(['A.esp', 'B.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  // #276 hit exactly this bug once with tooltip alone; AC1/AC8's decoration also touches icon and
  // description, so the same reused-row hazard applies to both — restore, not just tooltip.
  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');

    composite.setSession(new Set(['A.esp']), new Set(), new Map());

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  // The generated wire type is `masterIssues?: MasterIssue[] | null` — optional and nullable —
  // even though the backend always emits an array once #277 ships; a backend predating this
  // field must degrade to "no issues", not throw. A fixture built from our own PluginMetadata
  // type can never produce this shape (it's non-optional there), so this bypasses the type at
  // the call site directly, the way a stale-backend response actually would.
  it('degrades to undecorated, without throwing, when a plugin\'s issue list is absent', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    expect(() => composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', undefined as unknown as { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' }[]],
    ]))).not.toThrow();

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// #277 / ADR-0037 AC7: a plugin that fails to open or parse still has a row — Mod Management
// builds rows from plugins.txt, not from the session — so this decorates an existing row with
// its recorded reason rather than synthesising a missing one. Data already crosses the wire via
// SessionLoadResponse.failures (no new endpoint); this covers the tree receiving it.
describe('PluginsTreeComposite — load-failure decoration (#277 / ADR-0037 AC7)', () => {
  it('flags a row whose plugin failed to load, with the reason', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    // #395: the reason can be a multi-line exception-chain summary (GameSession.PluginLoadFailure
    // now joins outer through innermost message) — the tooltip must carry every line, readably.
    const reason = 'InvalidOperationException: Malformed record\nFormatException: bad subrecord at offset 12';
    composite.setSession(new Set(), new Set(), new Map(), new Map([['a.esp', reason]]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Failed to load: InvalidOperationException: Malformed record');
    expect(item.tooltip).toContain('FormatException: bad subrecord at offset 12');
  });

  // AC2: the row stays put — plugins.txt still lists it — but it never got indexed, so it's
  // honestly a leaf, the same non-expandable state a row not yet in the session always has.
  it('never abandons the row, but it stays a leaf — it was never indexed', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('matches the plugin key case-insensitively', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setSession(new Set(), new Set(), new Map(), new Map([['A.ESP', 'Malformed record']]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');
  });

  it('clears once the plugin is no longer reported failed', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setSession(new Set(), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');

    composite.setSession(new Set(['A.esp']), new Set(), new Map(), new Map());

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setSession(new Set(['B.esp']), new Set(), new Map(), new Map([['a.esp', 'Malformed record']]));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// #277 / ADR-0037 AC8: the order-aware missing-master badge (issue #67, Mod Management, no
// session needed) and this session-derived state are one concept in the merged tree, never two
// decorations that can disagree.
describe('PluginsTreeComposite — reconciling the order-aware badge with session state (#277 AC8)', () => {
  it('reports a master both signals flag only once, in the backend\'s richer wording', async () => {
    const row: FakeRow = { file: 'A.esp', kind: 'plugin', orderIssueMasters: ['Ghost.esm'] };
    const { composite, render } = make([row]);
    await render();

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
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

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
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

    composite.setSession(new Set(['A.esp']), new Set(), new Map());

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

    composite.setSession(new Set(['A.esp']), new Set(), new Map([
      ['a.esp', [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }]],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master: Ghost.esm');
  });
});

// #279 / ADR-0035 § Live mutation: a mod-level change can make a plugin name resolve to a
// different physical file. The row says so and offers a re-read; nothing re-reads on its own.
//
// The comparison itself lives in `pluginDrift.ts` and is tested there — what these pin is the
// rendering contract: which of the row's decorations drift is allowed to touch, and (the part a
// menu contribution depends on) when the row becomes a re-read target.
describe('PluginsTreeComposite when a plugin has drifted', () => {
  const DRIFTED = { loadedOrigin: 'ModA', currentOrigin: 'ModB', currentPath: '/mods/B/A.esp' };
  const GONE = { loadedOrigin: 'ModA', currentOrigin: null, currentPath: null };

  const withDrift = (drift: Record<string, typeof DRIFTED | typeof GONE>) =>
    make([PLUGIN_ROW, OTHER_ROW], new FakeChildren(), (file) => drift[file]);

  it('states in the tooltip which origin is loaded and which it would now resolve to', async () => {
    const { composite, render } = withDrift({ 'A.esp': DRIFTED });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    const tooltip = String(composite.getTreeItem(PLUGIN_ROW).tooltip);
    expect(tooltip).toContain('ModA');
    expect(tooltip).toContain('ModB');
  });

  it('says a plugin whose name resolves to nothing resolves to nothing', async () => {
    const { composite, render } = withDrift({ 'A.esp': GONE });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    expect(String(composite.getTreeItem(PLUGIN_ROW).tooltip)).toContain('nothing');
  });

  it('makes a drifted row a re-read target', async () => {
    const { composite, render } = withDrift({ 'A.esp': DRIFTED });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    expect(composite.getTreeItem(PLUGIN_ROW).contextValue).toBe('pluginDrifted');
  });

  // Nothing to read, so nothing to offer: the row still flags, but the command must not appear.
  it('does not make a row that resolves to nothing a re-read target', async () => {
    const { composite, render } = withDrift({ 'A.esp': GONE });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    expect(composite.getTreeItem(PLUGIN_ROW).contextValue).toBe('plugin');
  });

  it('leaves a row that has not drifted exactly as its own provider built it', async () => {
    const { composite, render } = withDrift({ 'A.esp': DRIFTED });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.contextValue).toBe('plugin');
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });

  // Drift is about which file backs the row, not about whether it can be browsed: the session
  // still holds the records it read, and they stay readable until the user chooses otherwise.
  it('leaves the row expandable', async () => {
    const { composite, render } = withDrift({ 'A.esp': DRIFTED });
    composite.setSession(new Set(['A.esp', 'B.esp']));
    await render();

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('adds to the row\'s own tooltip rather than replacing it', async () => {
    const rowSource = new FakeRows([PLUGIN_ROW]);
    const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
      rows: rowSource,
      children: new FakeChildren(),
      pluginFileOf: (row) => row.file,
      driftOf: () => DRIFTED,
    });
    const built = rowSource.getTreeItem(PLUGIN_ROW);
    built.tooltip = 'A.esp';
    composite.setSession(new Set(['A.esp']));
    await composite.getChildren();

    expect(String(composite.getTreeItem(PLUGIN_ROW).tooltip)).toContain('A.esp');
  });

  // The mirror of the note above, and the bug #276 hit for the read-only note: rows are the same
  // mutable objects the tree keeps reusing, so a marker that stops applying has to actually come
  // back off — a re-read that resolves the drift must not leave the row claiming it forever.
  it('takes the marker back off once the drift clears', async () => {
    let drift: typeof DRIFTED | undefined = DRIFTED;
    const rowSource = new FakeRows([PLUGIN_ROW]);
    const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
      rows: rowSource,
      children: new FakeChildren(),
      pluginFileOf: (row) => row.file,
      driftOf: () => drift,
    });
    composite.setSession(new Set(['A.esp']));
    await composite.getChildren();
    expect(composite.getTreeItem(PLUGIN_ROW).contextValue).toBe('pluginDrifted');

    drift = undefined;

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.contextValue).toBe('plugin');
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });

  it('says nothing about drift on a row with no session behind it', async () => {
    const { composite, render } = withDrift({ 'A.esp': DRIFTED });
    await render(); // no setSession

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.contextValue).toBe('plugin');
    expect(item.tooltip).toBeUndefined();
  });
});

// #279: the distinction that a drift recomputation has to respect. A mod-level change alters no
// line of the load order, so the rows are the same rows — re-decorated, never rebuilt. Wiring drift
// to the row provider's `invalidate()` instead broke exactly this, and the integration suite caught
// it as "the row list is unchanged, so this must be the same reused row object".
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
