import { describe, it, expect, vi } from 'vitest';
import type { PluginMetadata, RecordSummary, ConflictingRecord, ContainerChildSummary } from '../ApiClient';
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
  PluginTreeProvider, RecordTypeNode, RecordNode,
  CellNode, InteriorCellsNode, InteriorLoadMoreNode,
  WorldspacesNode, WorldspaceNode, SubBlockNode, PlacedGroupNode, PlacedNode,
  StackNode, StackSourceStateNode, StackBinaryStateNode, StackPeerNode,
  ConflictsNode,
  ErrorNode, headerFormKeyFor,
} from '../PluginTreeProvider';
import type { PluginTreeNode, StackPeer } from '../PluginTreeProvider';
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
    compilePending: false,
    lastCompiledAt: null,
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
    getWorldspaceBlocks: vi.fn().mockResolvedValue({ blocks: [], topCells: [] }),
    getCellReferences: vi.fn().mockResolvedValue({ persistent: [], temporary: [] }),
    // #424: a Quest/DialogTopic row's own children — empty by default, overridden per-test below.
    getContainerChildren: vi.fn().mockResolvedValue([]),
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
    // #448: the unlisted-plugin door a Stack peer's own expansion/collapse drives.
    loadUnlistedPlugin: vi.fn().mockResolvedValue(undefined),
    unloadUnlistedPlugin: vi.fn().mockResolvedValue(undefined),
    // #364: the Conflicts node's own listing.
    getConflicts: vi.fn().mockResolvedValue([]),
    // #544: the Stack node's "Compare with winner" bulk seam.
    getPluginDelta: vi.fn().mockResolvedValue([]),
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
  it('returns a RecordNode for every record in one call', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeRepository({ records: { items: records, total: 3 } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(3);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
  });

  // #398: record-type children no longer paginate — xEdit's own record-type group nodes load
  // unconditionally in full (`vstNavInitChildren`, xeMainForm.pas: `ChildCount :=
  // Container.ElementCount`), and measurement found no meaningful cost even at the realistic
  // worst case (Fallout4.esm's own INFO records in a full FO4 load order, ~78k rows, ~500ms
  // backend query + extension-host materialization combined; docs/specs/plugins.md). This test
  // is issue #398 AC3's own check: a genuinely large count still comes back as one batch with no
  // manual step, not just "the LoadMoreNode class is gone".
  it('returns every record in one call at a large, realistic-worst-case count — no manual step', async () => {
    const count = 78_089; // Fallout4.esm's own measured INFO count in a full FO4 load order
    const records = Array.from({ length: count }, (_, i) => makeRecord(i));
    const repo = makeRepository({ records: { items: records, total: count } });
    const provider = new PluginTreeProvider(repo);
    const [typeNode] = await provider.getPluginChildren('Plugin0.esp') as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(count);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    // One call, offset 0, and a limit nowhere near the deleted 50-row PAGE_SIZE — the whole type
    // requested up front, not paged.
    expect(repo.getRecords).toHaveBeenCalledTimes(1);
    expect(repo.getRecords).toHaveBeenCalledWith('Plugin0.esp', 'WEAP', 0, expect.any(Number), undefined);
    const limitArg = (repo.getRecords as ReturnType<typeof vi.fn>).mock.calls[0][3] as number;
    expect(limitArg).toBeGreaterThan(count);
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

// ── loadMoreInterior ────────────────────────────────────────────────────────

describe('PluginTreeProvider.loadMoreInterior', () => {
  it('renders an ErrorNode alongside the retry affordance when a page fetch fails, preserving already-loaded items', async () => {
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false }];
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
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false }];
    const secondPage = [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0, isPersistentWorldspaceCell: false }];
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

// #398: LoadMoreNode (record-type pagination) is deleted along with its tests — record-type
// children load in one getChildren call now (see the large-count test above). InteriorLoadMoreNode
// is unaffected (interior-cell listing is out of scope for #398 and still paginates; see its own
// tests further down).

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

// ── Worldspace / cell / placed-object tree ──────────────────────────

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

  it('expands a worldspace into its persistent cell and blocks, labeled the way xEdit does', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }] });
    (repo.getWorldspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ formKey: 'wrld:M.esp', editorId: 'World' }]);
    (repo.getWorldspaceBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true }],
      blocks: [{ x: 0, y: 0, subBlocks: [{ x: 0, y: 0, cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5, isPersistentWorldspaceCell: false }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);
    const [topCellNode, blockNode] = wsChildren;
    const subBlocks = await provider.getChildren(blockNode);
    const cells = await provider.getChildren(subBlocks[0]);

    expect(wsChildren).toHaveLength(2); // persistent cell + 1 block
    expect(topCellNode.label).toBe('<Persistent Worldspace Cell>');
    expect(blockNode.label).toBe('Block 0, 0');
    expect(subBlocks[0].label).toBe('Sub-Block 0, 0');
    expect((cells[0] as CellNode).cell.cellX).toBe(12);
    // xEdit's StrRight right-justifies each coordinate to width 3 inside the angle brackets.
    expect(cells[0].label).toBe('< 12,  -5>');
  });

  // #497: xEdit's TwbMainRecord.GetDisplayName checks GetFullName unconditionally, before any
  // signature-specific branch — including the CELL branch's persistent-cell / grid-coordinate
  // logic. A FULL name wins over both.
  it('#497: an exterior cell with a FULL name shows it, not the grid coordinates', () => {
    const node = new CellNode('M.esp', {
      formKey: 'c:M.esp', editorId: 'TheCell', cellX: 12, cellY: -5,
      isPersistentWorldspaceCell: false, fullName: 'Sanctuary Hills',
    });
    expect(node.label).toBe('Sanctuary Hills');
  });

  it('#497: an exterior cell with no FULL name still shows the padded grid coordinates (#251, unchanged)', () => {
    const node = new CellNode('M.esp', {
      formKey: 'c:M.esp', editorId: 'TheCell', cellX: 12, cellY: -5,
      isPersistentWorldspaceCell: false, fullName: null,
    });
    expect(node.label).toBe('< 12,  -5>');
  });

  // Guard test: a plausible wrong implementation checks isPersistentWorldspaceCell before
  // fullName (the literal reading of #497's own AC #3) — but xEdit's actual GetDisplayName checks
  // GetFullName first, unconditionally, and only reaches the GroupType=1 (persistent) check when
  // FULL is empty. Confirmed by reading wbImplementation.pas directly: `Result := GetFullName; if
  // Result = '' then if ... (GetSignature = 'CELL') then begin if ... GroupType = 1 ... Result :=
  // '<Persistent Worldspace Cell>' else ...`. The persistent-check-first rival makes this fail by
  // producing '<Persistent Worldspace Cell>' instead.
  it('#497: the persistent worldspace cell with a FULL name shows the FULL name, not the placeholder', () => {
    const node = new CellNode('M.esp', {
      formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null,
      isPersistentWorldspaceCell: true, fullName: 'Sanctuary Hills',
    });
    expect(node.label).toBe('Sanctuary Hills');
  });

  it('surfaces every block-less cell row under a worldspace, not just the first (#251)', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }] });
    (repo.getWorldspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ formKey: 'wrld:M.esp', editorId: 'World' }]);
    (repo.getWorldspaceBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      topCells: [
        { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true },
        { formKey: 'stray:M.esp', editorId: 'StrayCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false },
      ],
      blocks: [],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);

    expect(wsChildren.filter(c => c instanceof CellNode)).toHaveLength(2);
    expect(wsChildren[0].label).toBe('<Persistent Worldspace Cell>');
    expect(wsChildren[1].label).toBe('StrayCell');
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeRepository();
    (repo.getCellReferences as ReturnType<typeof vi.fn>).mockResolvedValue({
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr' }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const cellNode = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null });

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
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false }],
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
    const node = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null });

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
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true }],
      blocks: [{ x: 0, y: 0, subBlocks: [{ x: 0, y: 0, cells: [{ formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false }] }] }],
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
    const node = new CellNode('Shared.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null }, 'ModB');

    const [groupNode] = await provider.getChildren(node) as PlacedGroupNode[];
    expect(repo.getCellReferences).toHaveBeenCalledWith('Shared.esp', 'c:M.esp', 'ModB');
    expect(groupNode.origin).toBe('ModB');

    const [placedNode] = await provider.getChildren(groupNode) as PlacedNode[];
    expect(placedNode.origin).toBe('ModB');
  });

  it('fetchInteriorCells: asks the repository for the node\'s own copy, and the CellNodes it builds carry that origin forward', async () => {
    const repo = makeRepository();
    (repo.getInteriorCells as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false }],
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
    const cell = { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null };
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
      .mockResolvedValueOnce({ items: [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false }], total: 2 })
      .mockResolvedValueOnce({ items: [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0, isPersistentWorldspaceCell: false }], total: 2 });
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

