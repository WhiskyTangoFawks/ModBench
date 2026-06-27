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
  PluginTreeProvider, PluginNode, RecordTypeNode, RecordNode, LoadMoreNode,
  CellNode, InteriorCellsNode, InteriorLoadMoreNode,
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
  recordTypes: { type: string; count: number }[];
  records: RecordPage;
}> = {}): PluginRepository {
  return {
    getPlugins: vi.fn().mockResolvedValue(overrides.plugins ?? [makePlugin(0), makePlugin(1)]),
    getRecordTypes: vi.fn().mockResolvedValue(overrides.recordTypes ?? [{ type: 'WEAP', count: 5 }]),
    getRecords: vi.fn().mockResolvedValue(overrides.records ?? { items: [makeRecord(0)], total: 1 }),
    setFilter: vi.fn().mockResolvedValue(null),
    clearFilter: vi.fn().mockResolvedValue(undefined),
    getActiveFilter: vi.fn().mockResolvedValue(null),
    getWorldspaces: vi.fn().mockResolvedValue([]),
    getWorldspaceBlocks: vi.fn().mockResolvedValue({ blocks: [], topCell: null }),
    getCellReferences: vi.fn().mockResolvedValue({ persistent: [], temporary: [] }),
    getInteriorCells: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
}

// ── getChildren(root) ─────────────────────────────────────────────────────────

describe('PluginTreeProvider.getChildren(root)', () => {
  it('returns one PluginNode per plugin', async () => {
    const repo = makeRepository({ plugins: [makePlugin(0), makePlugin(1), makePlugin(2)] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getChildren(undefined);

    expect(children).toHaveLength(3);
    expect(children.every(c => c instanceof PluginNode)).toBe(true);
    expect((children[0] as PluginNode).plugin.name).toBe('Plugin0.esp');
  });

  it('returns empty array when no plugins exist', async () => {
    const repo = makeRepository({ plugins: [] });
    const provider = new PluginTreeProvider(repo);

    expect(await provider.getChildren(undefined)).toEqual([]);
  });
});

// ── getChildren(PluginNode) ───────────────────────────────────────────────────

describe('PluginTreeProvider.getChildren(PluginNode)', () => {
  it('returns one RecordTypeNode per record type', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'WEAP', count: 10 }, { type: 'NPC_', count: 3 }] });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];

    const children = await provider.getChildren(pluginNode);

    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordTypeNode)).toBe(true);
    expect((children[0] as RecordTypeNode).recordType).toBe('WEAP');
  });
});

// ── getChildren(RecordTypeNode) ───────────────────────────────────────────────

describe('PluginTreeProvider.getChildren(RecordTypeNode)', () => {
  it('returns RecordNodes for each record in the first page', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeRepository({ records: { items: records, total: 3 } });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children.filter(c => c instanceof RecordNode)).toHaveLength(3);
    expect(children.filter(c => c instanceof LoadMoreNode)).toHaveLength(0);
  });

  it('appends LoadMoreNode when total exceeds loaded count', async () => {
    const records = Array.from({ length: 50 }, (_, i) => makeRecord(i));
    const repo = makeRepository({ records: { items: records, total: 120 } });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];

    const children = await provider.getChildren(typeNode);

    expect(children.filter(c => c instanceof RecordNode)).toHaveLength(50);
    const loadMore = children.find(c => c instanceof LoadMoreNode) as LoadMoreNode;
    expect(loadMore).toBeDefined();
    expect(loadMore.parentNode).toBe(typeNode);
  });

  it('uses cache on second expand without re-fetching', async () => {
    const repo = makeRepository({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];

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
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];
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
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];
    const firstChildren = await provider.getChildren(typeNode);
    const loadMoreNode = firstChildren.find(c => c instanceof LoadMoreNode) as LoadMoreNode;

    const fired: unknown[] = [];
    provider.onDidChangeTreeData(e => fired.push(e));

    await provider.loadMore(loadMoreNode);

    expect(fired).toHaveLength(1);
  });
});

// ── PluginNode ────────────────────────────────────────────────────────────────

describe('PluginNode', () => {
  it('has contextValue "plugin" for mutable plugins', () => {
    const node = new PluginNode({ ...makePlugin(0), isImmutable: false });
    expect(node.contextValue).toBe('plugin');
  });

  it('has contextValue "pluginImmutable" for immutable plugins', () => {
    const node = new PluginNode({ ...makePlugin(0), isImmutable: true });
    expect(node.contextValue).toBe('pluginImmutable');
  });

  it('uses plugin name as label', () => {
    const node = new PluginNode(makePlugin(2));
    expect(node.label).toBe('Plugin2.esp');
  });

  it('formats description as "[index] count records"', () => {
    const plugin = { ...makePlugin(0), loadOrderIndex: 3, recordCount: 1500 };
    const node = new PluginNode(plugin);
    expect(node.description).toBe('[3] 1,500 records');
  });

  it('has a lock ThemeIcon for immutable plugins', () => {
    const node = new PluginNode({ ...makePlugin(0), isImmutable: true });
    expect((node.iconPath as { id: string }).id).toBe('lock');
  });

  it('has no icon for mutable plugins', () => {
    const node = new PluginNode({ ...makePlugin(0), isImmutable: false });
    expect(node.iconPath).toBeUndefined();
  });
});

// ── RecordTypeNode ────────────────────────────────────────────────────────────

describe('RecordTypeNode', () => {
  it('uses record type as label', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 42);
    expect(node.label).toBe('WEAP');
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
  it('wires .command to mEdit.openEditor with formKey and label', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record);

    expect(node.command).toEqual({
      command: 'mEdit.openEditor',
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
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [typeNode] = await provider.getChildren(pluginNode) as RecordTypeNode[];

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
        { type: 'worldspace', count: 1 },
        { type: 'cell', count: 4 },
        { type: 'refr', count: 99 },
        { type: 'WEAP', count: 5 },
      ],
    });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];

    const children = await provider.getChildren(pluginNode);
    const labels = children.map(c => c.label);

    expect(labels).toContain('Worldspaces');
    expect(labels).toContain('Interior Cells');
    expect(labels).toContain('WEAP');
    expect(labels).not.toContain('refr');
    expect(labels).not.toContain('cell');
    expect(labels).not.toContain('worldspace');
  });

  it('expands a worldspace into its TopCell and blocks', async () => {
    const repo = makeRepository({ recordTypes: [{ type: 'worldspace', count: 1 }] });
    (repo.getWorldspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ formKey: 'wrld:M.esp', editorId: 'World' }]);
    (repo.getWorldspaceBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      topCell: { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null },
      blocks: [{ x: 0, y: 0, subBlocks: [{ x: 0, y: 0, cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5 }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const [pluginNode] = await provider.getChildren(undefined) as PluginNode[];
    const [wsRoot] = await provider.getChildren(pluginNode);
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
