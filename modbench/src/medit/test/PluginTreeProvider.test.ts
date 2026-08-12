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
}));

import {
  PluginTreeProvider, RecordTypeNode, RecordNode, LoadMoreNode,
  CellNode, InteriorCellsNode, InteriorLoadMoreNode,
  WorldspacesNode, WorldspaceNode, ErrorNode, headerFormKeyFor,
} from '../PluginTreeProvider';

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
  };
}

function makeRecord(i: number): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`,
    plugin: 'Fallout4.esm',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
  };
}

function makeRepository(overrides: Partial<{
  plugins: PluginMetadata[];
  recordTypes: { type: string; count: number; displayName?: string }[];
  records: RecordPage;
}> = {}): PluginRepository {
  return {
    getPlugins: vi.fn().mockResolvedValue(overrides.plugins ?? [makePlugin(0), makePlugin(1)]),
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
    getInteriorCells: vi.fn().mockResolvedValue({ items: [], total: 0 }),
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

    expect(repo.getRecordTypes).toHaveBeenCalledWith('Plugin0.esp');
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