// ── #448: the Stack node (split (c) of #397's design record) ───────────────────

const PEER_B: StackPeer = { name: 'Shared.esp', path: '/mods/ModB/Shared.esp', origin: 'ModB' };
const PEER_C: StackPeer = { name: 'Shared.esp', path: '/mods/ModC/Shared.esp', origin: 'ModC' };

describe('PluginTreeProvider — Stack node existence & ordering (#448 AC1)', () => {
  it('is absent when getPluginChildren is called with no stack peers', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Solo.esp');

    expect(children.some(c => c instanceof StackNode)).toBe(false);
  });

  it('is absent when handed an empty peer array — never rendered empty (ADR-0026)', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Solo.esp', undefined, []);

    expect(children.some(c => c instanceof StackNode)).toBe(false);
  });

  // Rival named per the orchestrator's standing instruction: "always append the Stack node last"
  // would still pass an existence-only assertion — this is the one that actually distinguishes
  // pinned-first (the Worldspaces-node precedent) from merely present.
  it('is pinned first among children — before Worldspaces and flat record-type nodes', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Shared.esp', undefined, [PEER_B]);

    expect(children[0]).toBeInstanceOf(StackNode);
    expect(children.some(c => c instanceof WorldspacesNode)).toBe(true);
  });

  it('carries the full ordered peer list', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const [stack] = await provider.getPluginChildren('Shared.esp', undefined, [PEER_B, PEER_C]);

    expect((stack as StackNode).peers).toEqual([PEER_B, PEER_C]);
  });

  // A peer's own children recurse into getPluginChildren with its own origin (see the lazy-load
  // describe block below) — that recursive call must never grow a second, nested Stack node even
  // if a stray peers array were passed, since a Stack node is a file-level structure keyed to one
  // plugin identity, not something a peer's own browse ever has an opinion about.
  it('never nests a second Stack node under a peer\'s own children', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Shared.esp', 'ModB', [PEER_C]);

    expect(children.some(c => c instanceof StackNode)).toBe(false);
  });

  it('expanding the Stack node itself lists one StackPeerNode per peer when the winner is untracked, with no repository call', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const stack = new StackNode('Shared.esp', 'ModA', [PEER_B, PEER_C]);

    const children = await provider.getChildren(stack);

    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof StackPeerNode)).toBe(true);
    expect((children[0] as StackPeerNode).peer).toEqual(PEER_B);
    expect((children[1] as StackPeerNode).peer).toEqual(PEER_C);
    expect(repo.getRecordTypes).not.toHaveBeenCalled();
  });

  it('a peer node\'s label and description read "<plugin> — <mod>", greyed/read-only', () => {
    const node = new StackPeerNode('Shared.esp', PEER_B);

    expect(node.label).toBe('Shared.esp — ModB');
    expect(node.description).toBe('read-only');
  });
});

