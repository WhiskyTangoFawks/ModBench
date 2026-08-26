import { describe, it, expect, vi } from 'vitest';
import type { PluginMetadata, RecordSummary } from '../ApiClient';
import type { PluginRepository, RecordPage } from '../PluginRepository';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    collapsibleState: number;
    command?: unknown;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) => ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import {
  PluginTreeProvider, RecordTypeNode, RecordNode, LoadMoreNode,
  CellNode, InteriorCellsNode, InteriorLoadMoreNode,
  WorldspacesNode, WorldspaceNode, SubBlockNode, PlacedGroupNode, PlacedNode,
  ErrorNode, headerFormKeyFor,
} from '../PluginTreeProvider';
import type { PluginTreeNode } from '../PluginTreeProvider';
import { recordResourceUri } from '../recordResourceUri';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePlugin(i: number): PluginMetadata {
  return {
    name: `Plugin${i}.esp`,
    path: `/data/Plugin${i}.esp`,
    loadOrderIndex: i,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 100,
    isImmutable: false,
    origin: 'Data',
    masterIssues: [],
    hasMatchingRecords: true,
  };
}

function makeRecord(i: number, workingTreeState: RecordSummary['workingTreeState'] = 'None'): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`,
    plugin: 'Fallout4.esm',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
    workingTreeState,
  };
}

function makeRepository(overrides: Partial<{
  plugins: PluginMetadata[];
  recordTypes: { type: string; count: number; displayName?: string }[];
  records: RecordPage;
}> = {}): PluginRepository {
  return {
    getPlugins: vi.fn().mockResolvedValue(overrides.plugins ?? [makePlugin(0), makePlugin(1)]),
    getSessionStatus: vi.fn().mockResolvedValue(
      { totalPlugins: 0, indexedPlugins: [], conflictsComputed: true, failures: [] }),
    // #414 review F2.
    getTrackStatus: vi.fn().mockResolvedValue({ phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }),
    // #417.
    getExternalChangeStatus: vi.fn().mockResolvedValue([]),
    getRecordTypes: vi.fn().mockResolvedValue(overrides.recordTypes ?? [{ type: 'WEAP', count: 5, displayName: 'Weapon' }]),
    getRecords: vi.fn().mockResolvedValue(overrides.records ?? { items: [makeRecord(0)], total: 1 }),
    searchRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getConditionFunctions: vi.fn().mockResolvedValue([]),
    setFilter: vi.fn().mockResolvedValue(null),
    clearFilter: vi.fn().mockResolvedValue(undefined),
    getActiveFilter: vi.fn().mockResolvedValue(null),
    getWorldspaces: vi.fn().mockResolvedValue([]),
    getWorldspaceBlocks: vi.fn().mockResolvedValue({ blocks: [], topCell: null }),
    getCellReferences: vi.fn().mockResolvedValue({ persistent: [], temporary: [] }),
    // #415: the tree provider never edits — present only because the double implements the
    // whole PluginRepository surface.
    editRecordField: vi.fn(),
    getInteriorCells: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    // #416 review: the tree provider never compiles either — same "whole surface, unused here" note.
    getRecordOwner: vi.fn(),
    // #427: the tree provider never renumbers either — same "whole surface, unused here" note.
    peekNextFreeFormKey: vi.fn(),
    // #494: the tree provider never copies either — same "whole surface, unused here" note.
    getRecordOverridePlugins: vi.fn(),
  };
}

// #273: PluginTreeProvider's own standalone root listing (fetchPlugins/PluginNode/the
// getChildren(undefined) path) is deleted — it was reachable only through the standalone
// editing Plugins tree (modbench.pluginTree) this ticket retired. getPluginChildren(name) is now
// the one way into a plugin's children (also true in production: PluginsTreeComposite always
// calls this directly, never getChildren(undefined) — see the comment on getChildren itself).

// #273 Slice D: PluginTreeProvider.setFilter (issue #70's plugin-name filter) is deleted — it
// duplicated modbench.pluginListTree.filter over the same rows (both narrowed plugin rows by
// filename substring) once the merged tree made this provider's own root TreeView unreachable.
// The merged tree's own name filter is covered in PluginListProvider.test.ts.

// ── getPluginChildren (record types) ────────────────────────────────────────────

describe('PluginTreeProvider.getPluginChildren (record types)', () => {
  it('returns one RecordTypeNode per record type', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 10 }, { type: 'NPC_', count: 3 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordTypeNode)).toBe(true);
    expect((children[0] as RecordTypeNode).recordType).toBe('WEAP');
  });

  it('renders the xEdit display name as the label, not the raw signature', async () => {
    const repo = makeRepository({
      recordTypes: [{ type: 'acti', count: 10, displayName: 'Activator' }],
    });
    const provider = new PluginTreeProvider(repo);

    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    expect(typeNode.label).toBe('Activator');
    expect(typeNode.recordType).toBe('acti');
  });
});

// ── getChildren(RecordTypeNode) ───────────────────────────────────────────────

describe('PluginTreeProvider.getChildren(RecordTypeNode)', () => {
  it('returns RecordNodes for each record in the first page', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeRepository({ records: { items: records, total: 3 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children.filter(c => c instanceof RecordNode)).toHaveLength(3);
    expect(children.filter(c => c instanceof LoadMoreNode)).toHaveLength(0);
  });

  it('appends LoadMoreNode when total exceeds loaded count', async () => {
    const records = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const repo = makeRepository({ records: { items: records, total: 120 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children.filter(c => c instanceof RecordNode)).toHaveLength(50);
    const loadMore = children.find(c => c instanceof LoadMoreNode) as LoadMoreNode;
    expect(loadMore).toBeDefined();
    expect(loadMore.parentNode).toBe(typeNode);
  });

  it('uses cache on second expand without re-fetching', async () => {
    const repo = makeRepository({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    await provider.getChildren(typeNode);
    await provider.getChildren(typeNode);

    expect(repo.getRecords).toHaveBeenCalledTimes(1);
  });
});

// ── loadMore ──────────────────────────────────────────────────────────────────

describe('PluginTreeProvider.loadMore', () => {
  it('fetches next page and appends records to cache', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const secondPage = Array.from({ length: 20 }, (_, i) => makeRecord(50 + i));
    const repo = makeRepository({ records: { items: firstPage, total: 70 } });
    (repo.getRecords as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 70 })
      .mockResolvedValueOnce({ items: secondPage, total: 70 });

    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];
    const firstChildren = await provider.getChildren(typeNode);
    const loadMoreNode = firstChildren.find(c => c instanceof LoadMoreNode) as LoadMoreNode;

    await provider.loadMore(loadMoreNode);
    const afterLoad = await provider.getChildren(typeNode);

    expect(afterLoad.filter(c => c instanceof RecordNode)).toHaveLength(70);
    expect(afterLoad.find(c => c instanceof LoadMoreNode)).toBeUndefined();
  });

  it('fires onDidChangeTreeData after loading', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const repo = makeRepository({ records: { items: firstPage, total: 60 } });
    (repo.getRecords as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 60 })
      .mockResolvedValueOnce({ items: [makeRecord(50)], total: 60 });

    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];
    const firstChildren = await provider.getChildren(typeNode);
    const loadMoreNode = firstChildren.find(c => c instanceof LoadMoreNode) as LoadMoreNode;

    const fired: unknown[] = [];
    provider.onDidChangeTreeData(e => fired.push(e));

    await provider.loadMore(loadMoreNode);

    expect(fired).toHaveLength(1);
  });

  it('renders an ErrorNode alongside the retry affordance when a page fetch fails, preserving already-loaded items', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const repo = makeRepository({ records: { items: firstPage, total: 70 } });
    (repo.getRecords as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 70 })
      .mockRejectedValueOnce(new Error('boom'));

    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];
    const firstChildren = await provider.getChildren(typeNode);
    const loadMoreNode = firstChildren.find(c => c instanceof LoadMoreNode) as LoadMoreNode;

    await provider.loadMore(loadMoreNode);
    const afterFailure = await provider.getChildren(typeNode);

    expect(afterFailure.filter(c => c instanceof RecordNode)).toHaveLength(50);
    expect(afterFailure.find(c => c instanceof LoadMoreNode)).toBeDefined();
    const errorNode = afterFailure.find(c => c instanceof ErrorNode);
    expect(errorNode).toBeDefined();
    expect(errorNode!.tooltip).toContain('boom');
  });

  it('clears the ErrorNode on a successful retry', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const secondPage = Array.from({ length: 20 }, (_, i) => makeRecord(50 + i));
    const repo = makeRepository({ records: { items: firstPage, total: 70 } });
    (repo.getRecords as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 70 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: secondPage, total: 70 });

    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];
    const firstChildren = await provider.getChildren(typeNode);
    const loadMoreNode = firstChildren.find(c => c instanceof LoadMoreNode) as LoadMoreNode;

    await provider.loadMore(loadMoreNode);
    await provider.loadMore(loadMoreNode);
    const afterRetry = await provider.getChildren(typeNode);

    expect(afterRetry.filter(c => c instanceof RecordNode)).toHaveLength(70);
    expect(afterRetry.find(c => c instanceof LoadMoreNode)).toBeUndefined();
    expect(afterRetry.find(c => c instanceof ErrorNode)).toBeUndefined();
  });
});

// ── loadMoreInterior ────────────────────────────────────────────────────────

describe('PluginTreeProvider.loadMoreInterior', () => {
  it('renders an ErrorNode alongside the retry affordance when a page fetch fails, preserving already-loaded items', async () => {
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0 }];
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 2 })
      .mockRejectedValueOnce(new Error('boom'));

    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp');
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = firstChildren.find(c => c instanceof InteriorLoadMoreNode) as InteriorLoadMoreNode;

    await provider.loadMore(loadMoreNode);
    const afterFailure = await provider.getChildren(node);

    expect(afterFailure.filter(c => c instanceof CellNode)).toHaveLength(1);
    expect(afterFailure.find(c => c instanceof InteriorLoadMoreNode)).toBeDefined();
    const errorNode = afterFailure.find(c => c instanceof ErrorNode);
    expect(errorNode).toBeDefined();
    expect(errorNode!.tooltip).toContain('boom');
  });

  it('clears the ErrorNode on a successful retry', async () => {
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0 }];
    const secondPage = [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0 }];
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: firstPage, total: 2 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: secondPage, total: 2 });

    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp');
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = firstChildren.find(c => c instanceof InteriorLoadMoreNode) as InteriorLoadMoreNode;

    await provider.loadMore(loadMoreNode);
    await provider.loadMore(loadMoreNode);
    const afterRetry = await provider.getChildren(node);

    expect(afterRetry.filter(c => c instanceof CellNode)).toHaveLength(2);
    expect(afterRetry.find(c => c instanceof InteriorLoadMoreNode)).toBeUndefined();
    expect(afterRetry.find(c => c instanceof ErrorNode)).toBeUndefined();
  });
});

// #273: PluginNode (this provider's own standalone plugin-row node) is deleted along with its
// tests — see the comment above getPluginChildren for why. The equivalent coverage for the
// merged tree's actual plugin rows (contextValue "plugin"/"pluginImplicit", lock icon absent —
// see plugins.md) lives in PluginListProvider.test.ts.

// ── WorldspacesNode ───────────────────────────────────────────────────────────

describe('WorldspacesNode', () => {
  it('has no icon, so it sorts alphabetically alongside icon-less record-type nodes', () => {
    const node = new WorldspacesNode('M.esp');
    expect(node.iconPath).toBeUndefined();
  });
});

// ── InteriorCellsNode ─────────────────────────────────────────────────────────

describe('InteriorCellsNode', () => {
  it('has no icon, so it sorts alphabetically alongside icon-less record-type nodes', () => {
    const node = new InteriorCellsNode('M.esp');
    expect(node.iconPath).toBeUndefined();
  });

  it('labels itself "cell - Interior" to group alphabetically near "Cell" (xEdit convention)', () => {
    const node = new InteriorCellsNode('M.esp');
    expect(node.label).toBe('cell - Interior');
  });
});

// ── RecordTypeNode ────────────────────────────────────────────────────────────

describe('RecordTypeNode', () => {
  it('uses record type as label when no display name is given', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 42);
    expect(node.label).toBe('WEAP');
  });

  it('uses the xEdit display name as label, keeping recordType as the raw signature', () => {
    // Issue #110: the tree must show "Weapon", not "weap" — but recordType (used for
    // caching, commands, contextValue) stays the raw signature.
    const node = new RecordTypeNode('MyPlugin.esp', 'weap', 42, 'Weapon');
    expect(node.label).toBe('Weapon');
    expect(node.recordType).toBe('weap');
  });

  it('shows formatted count as description', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 1234);
    expect(node.description).toBe('1,234');
  });

  it('has contextValue "recordType"', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 10);
    expect(node.contextValue).toBe('recordType');
  });
});

// ── LoadMoreNode ──────────────────────────────────────────────────────────────

describe('LoadMoreNode', () => {
  it('label includes remaining count', () => {
    const parent = new RecordTypeNode('MyPlugin.esp', 'WEAP', 100);
    const node = new LoadMoreNode(parent, 43);
    expect(String(node.label)).toContain('43');
  });

  it('has contextValue "loadMore"', () => {
    const parent = new RecordTypeNode('MyPlugin.esp', 'WEAP', 100);
    const node = new LoadMoreNode(parent, 10);
    expect(node.contextValue).toBe('loadMore');
  });
});

// ── RecordNode ────────────────────────────────────────────────────────────────

describe('RecordNode', () => {
  it('wires .command to modbench.openEditor with formKey and label', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record);

    expect(node.command).toEqual({
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label: `${record.editorId} [${record.formKey}]` }],
    });
  });

  it('uses formKey alone as label when editorId is absent', () => {
    const record: RecordSummary = { ...makeRecord(0), editorId: null };
    const node = new RecordNode(record);

    const args = (node.command as { arguments: { label: string }[] }).arguments;
    expect(args[0].label).toBe(record.formKey);
  });

  it('contextValue is record', () => {
    const node = new RecordNode(makeRecord(0));
    expect(node.contextValue).toBe('record');
  });

  // #428: resourceUri is what RecordDecorationProvider keys its badge lookup on — carries the same
  // (plugin, origin, formKey) identity ADR-0036 already requires everywhere a record row is
  // addressed, via the synthetic medit-record: scheme (recordResourceUri.ts).
  it('carries a medit-record: resourceUri identifying (plugin, origin, formKey)', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record, 'ModA');

    expect(node.resourceUri).toEqual(recordResourceUri(record.plugin, 'ModA', record.formKey));
  });
});

// ── #428 Q1: a field edit flips a cached row's badge without a refetch ────────
// The orchestrator's own gate ruling: "one test that an EDIT_FIELD on a clean record flips its
// row to Modified without a full refresh (spy on the fetch path — a rival that calls
// refreshTree() wholesale would fail the no-refetch assertion)."

describe('#428 markWorkingTreeState / workingTreeStateOf (scoped, no refetch)', () => {
  it('flips a cached clean record to Modified without calling getRecords again', async () => {
    const record = makeRecord(0, 'None');
    const repo = makeRepository({ records: { items: [record], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Fallout4.esm', 'ModA') as RecordTypeNode[];
    await provider.getChildren(typeNode); // populates the page cache
    expect(repo.getRecords).toHaveBeenCalledTimes(1);

    const changed = provider.markWorkingTreeState('Fallout4.esm', 'ModA', record.formKey, 'Modified');

    expect(changed).toBe(true);
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', record.formKey)).toBe('Modified');
    // The rival this guards: a fix that re-fetches (or clears the cache and lets the next redraw
    // re-fetch) instead of patching in place would show a second call here.
    expect(repo.getRecords).toHaveBeenCalledTimes(1);

    const [rec] = await provider.getChildren(typeNode);
    expect((rec as RecordNode).record.workingTreeState).toBe('Modified');
    expect(repo.getRecords).toHaveBeenCalledTimes(1);
  });

  it('workingTreeStateOf is undefined for a record nothing has cached yet', () => {
    const provider = new PluginTreeProvider(makeRepository());
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', '000001:Fallout4.esm')).toBeUndefined();
  });

  it('markWorkingTreeState returns false, and touches nothing, for an uncached record', () => {
    const provider = new PluginTreeProvider(makeRepository());
    expect(provider.markWorkingTreeState('Fallout4.esm', 'ModA', '000001:Fallout4.esm', 'Modified')).toBe(false);
  });

  // #428 review finding 1: a create never seeds records_committed no matter how many field edits
  // follow it (the backend's own discrimination would still answer Added on the next real fetch),
  // so a field edit on an Added row must never downgrade it to Modified — that would actively
  // misrepresent a committed counterpart existing, not just go briefly stale. The rival: the
  // original unconditional overwrite (`items[idx] = { ...items[idx], workingTreeState: state }`
  // with no current-state check) fails this.
  it('preserves Added across a field edit — create, then edit, still badges A', async () => {
    const record = makeRecord(0, 'Added');
    const repo = makeRepository({ records: { items: [record], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Fallout4.esm', 'ModA') as RecordTypeNode[];
    await provider.getChildren(typeNode);

    const changed = provider.markWorkingTreeState('Fallout4.esm', 'ModA', record.formKey, 'Modified');

    expect(changed).toBe(true);
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', record.formKey)).toBe('Added');
  });
});

// ── #281: record rows carry their copy identity ──────────────────────────────
// A record-scoped command acts on the clicked row's own copy of the record — so the row has to
// say which copy it is ((plugin, origin), ADR-0036), and rows whose plugin can't be edited hide
// Remove via an immutable contextValue, matching the column header's !immutable `when` gate.

describe('#281 record rows carry their copy identity', () => {
  it('RecordNode carries the browsed origin, threaded from its RecordTypeNode', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp', 'ModA') as RecordTypeNode[];

    const [rec] = await provider.getChildren(typeNode);

    expect((rec as RecordNode).origin).toBe('ModA');
  });

  it('a shadowed copy\'s record rows are read-only: contextValue recordImmutable', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp', 'ModA') as RecordTypeNode[];

    const [rec] = await provider.getChildren(typeNode);

    expect((rec as RecordNode).contextValue).toBe('recordImmutable');
  });

  it('record rows of an immutable plugin get contextValue recordImmutable, case-insensitively', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setImmutablePlugins(new Set(['fallout4.esm'])); // makeRecord's rows belong to Fallout4.esm
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const [rec] = await provider.getChildren(typeNode);

    expect((rec as RecordNode).contextValue).toBe('recordImmutable');
  });

  it('mutable load-order rows keep contextValue record after setImmutablePlugins', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setImmutablePlugins(new Set(['SomethingElse.esm']));
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const [rec] = await provider.getChildren(typeNode);

    expect((rec as RecordNode).contextValue).toBe('record');
  });

  it('placed rows follow the same rule: refrImmutable under an immutable plugin, else refr', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const placed = { formKey: '000001:Plugin0.esp', editorId: 'ref', baseFormKey: null, recordType: 'refr' };
    provider.setImmutablePlugins(new Set(['Plugin0.esp']));

    const group = new PlacedGroupNode('Plugin0.esp', 'cell:fk', 'persistent', [placed], undefined);
    const [row] = await provider.getChildren(group) as PlacedNode[];

    expect(row.contextValue).toBe('refrImmutable');
  });

  it('placed rows of a shadowed copy are refrImmutable even when the plugin is not listed immutable', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const placed = { formKey: '000001:Plugin0.esp', editorId: 'ref', baseFormKey: null, recordType: 'refr' };

    const group = new PlacedGroupNode('Plugin0.esp', 'cell:fk', 'persistent', [placed], 'ModA');
    const [row] = await provider.getChildren(group) as PlacedNode[];

    expect(row.contextValue).toBe('refrImmutable');
  });
});

// ── refresh ───────────────────────────────────────────────────────────────────

describe('PluginTreeProvider.refresh', () => {
  it('clears cache so next getChildren re-fetches', async () => {
    const repo = makeRepository({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    await provider.getChildren(typeNode);  // fills cache
    provider.refresh();
    await provider.getChildren(typeNode);  // should re-fetch

    expect(repo.getRecords).toHaveBeenCalledTimes(2);
  });

  it('fires onDidChangeTreeData', () => {
    const provider = new PluginTreeProvider(makeRepository());

    const fired: unknown[] = [];
    provider.onDidChangeTreeData(e => fired.push(e));
    provider.refresh();

    expect(fired).toHaveLength(1);
  });
});

// ── Phase 16: worldspace / cell / placed-object tree ──────────────────────────

describe('PluginTreeProvider worldspace tree', () => {
  it('adds Worldspaces and Interior Cells nodes and hides spatial record types', async () => {
    const repo = makeRepository({
      recordTypes: [
        { type: 'wrld', count: 1 },
        { type: 'cell', count: 4 },
        { type: 'refr', count: 99 },
        { type: 'achr', count: 12 },
        { type: 'WEAP', count: 5 },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');
    const labels = children.map(c => c.label);

    expect(labels).toContain('Worldspaces');
    expect(labels).toContain('cell - Interior');
    expect(labels).toContain('WEAP');
    expect(labels).not.toContain('refr');
    expect(labels).not.toContain('achr');
    expect(labels).not.toContain('cell');
    expect(labels).not.toContain('wrld');
  });

  it('expands a worldspace into its TopCell and blocks', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }] });
    (repo.getWorldspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ formKey: 'wrld:M.esp', editorId: 'World' }]);
    (repo.getWorldspaceBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      topCell: { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null },
      blocks: [{ x: 0, y: 0, subBlocks: [{ x: 0, y: 0, cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5 }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);
    const [, blockNode] = wsChildren;
    const subBlocks = await provider.getChildren(blockNode);
    const cells = await provider.getChildren(subBlocks[0]);

    expect(wsChildren).toHaveLength(2); // TopCell + 1 block
    expect((cells[0] as CellNode).cell.cellX).toBe(12);
    expect(cells[0].label).toBe('Cell (12, -5)');
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeRepository();
    (repo.getCellReferences as ReturnType<typeof vi.fn>).mockResolvedValue({
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr' }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const cellNode = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0 });

    const groups = await provider.getChildren(cellNode);
    expect(groups).toHaveLength(1); // only persistent (temporary empty)
    expect(groups[0].label).toBe('Persistent');

    const placed = await provider.getChildren(groups[0]);
    expect(placed).toHaveLength(1);
    expect(placed[0].label).toBe('barrelRef [REFR:b]');
  });

  it('paginates interior cells with a load-more node', async () => {
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0 }],
      total: 60,
    });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp');

    const children = await provider.getChildren(node);
    expect(children.filter(c => c instanceof CellNode)).toHaveLength(1);
    expect(children.filter(c => c instanceof InteriorLoadMoreNode)).toHaveLength(1);
  });
});

// ── Fetch failures render an error node instead of an empty list (ADR-0026) ──

describe('PluginTreeProvider fetch failures', () => {
  // #273: fetchPlugins (this provider's own root listing) is deleted along with the standalone
  // tree that was its only caller — its error-path test (getPlugins rejects) goes with it.
  // getPluginChildren's own error path is covered just below.

  // #270: the merged Plugins tree's rows are Mod Management's, not this provider's, so it needs a
  // way in that starts from a plugin filename rather than from a PluginNode this provider built.
  it('getPluginChildren: builds a plugin\'s children from its filename alone', async () => {
    const repo = makeRepository({
      recordTypes: [
        { type: 'wrld', count: 1 },
        { type: 'cell', count: 4 },
        { type: 'refr', count: 99 },
        { type: 'WEAP', count: 5 },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    // #34: origin rides along as undefined for an ordinary load-order row — the backend resolves
    // it from the load order, where one filename names one plugin.
    expect(repo.getRecordTypes).toHaveBeenCalledWith('Plugin0.esp', undefined);
    expect(children.map(c => c.label)).toEqual(['Worldspaces', 'cell - Interior', 'WEAP']);
  });

  // #270 AC4: a record reached by expanding a load-order row opens the editor the same way one
  // reached through this tree does — it is the same node, carrying its own command, so the
  // merged tree inherits the behaviour rather than re-implementing it.
  it('getPluginChildren: records below it carry the open-editor command', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const [recordType] = await provider.getPluginChildren('Plugin0.esp');

    const [record] = await provider.getChildren(recordType);

    expect((record as RecordNode).command).toMatchObject({ command: 'modbench.openEditor' });
  });

  it('getPluginChildren: renders an error node when getRecordTypes fails', async () => {
    const repo = { ...makeRepository(), getRecordTypes: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  // #273: this test duplicated 'getPluginChildren: renders an error node when getRecordTypes
  // fails' above through the now-deleted getChildren(undefined) entry point — same error path,
  // same assertion, reached the only way production reaches it now.

  it('fetchRecords: renders an error node when getRecords fails', async () => {
    const repo = { ...makeRepository(), getRecords: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);
    const node = new RecordTypeNode('Plugin0.esp', 'WEAP', 5);

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaces: renders an error node when getWorldspaces fails', async () => {
    const repo = { ...makeRepository(), getWorldspaces: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspacesNode('Plugin0.esp');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaceChildren: renders an error node when getWorldspaceBlocks fails', async () => {
    const repo = { ...makeRepository(), getWorldspaceBlocks: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Plugin0.esp', { formKey: 'wrld:M.esp', editorId: 'World' });

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchCellGroups: renders an error node when getCellReferences fails', async () => {
    const repo = { ...makeRepository(), getCellReferences: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0 });

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchInteriorCells: renders an error node when getInteriorCells fails', async () => {
    const repo = { ...makeRepository(), getInteriorCells: vi.fn().mockRejectedValue(new Error('boom')) };
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });
});

// ── headerFormKeyFor (Issue #1 slice A1) ───────────────────────────────────────

describe('headerFormKeyFor', () => {
  it('builds the synthetic header FormKey for a plugin name', () => {
    expect(headerFormKeyFor('Fallout4.esm')).toBe('000000:Fallout4.esm');
  });

  it('uses the plugin name verbatim, including its extension', () => {
    expect(headerFormKeyFor('MyPatch.esp')).toBe('000000:MyPatch.esp');
  });
});

// ── spatial node chain carries origin (#305 / ADR-0036) ────────────────────────
// The chain WorldspacesNode → WorldspaceNode → BlockNode → SubBlockNode → CellNode →
// PlacedGroupNode → PlacedNode, plus InteriorCellsNode → CellNode, must carry the origin a
// specific copy's row was built with all the way down — otherwise a node two hops from the root
// silently reverts to browsing the load-order winner instead of the copy the user opened.

describe('PluginTreeProvider spatial origin threading (#305)', () => {
  it('fetchWorldspaces: asks the repository for the node\'s own copy, and the WorldspaceNodes it builds carry that origin forward', async () => {
    const repo = makeRepository();
    (repo.getWorldspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ formKey: 'wrld:M.esp', editorId: 'World' }]);
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspacesNode('Shared.esp', 'ModB');

    const [wsNode] = await provider.getChildren(node) as WorldspaceNode[];

    expect(repo.getWorldspaces).toHaveBeenCalledWith('Shared.esp', 'ModB');
    expect(wsNode.origin).toBe('ModB');
  });

  it('fetchWorldspaceChildren: asks the repository for the node\'s own copy, and its TopCell/Block children carry that origin forward', async () => {
    const repo = makeRepository();
    (repo.getWorldspaceBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      topCell: { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null },
      blocks: [{ x: 0, y: 0, subBlocks: [{ x: 0, y: 0, cells: [{ formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5 }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Shared.esp', { formKey: 'wrld:M.esp', editorId: 'World' }, 'ModB');

    const [topCellNode, blockNode] = await provider.getChildren(node) as [CellNode, PluginTreeNode];

    expect(repo.getWorldspaceBlocks).toHaveBeenCalledWith('Shared.esp', 'wrld:M.esp', 'ModB');
    expect(topCellNode.origin).toBe('ModB');

    const [subBlockNode] = await provider.getChildren(blockNode);
    const [cellNode] = await provider.getChildren(subBlockNode) as CellNode[];
    expect((subBlockNode as SubBlockNode).origin).toBe('ModB');
    expect(cellNode.origin).toBe('ModB');
  });

  it('fetchCellGroups: asks the repository for the node\'s own copy, and its PlacedGroup/Placed children carry that origin forward', async () => {
    const repo = makeRepository();
    (repo.getCellReferences as ReturnType<typeof vi.fn>).mockResolvedValue({
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr' }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('Shared.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0 }, 'ModB');

    const [groupNode] = await provider.getChildren(node) as PlacedGroupNode[];
    expect(repo.getCellReferences).toHaveBeenCalledWith('Shared.esp', 'c:M.esp', 'ModB');
    expect(groupNode.origin).toBe('ModB');

    const [placedNode] = await provider.getChildren(groupNode) as PlacedNode[];
    expect(placedNode.origin).toBe('ModB');
  });

  it('fetchInteriorCells: asks the repository for the node\'s own copy, and the CellNodes it builds carry that origin forward', async () => {
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0 }],
      total: 1,
    });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('Shared.esp', 'ModB');

    const [cellNode] = await provider.getChildren(node) as CellNode[];

    expect(repo.getInteriorCells).toHaveBeenCalledWith('Shared.esp', 0, 50, 'ModB');
    expect(cellNode.origin).toBe('ModB');
  });

  // #305: refCache/interiorCache must be keyed by (origin, plugin), the same reason pageCache
  // already is (#34) — a cache keyed on plugin alone serves one copy's cell references / interior
  // page under the other copy's node, invisible in any test that only loads one copy.
  it('refCache: caches each copy\'s cell references separately, so one copy\'s page is never served for the other', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const cell = { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0 };
    const fromA = new CellNode('Shared.esp', cell, 'ModA');
    const fromB = new CellNode('Shared.esp', cell, 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.getCellReferences).toHaveBeenCalledTimes(2);
  });

  it('interiorCache: caches each copy\'s interior-cell page separately, so one copy\'s page is never served for the other', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const fromA = new InteriorCellsNode('Shared.esp', 'ModA');
    const fromB = new InteriorCellsNode('Shared.esp', 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.getInteriorCells).toHaveBeenCalledTimes(2);
  });

  it('loadMoreInterior: keeps asking the repository for the node\'s own copy on the next page', async () => {
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0 }], total: 2 })
      .mockResolvedValueOnce({ items: [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0 }], total: 2 });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('Shared.esp', 'ModB');
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = firstChildren.find(c => c instanceof InteriorLoadMoreNode) as InteriorLoadMoreNode;

    await provider.loadMore(loadMoreNode);

    expect(repo.getInteriorCells).toHaveBeenLastCalledWith('Shared.esp', 1, 50, 'ModB');
  });
});

// ── browsing a specific copy of a filename (#34 / ADR-0036) ────────────────────

describe('PluginTreeProvider.getPluginChildren (origin)', () => {
  it('asks the repository for the copy the row stands for', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    await provider.getPluginChildren('Shared.esp', 'ModB');

    expect(repo.getRecordTypes).toHaveBeenCalledWith('Shared.esp', 'ModB');
  });

  it('carries that copy through to its record pages', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const [typeNode] = await provider.getPluginChildren('Shared.esp', 'ModB') as RecordTypeNode[];
    await provider.getChildren(typeNode);

    expect(repo.getRecords).toHaveBeenCalledWith('Shared.esp', 'WEAP', 0, expect.any(Number), 'ModB');
  });

  it('caches each copy separately, so one copy\'s page is never served for the other', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const [fromA] = await provider.getPluginChildren('Shared.esp', 'ModA') as RecordTypeNode[];
    const [fromB] = await provider.getPluginChildren('Shared.esp', 'ModB') as RecordTypeNode[];
    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    // Two fetches, not one served from a shared "Shared.esp::WEAP" cache entry.
    expect(repo.getRecords).toHaveBeenCalledTimes(2);
  });

  it('omits origin when the row is an ordinary load-order plugin', async () => {
    // The server resolves it from the load order, which is unambiguous there — Mod Management's
    // own rows have no origin to give.
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    await provider.getPluginChildren('Plugin0.esp');

    expect(repo.getRecordTypes).toHaveBeenCalledWith('Plugin0.esp', undefined);
  });
});

describe('PluginTreeProvider.getPluginChildren (spatial nodes on a specific copy)', () => {
  // #305: the spatial routes now take an explicit origin, so a copy the load order does not name
  // is no longer omitted from spatial browsing (the ADR-0026 stopgap this replaces) — it gets its
  // own Worldspaces/Interior-cells nodes, carrying that copy's origin down the chain.
  it('still builds the spatial group nodes for a copy the load order does not name, carrying that copy\'s origin', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'cell', count: 2 }, { type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Shared.esp', 'ModB');

    const worldspaces = children.find(c => c instanceof WorldspacesNode);
    const interiorCells = children.find(c => c instanceof InteriorCellsNode);
    expect(worldspaces?.origin).toBe('ModB');
    expect(interiorCells?.origin).toBe('ModB');
    expect(children.map(c => c.label)).toEqual(
      expect.arrayContaining(['Worldspaces', 'cell - Interior', 'WEAP']),
    );
  });

  it('still builds them for an ordinary load-order plugin', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children.some(c => c instanceof WorldspacesNode)).toBe(true);
  });
});

