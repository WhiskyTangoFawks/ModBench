import { describe, it, expect, vi } from 'vitest';
import { TreeItem, ThemeIcon, ThemeColor, TreeItemCollapsibleState, EventEmitter } from './vscodeMock';

vi.mock('vscode', () => ({ TreeItem, ThemeIcon, ThemeColor, TreeItemCollapsibleState, EventEmitter }));

import * as vscode from 'vscode';
import { PluginsTreeComposite } from '../PluginsTreeComposite';

type MasterIssue = { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' };

// The composite is the one place the two bounded contexts touch, so its tests speak in neither
// context's vocabulary: a "row" is whatever the load-order provider hands out, a "child"
// whatever the record provider hands back.

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
) {
  const rowSource = new FakeRows(rows);
  const composite = new PluginsTreeComposite<FakeRow, FakeChild>({
    rows: rowSource,
    children,
    pluginFileOf: (row) => row.file,
    orderIssueMastersOf: (row) => row.orderIssueMasters,
    hasMatchingRecords,
  });
  // The composite tells rows from children by having handed the rows out, so every test renders
  // the root first — VS Code's TreeDataProvider contract guarantees that ordering.
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

    for (const row of await render() as FakeRow[]) {
      const item = composite.getTreeItem(row);
      expect(item.label).toBe(row.file ?? row.kind);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
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

  // The rows are the load order the user is looking at, and re-reading plugins.txt here would cost
  // them their filter and scroll position for a change that has nothing to do with the disk.
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

// ADR-0035 §Filters: while a record filter is active, a plugin with zero matching records is
// hidden entirely, not merely left unexpandable — a visible-but-inert row is still noise.
describe('PluginsTreeComposite — a record filter hides a plugin with no matches (ADR-0035)', () => {
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

  // No filter machinery wired (the accessor absent) has to read the same as "no filter active".
  it('keeps every load order row present and expandable when hasMatchingRecords is not wired', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    composite.setLoadOrder(new Set(['A.esp']));

    expect(await render()).toEqual([PLUGIN_ROW]);
    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // A row that stands for no plugin file has nothing for a record filter to have an opinion
  // about, so it is never a candidate for hiding.
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

  // Drag/drop reorders through PluginListProvider directly and the composite never caches row
  // order, so a reorder made while a row is hidden still lands in its new position once the
  // filter clears.
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

  // isHiddenByFilter reads only pluginFileOf/hasMatchingRecords — never masterIssues or
  // loadFailures — so a plugin carrying a load error or a missing master is hidden right along
  // with an ordinary one. A deliberate call.
  it('hides a plugin with a missing-master flag while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), () => false);
    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
    ]));

    expect(await render()).toEqual([]);
  });

  it('hides a plugin that failed to load while the filter matches none of its records', async () => {
    const { composite, render } = make([PLUGIN_ROW], new FakeChildren(), () => false);
    composite.setLoadOrder(new Set(), new Map([['a.esp', { loadFailure: 'Malformed record' }]]));

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

// ADR-0035: read-only-for-editing is decided and rendered here, the one place exempt from
// contextBoundary.test.ts's import scan, so neither provider learns the other's vocabulary.
describe('PluginsTreeComposite — read-only tooltip', () => {
  it('tags a read-only plugin\'s tooltip once the load order says so', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Map([['A.esp', { readOnly: true }]]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('matches read-only case-insensitively, like the load order set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Map([['a.ESP', { readOnly: true }]]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('read-only');
  });

  it('leaves an editable plugin\'s tooltip untouched', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('defaults to no read-only plugins when the second argument is omitted', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBeUndefined();
  });

  it('clears on mEdit close along with everything else', async () => {
    // Both row providers return the row itself as its own TreeItem, so decorating mutates the one
    // object the tree reuses across renders — reading the tooltip while still read-only is what
    // catches accumulate-instead-of-reset.
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Map([['A.esp', { readOnly: true }]]));
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

    composite.setLoadOrder(new Set(['A.esp']), new Map([['A.esp', { readOnly: true }]]));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master A.esp is not loaded before this plugin');
    expect(tooltip).toContain('read-only');

    // Going read-only → editable on the same (reused) row object must restore exactly the row
    // provider's own tooltip, not leave the read-only note stuck on top of it.
    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toBe('Master A.esp is not loaded before this plugin');
  });
});

// ADR-0037: a plugin declaring a master absent from the load order is flagged and stays fully
// browsable — never deactivated, excluded or hidden. The wording distinguishes a directly-missing
// master from one that is itself unloadable.
describe('PluginsTreeComposite — master-issue decoration (ADR-0037 AC1/AC2/AC4)', () => {
  it('flags a row with a directly-missing master', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
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

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Broken.esm', kind: 'Unloadable' as const }] }],
    ]));

    const tooltip = composite.getTreeItem(PLUGIN_ROW).tooltip as string;
    expect(tooltip).toContain('Master Broken.esm cannot be loaded');
    expect(tooltip).not.toContain('Missing master');
  });

  it('matches the plugin key case-insensitively, like the load order set itself', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['A.ESP', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');
  });

  // Never deactivated, excluded or hidden. The leading slot (checkbox/lock) and the
  // row's expandability are both untouched by this decoration.
  it('never touches collapsibleState — AC2, and the leading slot stays the checkbox\'s alone', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
    ]));

    const item = composite.getTreeItem(PLUGIN_ROW);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect('checkboxState' in item).toBe(false);
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(new Set(['A.esp', 'B.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
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
    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
    ]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master');

    composite.setLoadOrder(new Set(['A.esp']));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  // The wire type is `masterIssues?: MasterIssue[] | null`, so a response lacking it must degrade
  // to "no issues" rather than throw; PluginMetadata cannot express that shape, so the fixture
  // bypasses the type at the call site.
  it('degrades to undecorated, without throwing, when a plugin\'s issue list is absent', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    expect(() => composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: undefined as unknown as MasterIssue[] }],
    ]))).not.toThrow();

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// ADR-0037: a plugin that fails to open or parse still has a row — Mod Management builds rows
// from plugins.txt, not from the load order — so this decorates an existing row with its
// recorded reason rather than synthesising one.
describe('PluginsTreeComposite — load-failure decoration (ADR-0037 AC7)', () => {
  it('flags a row whose plugin failed to load, with the reason', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    // The reason can be a multi-line exception-chain summary (LoadOrder.PluginLoadFailure
    // joins outer through innermost message) — the tooltip must carry every line, readably.
    const reason = 'InvalidOperationException: Malformed record\nFormatException: bad subrecord at offset 12';
    composite.setLoadOrder(new Set(), new Map([['a.esp', { loadFailure: reason }]]));

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

    composite.setLoadOrder(new Set(), new Map([['a.esp', { loadFailure: 'Malformed record' }]]));

    expect(composite.getTreeItem(PLUGIN_ROW).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('matches the plugin key case-insensitively', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();

    composite.setLoadOrder(new Set(), new Map([['A.ESP', { loadFailure: 'Malformed record' }]]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');
  });

  it('clears the failed-tooltip once a later reconcile reports the plugin loaded', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(), new Map([['a.esp', { loadFailure: 'Malformed record' }]]));
    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Failed to load');

    composite.setLoadOrder(new Set(['A.esp']));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  it('leaves an unaffected plugin\'s row undecorated', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(new Set(['B.esp']), new Map([['a.esp', { loadFailure: 'Malformed record' }]]));

    const item = composite.getTreeItem(OTHER_ROW);
    expect(item.tooltip).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });
});

// A plugin that loaded but holds a record Mutagen could not read carries the same failure prefix
// as a failed plugin, from the fact the plugin listing already answers.
describe('parse-failure decoration', () => {
  it('flags a plugin holding an unreadable record, and leaves every other row alone', async () => {
    const { composite, render } = make([PLUGIN_ROW, OTHER_ROW]);
    await render();

    composite.setLoadOrder(
      new Set(['A.esp', 'B.esp']), new Map([['a.esp', { parseFailure: true }]]));

    const flagged = composite.getTreeItem(PLUGIN_ROW);
    expect((flagged.iconPath as vscode.ThemeIcon).id).toBe('error');
    expect(flagged.tooltip).toContain('could not be read');
    expect(composite.getTreeItem(OTHER_ROW).iconPath).toBeUndefined();
  });

  it('clears once a later reconcile reports the plugin whole', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']), new Map([['a.esp', { parseFailure: true }]]));
    expect(composite.getTreeItem(PLUGIN_ROW).iconPath).toBeDefined();

    composite.setLoadOrder(new Set(['A.esp']));

    expect(composite.getTreeItem(PLUGIN_ROW).iconPath).toBeUndefined();
  });
});

// The malformed-plugin diagnoses join the same backend-decoration chain at warning tier, below a
// load failure or master issue, since a malformed plugin still loads and plays.
describe('malformed-plugin diagnosis decoration', () => {
  it('decorates a diagnosed plugin row with the warning badge and the diagnosis text', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    composite.setDiagnoses(new Map([['A.ESP', ['REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8']]]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.description).toBe('⚠ Malformed plugin');
    expect(item.tooltip).toContain('RDAT is 6 bytes');
  });

  it('a load failure keeps decoration authority over a diagnosis on the same row', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(), new Map([['a.esp', { loadFailure: 'Malformed record' }]]));

    composite.setDiagnoses(new Map([['a.esp', ['some diagnosis']]]));

    expect(composite.getTreeItem(PLUGIN_ROW).description).toBe('✗ Failed to load');
  });

  it('a reconcile clears the previous scan\'s diagnoses until the new one lands', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));
    composite.setDiagnoses(new Map([['a.esp', ['some diagnosis']]]));

    composite.setLoadOrder(new Set(['A.esp']));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
  });

  it('two diagnoses on one plugin read as a count and both tooltip lines', async () => {
    const { composite, render } = make([PLUGIN_ROW]);
    await render();
    composite.setLoadOrder(new Set(['A.esp']));

    composite.setDiagnoses(new Map([['a.esp', ['first diagnosis', 'second diagnosis']]]));

    const item = composite.getTreeItem(PLUGIN_ROW);
    expect(item.description).toBe('⚠ 2 malformed-plugin diagnoses');
    expect(item.tooltip).toContain('first diagnosis');
    expect(item.tooltip).toContain('second diagnosis');
  });
});

// ADR-0037: the order-aware missing-master badge (Mod Management, no
// load order needed) and this load-order-derived state are one concept in the merged tree, never two
// decorations that can disagree.
describe('PluginsTreeComposite — reconciling the order-aware badge with load order state', () => {
  it('reports a master both signals flag only once, in the backend\'s richer wording', async () => {
    const row: FakeRow = { file: 'A.esp', kind: 'plugin', orderIssueMasters: ['Ghost.esm'] };
    const { composite, render } = make([row]);
    await render();

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
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

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
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

    composite.setLoadOrder(new Set(['A.esp']));

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

    composite.setLoadOrder(new Set(['A.esp']), new Map([
      ['a.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' as const }] }],
    ]));

    expect(composite.getTreeItem(PLUGIN_ROW).tooltip).toContain('Missing master: Ghost.esm');
  });
});

// A change to which file a plugin name resolves to is absorbed by the reconcile verb (ADR-0044),
// so `contextValue: 'plugin'` is the only value a row carries out of here.
describe('PluginsTreeComposite applies no decoration of its own to a plugin row', () => {
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

// Such a change alters no line of the load order, so the rows are the same rows — re-decorated,
// never rebuilt. Wiring the decoration refresh to the row provider's `invalidate()` breaks that.
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