// ── #448 AC1/AC4: the winner's own state entries, tracked-gated ────────────────

describe('PluginTreeProvider — Stack node state entries (#448 AC1/AC4)', () => {
  it('an untracked winner gets zero state entries — the Stack node opens directly on peers', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setPluginOrigins(new Map([['shared.esp', 'ModA']])); // origin known, but never marked tracked
    const stack = new StackNode('Shared.esp', 'ModA', [PEER_B]);

    const children = await provider.getChildren(stack);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(StackPeerNode);
  });

  it('a tracked winner gets both state entries, in resolution order, ahead of every peer', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setPluginOrigins(new Map([['shared.esp', 'ModA']]));
    provider.setTrackedPlugins(new Set(['shared.esp']));
    const stack = new StackNode('Shared.esp', 'ModA', [PEER_B]);

    const children = await provider.getChildren(stack);

    expect(children).toHaveLength(3);
    expect(children[0]).toBeInstanceOf(StackSourceStateNode);
    expect(children[1]).toBeInstanceOf(StackBinaryStateNode);
    expect(children[2]).toBeInstanceOf(StackPeerNode);
    expect((children[0] as StackSourceStateNode).label).toBe('source (working tree) — ModA');
    expect((children[1] as StackBinaryStateNode).label).toBe('binary (last compile…) — ModA');
  });

  it('matches tracked/origin plugin keys case-insensitively', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setPluginOrigins(new Map([['SHARED.ESP', 'ModA']]));
    provider.setTrackedPlugins(new Set(['SHARED.ESP']));
    const stack = new StackNode('Shared.esp', 'ModA', []);

    const children = await provider.getChildren(stack);

    expect(children.filter(c => c instanceof StackSourceStateNode)).toHaveLength(1);
  });

  // A winner nothing has told this provider's origin for degrades the same way an untracked
  // winner does — never a crash, never a mislabeled entry built off an undefined origin.
  it('degrades to no state entries when the winner\'s origin is unknown, even if marked tracked', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    provider.setTrackedPlugins(new Set(['shared.esp'])); // tracked, but setPluginOrigins never called
    const stack = new StackNode('Shared.esp', undefined, [PEER_B]);

    const children = await provider.getChildren(stack);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(StackPeerNode);
  });
});

// ── #448 AC2: expanding a peer lazy-loads it read-only via the unlisted-plugin door (#34) ──────

describe('PluginTreeProvider — Stack peer lazy load & read-only browsing (#448 AC2)', () => {
  it('loads the peer through the unlisted-plugin door on first expansion, then browses its records', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);

    const children = await provider.getChildren(peerNode);

    expect(repo.loadUnlistedPlugin).toHaveBeenCalledWith(PEER_B.path, PEER_B.origin);
    expect(children.some(c => c instanceof RecordTypeNode)).toBe(true);
    expect(repo.getRecordTypes).toHaveBeenCalledWith('Shared.esp', 'ModB');
  });

  it('loads at most once per expansion streak — a second expansion skips straight to the fetch', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);

    await provider.getChildren(peerNode);
    await provider.getChildren(peerNode);

    expect(repo.loadUnlistedPlugin).toHaveBeenCalledTimes(1);
  });

  // The read-only guarantee itself already holds structurally — a peer's records recurse through
  // getPluginChildren(name, origin) with origin defined, and isImmutable(plugin, origin) already
  // treats any defined origin as immutable (#281 / ADR-0036) — so this is a regression pin on that
  // existing short-circuit covering the new caller, not new immutability logic. The rival named in
  // the plan (temporarily stripping `origin !== undefined` from isImmutable) is verified manually,
  // not committed — see the task's own report for the observed failure.
  it('a peer\'s own record rows are read-only: contextValue recordImmutable', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);
    const [typeNode] = await provider.getChildren(peerNode) as RecordTypeNode[];

    const [rec] = await provider.getChildren(typeNode);

    expect((rec as RecordNode).contextValue).toBe('recordImmutable');
  });

  it('a load failure renders an ErrorNode instead of silently showing nothing (ADR-0026)', async () => {
    const repo = makeRepository();
    (repo.loadUnlistedPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);

    const children = await provider.getChildren(peerNode);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('unloadStackPeer unloads through the door and lets a later re-expand load again', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);
    await provider.getChildren(peerNode);

    await provider.unloadStackPeer(peerNode);

    expect(repo.unloadUnlistedPlugin).toHaveBeenCalledWith(PEER_B.name, PEER_B.origin);
    await provider.getChildren(peerNode);
    expect(repo.loadUnlistedPlugin).toHaveBeenCalledTimes(2); // loaded, unloaded, re-loaded
  });

  it('unloadStackPeer is a no-op for a peer that was never expanded', async () => {
    const repo = makeRepository();
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);

    await provider.unloadStackPeer(peerNode);

    expect(repo.unloadUnlistedPlugin).not.toHaveBeenCalled();
  });

  it('refresh() forgets what was loaded, matching a fresh session that has loaded nothing yet', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const peerNode = new StackPeerNode('Shared.esp', PEER_B);
    await provider.getChildren(peerNode);

    provider.refresh();
    await provider.getChildren(peerNode);

    expect(repo.loadUnlistedPlugin).toHaveBeenCalledTimes(2);
  });
});

// ── #364: the Conflicts node (root-level, unlike Stack above which is per-plugin) ──────────────

describe('PluginTreeProvider — Conflicts node existence & gating (#364, #307\'s invariant)', () => {
  it('conflictsNode() is undefined before conflictsComputed is ever set', () => {
    const provider = new PluginTreeProvider(makeRepository());

    expect(provider.conflictsNode()).toBeUndefined();
  });

  // Rival named: "render the node but with nothing to show yet" would still return a ConflictsNode
  // instance here too — the real distinguishing check is conflictsNode() itself answering
  // undefined (the node omitted entirely), not merely "its children are empty".
  it('conflictsNode() returns a node once setConflictsComputed(true) is called', () => {
    const provider = new PluginTreeProvider(makeRepository());

    provider.setConflictsComputed(true);

    expect(provider.conflictsNode()).toBeInstanceOf(ConflictsNode);
  });

  it('conflictsNode() reverts to undefined after setConflictsComputed(false) — a stale session must not keep showing it', () => {
    const provider = new PluginTreeProvider(makeRepository());
    provider.setConflictsComputed(true);

    provider.setConflictsComputed(false);

    expect(provider.conflictsNode()).toBeUndefined();
  });

  it('setConflictsComputed fires onDidChangeTreeData so the root re-renders', () => {
    const provider = new PluginTreeProvider(makeRepository());
    const fired: unknown[] = [];
    provider.onDidChangeTreeData(e => fired.push(e));

    provider.setConflictsComputed(true);

    expect(fired).toHaveLength(1);
  });
});

describe('PluginTreeProvider.getChildren(ConflictsNode) (#364)', () => {
  it('fetches from repository.getConflicts and returns one RecordNode per entry', async () => {
    const record = makeRecord(5);
    const repo = makeRepository();
    repo.getConflicts = vi.fn().mockResolvedValue([{ record, origin: 'Data', conflictAll: 'Conflict' }]);
    const provider = new PluginTreeProvider(repo);
    provider.setConflictsComputed(true);

    const children = await provider.getChildren(provider.conflictsNode());

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(RecordNode);
    expect((children[0] as RecordNode).record.formKey).toBe(record.formKey);
  });

  it('renders an error node when getConflicts fails, matching every other fetch failure in this file', async () => {
    const repo = makeRepository();
    repo.getConflicts = vi.fn().mockRejectedValue(new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    provider.setConflictsComputed(true);

    const children = await provider.getChildren(provider.conflictsNode());

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });
});

describe('PluginTreeProvider.conflictAllOf (#364, the badge\'s own lookup)', () => {
  // Rival named — the literal #307 failure mode given a concrete implementation to fail against:
  // "keep serving the cached value regardless of conflictsComputed" would return 'Conflict' here
  // instead of undefined, indistinguishable from a badge that never gates on the flag at all.
  //
  // This has to be a genuine race, not just setConflictsComputed(false) followed by a read —
  // setConflictsComputed(false) already clears conflictAllCache itself, so a test that only calls
  // it and then reads would pass even with conflictAllOf's own gate deleted (confirmed: writing
  // that version first and running it, it stayed green with the gate removed — vacuous, exactly
  // the trap the standing instruction warns about). The real scenario the gate exists for is an
  // in-flight getConflicts() call that resolves *after* conflictsComputed has already gone back to
  // false — ADR-0035's live-mutation re-sweep racing a still-pending Conflicts-node fetch — which
  // populates the cache post-clear with nothing left to clear it again. Only conflictAllOf's own
  // independent check catches that.
  it('returns undefined for a late-arriving cache entry — a getConflicts() call still in flight when conflictsComputed goes back to false', async () => {
    const record = makeRecord(5);
    let resolveFetch!: (v: ConflictingRecord[]) => void;
    const repo = makeRepository();
    repo.getConflicts = vi.fn(() => new Promise<ConflictingRecord[]>((resolve) => { resolveFetch = resolve; }));
    const provider = new PluginTreeProvider(repo);
    provider.setConflictsComputed(true);
    const fetchPromise = provider.getChildren(provider.conflictsNode()); // in flight, not yet resolved

    provider.setConflictsComputed(false); // clears the (still-empty) cache; flag now false
    resolveFetch([{ record, origin: 'Data', conflictAll: 'Conflict' }]); // lands late, populates the cache anyway
    await fetchPromise;

    expect(provider.conflictAllOf(record.plugin, 'Data', record.formKey)).toBeUndefined();
  });

  it('returns the cached ConflictAll once computed and fetched', async () => {
    const record = makeRecord(5);
    const repo = makeRepository();
    repo.getConflicts = vi.fn().mockResolvedValue([{ record, origin: 'Data', conflictAll: 'Conflict' }]);
    const provider = new PluginTreeProvider(repo);
    provider.setConflictsComputed(true);
    await provider.getChildren(provider.conflictsNode());

    expect(provider.conflictAllOf(record.plugin, 'Data', record.formKey)).toBe('Conflict');
  });

  it('returns undefined for a record nothing has fetched yet, even once computed', () => {
    const provider = new PluginTreeProvider(makeRepository());
    provider.setConflictsComputed(true);

    expect(provider.conflictAllOf('Never.esp', 'Data', 'DEADBE:Never.esp')).toBeUndefined();
  });
});

// ── #424: Quest/DialogTopic child records ──────────────────────────────────────

function makeContainerChild(
  formKey: string, recordType: string, editorId: string | null = null,
): ContainerChildSummary {
  return {
    formKey, editorId, plugin: 'Fallout4.esm', origin: 'Data',
    loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', recordType,
  };
}

describe('RecordNode collapsibility for container types (#424)', () => {
  // Rival named: today's actual RecordNode always constructs CollapsibleState.None regardless of
  // record type — this pins the change against exactly that rival.
  it('is Collapsed when built as a "qust" row', () => {
    const node = new RecordNode(makeRecord(0), undefined, false, false, 'qust');
    expect(node.collapsibleState).toBe(1); // TreeItemCollapsibleState.Collapsed (mocked to 1 above)
  });

  it('is Collapsed when built as a "dial" row', () => {
    const node = new RecordNode(makeRecord(0), undefined, false, false, 'dial');
    expect(node.collapsibleState).toBe(1);
  });

  it('stays None (a leaf) when no containerChildType is given, as every other record type does', () => {
    const node = new RecordNode(makeRecord(0));
    expect(node.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });
});

describe('PluginTreeProvider.getChildren(RecordNode) — container children (#424)', () => {
  it('a "qust" RecordNode expands via repository.getContainerChildren into ordinary RecordNodes', async () => {
    const repo = makeRepository();
    repo.getContainerChildren = vi.fn().mockResolvedValue([
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'),
      makeContainerChild('dlbr1:Fallout4.esm', 'dlbr', 'BranchA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, false, false, 'qust');

    const children = await provider.getChildren(questNode);

    expect(repo.getContainerChildren).toHaveBeenCalledWith('Fallout4.esm', 'qust1:Fallout4.esm', undefined);
    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    expect((children[0] as RecordNode).record.editorId).toBe('TopicA');
    // Standard record-row affordances (#281 unification) — same command every ordinary
    // RecordNode gets, so a container child opens in the record editor exactly like any other row.
    expect((children[0] as RecordNode).command).toMatchObject({ command: 'modbench.openEditor' });
  });

  it('a returned "dial" child is itself Collapsed — expandable to its own Responses', async () => {
    const repo = makeRepository();
    repo.getContainerChildren = vi.fn().mockResolvedValue([
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'),
      makeContainerChild('scen1:Fallout4.esm', 'scen', 'SceneA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, false, false, 'qust');

    const children = await provider.getChildren(questNode) as RecordNode[];

    const dialChild = children.find(c => c.record.formKey === 'dial1:Fallout4.esm')!;
    const scenChild = children.find(c => c.record.formKey === 'scen1:Fallout4.esm')!;
    expect(dialChild.collapsibleState).toBe(1); // Collapsed — a nested "dial" is a container too
    expect(scenChild.collapsibleState).toBe(0); // None — a Scene is always a leaf
  });

  it('a "dial" RecordNode expands via repository.getContainerChildren into its Responses', async () => {
    const repo = makeRepository();
    repo.getContainerChildren = vi.fn().mockResolvedValue([
      makeContainerChild('info1:Fallout4.esm', 'info'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const topicNode = new RecordNode(
      { ...makeRecord(0), formKey: 'dial1:Fallout4.esm' }, undefined, false, false, 'dial');

    const children = await provider.getChildren(topicNode);

    expect(repo.getContainerChildren).toHaveBeenCalledWith('Fallout4.esm', 'dial1:Fallout4.esm', undefined);
    expect(children).toHaveLength(1);
  });

  it('caches on second expand without re-fetching', async () => {
    const repo = makeRepository();
    repo.getContainerChildren = vi.fn().mockResolvedValue([makeContainerChild('dial1:Fallout4.esm', 'dial')]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, false, false, 'qust');

    await provider.getChildren(questNode);
    await provider.getChildren(questNode);

    expect(repo.getContainerChildren).toHaveBeenCalledTimes(1);
  });

  // #305 precedent: two same-filename plugin copies expanding the same Quest FormKey must hit
  // their own repository call / cache entry — a cache key that omits origin is the exact
  // regression class #305 already fixed for the rest of this spatial chain. Rival: a cache key
  // built from formKey alone (no origin component) would return ModA's cached children for ModB's
  // expansion instead of issuing its own call.
  it('origin-keyed caching: two copies of one plugin browse their own children independently', async () => {
    const repo = makeRepository();
    repo.getContainerChildren = vi.fn()
      .mockResolvedValueOnce([makeContainerChild('dial-a:Shared.esp', 'dial', 'TopicModA')])
      .mockResolvedValueOnce([makeContainerChild('dial-b:Shared.esp', 'dial', 'TopicModB')]);
    const provider = new PluginTreeProvider(repo);
    const questA = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModA', false, false, 'qust');
    const questB = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModB', false, false, 'qust');

    const childrenA = await provider.getChildren(questA) as RecordNode[];
    const childrenB = await provider.getChildren(questB) as RecordNode[];

    expect(repo.getContainerChildren).toHaveBeenCalledTimes(2);
    expect(repo.getContainerChildren).toHaveBeenNthCalledWith(1, 'Shared.esp', 'qust1:Shared.esp', 'ModA');
    expect(repo.getContainerChildren).toHaveBeenNthCalledWith(2, 'Shared.esp', 'qust1:Shared.esp', 'ModB');
    expect(childrenA[0].record.editorId).toBe('TopicModA');
    expect(childrenB[0].record.editorId).toBe('TopicModB');
  });
});

