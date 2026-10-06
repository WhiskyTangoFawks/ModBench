import { describe, it, expect, vi } from 'vitest';
import {
  type RecordSummary, type ContainerChildSummary, type RecordPage, type CellSummary, type InteriorCellBlock,
} from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import {
  PluginTreeProvider, RecordTypeNode, RecordNode,
  CellNode, InteriorBlockNode, InteriorSubBlockNode,
  WorldspaceNode, SubBlockNode, ChildRecordGroupNode, ChildRecordNode,
} from '../PluginTreeProvider';
import { ErrorNode } from '../../drivingLib/errorNode';
import type { PluginTreeNode } from '../PluginTreeProvider';
import type { PluginConditions } from '../pluginFacts';
import { recordResourceUri } from '../recordResourceUri';
import type { PluginAddress } from '../../wire/pluginAddress';
import { expectInstanceOf, expectInstanceOfOrUndefined, expectInstancesOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';
import { listsForThePluginAsked, recordTypeCountFixture } from '../../client/test/fixtures';

function makeRecord(
  i: number, workingTreeState: RecordSummary['workingTreeState'] = 'None', hasContainerChildren = false,
): RecordSummary {
  return {
    formKey: `${String(i).padStart(6, '0')}:Fallout4.esm`,
    plugin: 'Plugin0.esp',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
    origin: 'Data',
    workingTreeState,
    hasContainerChildren,
    hasParseFailure: false,
  };
}

function makeClient(overrides: Partial<{
  recordTypes: { type: string; count: number; displayName?: string; hasParseFailure?: boolean; isCreatable?: boolean }[];
  records: RecordPage;
}> = {}): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  const recordTypes = overrides.recordTypes ?? [{ type: 'weap', count: 5, displayName: 'Weapon' }];
  client.setQueryAnswer('getRecordTypes', recordTypes.map((rt) => ({
    type: rt.type, count: rt.count, displayName: rt.displayName ?? rt.type, hasParseFailure: rt.hasParseFailure ?? false,
    isCreatable: rt.isCreatable ?? true, isContainer: false,
  })));
  client.setQueryAnswer('getRecords', overrides.records ?? { items: [makeRecord(0)], total: 1 });
  client.setQueryAnswer('getWorldspaces', []);
  client.setQueryAnswer('getWorldspaceBlocks', { blocks: [], topCells: [] });
  client.setQueryAnswer('getCellChildRecords', { persistent: [], temporary: [] });
  client.setQueryAnswer('getContainerChildren', []);
  client.setQueryAnswer('getInteriorCells', []);
  return client;
}

function group(type: 'wrld' | 'cell', plugin: string, origin: string, count = 0): RecordTypeNode {
  return new RecordTypeNode(plugin, recordTypeCountFixture({ type, count }), origin);
}

function interiorCell(formKey: string, editorId: string | null, overrides: Partial<CellSummary> = {}): CellSummary {
  return {
    formKey, editorId, cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false,
    ...overrides,
  };
}

function oneSubBlock(cells: CellSummary[], block = 0, subBlock = 0): InteriorCellBlock[] {
  const hasParseFailure = cells.some(c => c.hasParseFailure);
  return [{ number: block, hasParseFailure, subBlocks: [{ number: subBlock, hasParseFailure, cells }] }];
}

async function interiorCellsBeneath(provider: PluginTreeProvider, cellGroup: PluginTreeNode): Promise<PluginTreeNode[]> {
  const [block] = await provider.getChildren(cellGroup);
  const [subBlock] = await provider.getChildren(present(block, 'the sole block'));
  return provider.getChildren(present(subBlock, 'the sole sub-block'));
}

async function rowsBeneath(
  provider: PluginTreeProvider, plugin: PluginAddress, told: PluginConditions,
): Promise<PluginTreeNode[]> {
  const states: PluginTreeNode[] = [];
  const walk = async (nodes: readonly PluginTreeNode[]): Promise<void> => {
    for (const node of nodes) {
      if (['recordType', 'record', 'worldspace', 'cell', 'placed'].includes(node.kind)) states.push(node);
      const leaf = node.kind === 'placed' || (node instanceof RecordNode && !node.hasContainerChildren);
      if (!leaf) await walk(await provider.getChildren(node));
    }
  };
  await walk(await provider.getPluginChildren(plugin, told));
  return states;
}

describe('PluginTreeProvider.getPluginChildren (record types)', () => {
  it('returns one RecordTypeNode per record type', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'weap', count: 10 }, { type: 'npc_', count: 3 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });

    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordTypeNode)).toBe(true);
    expect(expectInstanceOf(children[0], RecordTypeNode).recordType).toBe('weap');
  });

  it('renders the xEdit display name as the label, not the raw signature', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'acti', count: 10, displayName: 'Activator' }],
    });
    const provider = new PluginTreeProvider(repo);

    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    expect(typeNode.label).toBe('Activator');
    expect(typeNode.recordType).toBe('acti');
  });

  it('carries the backend\'s isCreatable verdict onto the group\'s contextValue', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'npc_', count: 1, isCreatable: true },
        { type: 'qust', count: 1, isCreatable: false },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const [npc, qust] = expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode);

    expect(present(npc, 'the npc_ group').contextValue).toContain('creatable');
    expect(present(qust, 'the qust group').contextValue).not.toContain('creatable');
  });

  it('builds the Worldspace and Cell groups as record-type groups of their type, so they offer create as any group does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'cell', count: 2 }] });
    const provider = new PluginTreeProvider(repo);

    const groups = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }, { tracked: true, editable: true });

    expect(groups.map(g => [g.kind, g instanceof RecordTypeNode && g.recordType, g.contextValue])).toEqual([
      ['recordType', 'wrld', 'recordType tracked editable creatable'],
      ['recordType', 'cell', 'recordType tracked editable creatable'],
    ]);
  });
});

describe('PluginTreeProvider.getChildren(RecordTypeNode)', () => {
  it('returns a RecordNode for every record in one call', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeClient({ records: { items: records, total: 3 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(3);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
  });

  it('returns every record in one call at a large, realistic-worst-case count, as xEdit\'s record-type group nodes load in full', async () => {
    const FALLOUT4_ESM_INFO_COUNT = 78_089;
    const records = Array.from({ length: FALLOUT4_ESM_INFO_COUNT }, (_, i) => makeRecord(i));
    const repo = makeClient({ records: { items: records, total: FALLOUT4_ESM_INFO_COUNT } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(FALLOUT4_ESM_INFO_COUNT);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls).toContainEqual({ method: 'getRecords', args: [{ name: 'Plugin0.esp', origin: 'Data' }, 'weap', 0, expect.any(Number)] });
    const limitArg = present(repo.calls.find(c => c.method === 'getRecords'), 'the getRecords call').args[3];
    if (typeof limitArg !== 'number') throw new Error(`Expected a number, got ${String(limitArg)}`);
    expect(limitArg).toBeGreaterThan(FALLOUT4_ESM_INFO_COUNT);
  });

  it('a "qust" row\'s collapsible state follows its own RecordSummary.hasContainerChildren, not its record type alone', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'qust', count: 2 }],
      records: {
        items: [
          { ...makeRecord(0, 'None', true), formKey: 'qustWithChildren:Fallout4.esm' },
          { ...makeRecord(1, 'None', false), formKey: 'qustWithoutChildren:Fallout4.esm' },
        ],
        total: 2,
      },
    });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = expectInstancesOf(await provider.getChildren(typeNode), RecordNode);

    const withChildren = present(children.find(c => c.record.formKey === 'qustWithChildren:Fallout4.esm'), 'the qustWithChildren row');
    const withoutChildren = present(children.find(c => c.record.formKey === 'qustWithoutChildren:Fallout4.esm'), 'the qustWithoutChildren row');
    expect(withChildren.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(withoutChildren.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });
});

describe('PluginTreeProvider.getChildren(RecordTypeNode) — no per-row fan-out for container presence', () => {
  it('listing ~1,300 Quests issues exactly one getRecords call and zero getContainerChildren calls', async () => {
    const FALLOUT4_ESM_APPROXIMATE_QUST_COUNT = 1_300;
    const records = Array.from(
      { length: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT }, (_, i) => makeRecord(i, 'None', i % 2 === 0));
    const repo = makeClient({ recordTypes: [{ type: 'qust', count: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT }], records: { items: records, total: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(FALLOUT4_ESM_APPROXIMATE_QUST_COUNT);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls.some(c => c.method === 'getContainerChildren')).toBe(false);
  });
});

describe('RecordTypeNode', () => {
  it('uses the xEdit display name as label, keeping recordType as the raw signature', () => {
    const node = new RecordTypeNode('MyPlugin.esp', recordTypeCountFixture({ type: 'weap', count: 42, displayName: 'Weapon' }), 'Data');
    expect(node.label).toBe('Weapon');
    expect(node.recordType).toBe('weap');
  });

  it('shows formatted count as description', () => {
    const node = new RecordTypeNode('MyPlugin.esp', recordTypeCountFixture({ type: 'weap', count: 1234 }), 'Data');
    expect(node.description).toBe('1,234');
  });

  it('states no record edit when no one has described its plugin', () => {
    const node = new RecordTypeNode('MyPlugin.esp', recordTypeCountFixture({ type: 'weap', count: 10 }), 'Data');
    expect(node.contextValue).toBe('recordType untracked creatable');
  });

  it('states no create on a container type\'s group (a quest, say)', () => {
    const node = new RecordTypeNode('MyPlugin.esp', recordTypeCountFixture({ type: 'qust', count: 3, displayName: 'Quest', isCreatable: false }), 'Data');
    expect(node.contextValue).toBe('recordType untracked');
  });
});

describe('RecordNode', () => {
  it('wires .command to modbench.record.open with its formKey alone', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record, 'Data');

    expect(node.command).toEqual({
      command: 'modbench.record.open',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey }],
    });
  });

  it('states a record of a tracked plugin', () => {
    const node = new RecordNode(makeRecord(0), 'Data', { tracked: true, editable: true });
    expect(node.contextValue).toBe('record tracked editable');
  });

  it('states a record of an untracked plugin', () => {
    const node = new RecordNode(makeRecord(0), 'Data', { tracked: false, editable: true });
    expect(node.contextValue).toBe('record untracked editable');
  });

  it('states an override as it states the plugin\'s own records', () => {
    const record: RecordSummary = { ...makeRecord(0), plugin: 'PatchMod.esp' };
    expect(new RecordNode(record, 'Data', { tracked: true, editable: true }).contextValue).toBe('record tracked editable');
  });

  it('states a record of an immutable plugin read-only', () => {
    const node = new RecordNode(makeRecord(0), 'Data', { tracked: false, editable: false });
    expect(node.contextValue).toBe('record untracked');
  });

  it('offers no record edit on a row whose plugin no caller has described', () => {
    expect(new RecordNode(makeRecord(0), 'Data').contextValue).toBe('record untracked');
  });

  it('carries a medit-record: resourceUri identifying (plugin, origin, formKey)', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record, 'ModA');

    expect(node.resourceUri).toEqual(recordResourceUri({ name: record.plugin, origin: 'ModA' }, record.formKey));
  });
});

describe('onDidReadRecords / workingTreeStateOf', () => {
  async function readGroup(repo: InMemoryMEditClient) {
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const read: (readonly unknown[])[] = [];
    provider.onDidReadRecords((uris) => read.push(uris));
    return { provider, typeNode, read };
  }

  it('names each row of a group it reads from mEdit, by the row\'s own resource URI', async () => {
    const record = makeRecord(0, 'Modified');
    const { provider, typeNode, read } = await readGroup(makeClient({ records: { items: [record], total: 1 } }));

    const [row] = await provider.getChildren(typeNode);

    expect(read).toEqual([[expectInstanceOf(row, RecordNode).resourceUri]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey))).toBe('Modified');
  });

  it('names nothing when a group answers from its cache', async () => {
    const { provider, typeNode, read } = await readGroup(makeClient());
    await provider.getChildren(typeNode);

    await provider.getChildren(typeNode);

    expect(read).toHaveLength(1);
  });

  it('names the rows again, with mEdit\'s new state, when a refresh makes the group read again', async () => {
    const record = makeRecord(0, 'None');
    const repo = makeClient({ records: { items: [record], total: 1 } });
    const { provider, typeNode, read } = await readGroup(repo);
    await provider.getChildren(typeNode);

    repo.setQueryAnswer('getRecords', { items: [{ ...record, workingTreeState: 'Modified' }], total: 1 });
    provider.refresh();
    await provider.getChildren(typeNode);

    const uri = recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey);
    expect(read).toEqual([[uri], [uri]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey))).toBe('Modified');
  });

  it('drops a read that was in flight when a refresh came, and names only the read that follows it', async () => {
    const record = makeRecord(0, 'None');
    const repo = makeClient();
    const { provider, typeNode, read } = await readGroup(repo);
    let answerStale!: (page: RecordPage) => void;
    repo.setQueryAnswerOnce('getRecords', new Promise<RecordPage>((resolve) => { answerStale = resolve; }));
    repo.setQueryAnswer('getRecords', { items: [{ ...record, workingTreeState: 'Modified' }], total: 1 });

    const inFlight = provider.getChildren(typeNode);
    provider.refresh();
    answerStale({ items: [record], total: 1 });
    await inFlight;

    expect(read).toEqual([]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey))).toBeUndefined();

    await provider.getChildren(typeNode);

    expect(read).toEqual([[recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey)]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey))).toBe('Modified');
  });

  it('workingTreeStateOf is undefined for a record nothing has cached yet', () => {
    const provider = new PluginTreeProvider(makeClient());
    expect(provider.workingTreeStateOf(recordResourceUri({ name: 'Plugin0.esp', origin: 'Data' }, '000001:Fallout4.esm'))).toBeUndefined();
  });

  it('workingTreeStateOf is undefined for a URI outside the medit-record: scheme', async () => {
    const record = makeRecord(0, 'Modified');
    const { provider, typeNode } = await readGroup(makeClient({ records: { items: [record], total: 1 } }));
    await provider.getChildren(typeNode);

    const { path } = recordResourceUri({ name: record.plugin, origin: 'Data' }, record.formKey);
    expect(provider.workingTreeStateOf(fakeUri(path))).toBeUndefined();
  });
});

describe('worldspace, cell and placed rows state their record', () => {
  it.each([
    ['worldspace', new WorldspaceNode('A.esp', { formKey: '000801:A.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }, 'ModA')],
    ['cell', new CellNode('A.esp', {
      formKey: '000801:A.esp', editorId: 'World', cellX: 1, cellY: 2, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false,
    }, 'ModA')],
    ['placed', new ChildRecordNode('A.esp', {
      formKey: '000801:A.esp', editorId: 'World', baseFormKey: null, recordType: 'refr', hasParseFailure: false,
    }, 'ModA')],
  ])('a %s row', (_kind, node) => {
    expect({ formKey: node.formKey, editorId: node.editorId, plugin: node.plugin, origin: node.origin })
      .toEqual({ formKey: '000801:A.esp', editorId: 'World', plugin: 'A.esp', origin: 'ModA' });
  });

  it('states no EditorID for a record that has none', () => {
    const node = new ChildRecordNode('A.esp', { formKey: '000801:A.esp', editorId: null, baseFormKey: '000802:A.esp', recordType: 'refr', hasParseFailure: false }, 'Data');
    expect(node.editorId).toBeUndefined();
  });
});

describe('record rows carry their copy identity', () => {
  it('RecordNode carries the browsed origin, threaded from its RecordTypeNode', async () => {
    const repo = makeClient({ records: { items: [{ ...makeRecord(0), origin: 'ModA' }], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'ModA' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const [rec] = await provider.getChildren(typeNode);

    expect(expectInstanceOf(rec, RecordNode).origin).toBe('ModA');
  });

});

describe('a plugin\'s conditions reach every row beneath it', () => {
  const TRACKED: PluginConditions = { tracked: true, editable: true };
  const cell = {
    formKey: '000002:Plugin0.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: true, fullName: null, hasParseFailure: false,
  };
  const placed = { formKey: '000003:Plugin0.esp', editorId: 'ref', baseFormKey: null, recordType: 'refr', hasParseFailure: false };

  function spatialClient(): InMemoryMEditClient {
    const repo = makeClient({
      recordTypes: [{ type: 'weap', count: 1 }, { type: 'qust', count: 1 }, { type: 'wrld', count: 1 }, { type: 'cell', count: 1 }],
      records: { items: [makeRecord(0, 'None', true)], total: 1 },
    });
    repo.setQueryAnswer('getContainerChildren', [{ ...makeRecord(1), recordType: 'dial', hasContainerChildren: false, isContainer: false }]);
    repo.setQueryAnswer('getWorldspaces', [{ formKey: '000001:Plugin0.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [cell],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [cell] }] }],
    });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([cell]));
    repo.setQueryAnswer('getCellChildRecords', { persistent: [placed], temporary: [placed] });
    return repo;
  }

  it('states a tracked, editable plugin on its groups, records, a container\'s children, worldspace, cells and placed references', async () => {
    const states = (await rowsBeneath(new PluginTreeProvider(spatialClient()), { name: 'Plugin0.esp', origin: 'Data' }, TRACKED))
      .map((n) => String(n.contextValue));

    expect(states).toEqual([
      'recordType tracked editable creatable', 'record tracked editable',
      'recordType tracked editable creatable', 'record tracked editable', 'record tracked editable',
      'recordType tracked editable creatable', 'worldspace tracked editable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
      'recordType tracked editable creatable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
    ]);
  });

  it('states an untracked plugin untracked on every row beneath it', async () => {
    const states = (await rowsBeneath(new PluginTreeProvider(spatialClient()), { name: 'Plugin0.esp', origin: 'Data' }, { tracked: false, editable: true }))
      .map((n) => String(n.contextValue));

    const CONDITION_WORDS = new Set(['tracked', 'untracked', 'editable']);
    const conditionsOf = (state: string) => state.split(' ').filter((w) => CONDITION_WORDS.has(w)).join(' ');
    expect(new Set(states.map(conditionsOf))).toEqual(new Set(['untracked editable']));
  });
});

describe('PluginTreeProvider.refresh', () => {
  it('asks the view to render again, and the group then lists what mEdit now holds', async () => {
    const repo = makeClient({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const labelsBeneath = async () => (await provider.getChildren(typeNode)).map((n) => n.label);
    expect(await labelsBeneath()).toEqual(['Record0']);

    let askedToRerender = false;
    provider.onDidChangeTreeData(() => { askedToRerender = true; });
    repo.setQueryAnswer('getRecords', { items: [makeRecord(0), makeRecord(1)], total: 2 });
    provider.refresh();

    expect(askedToRerender).toBe(true);
    expect(await labelsBeneath()).toEqual(['Record0', 'Record1']);
  });
});

describe('PluginTreeProvider worldspace tree', () => {
  it('expands a worldspace into its persistent cell and blocks, labeled the way xEdit does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false }],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);
    const [topCellNode, blockNode] = wsChildren;
    const subBlocks = await provider.getChildren(blockNode);
    const cells = await provider.getChildren(subBlocks[0]);

    expect(wsChildren).toHaveLength(2);
    expect(present(topCellNode, 'the persistent-cell child').label).toBe('TopCell');
    expect(present(blockNode, 'the block child').label).toBe('Block 0, 0');
    expect(present(subBlocks[0], "the fixture's single sub-block").label).toBe('Sub-Block 0, 0');
    expect(expectInstanceOf(cells[0], CellNode).cell.cellX).toBe(12);
    const RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL = '< 12,  -5>';
    expect(present(cells[0], "the fixture's single cell").label).toBe(RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL);
  });

  it('surfaces every block-less cell row under a worldspace, not just the first', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [
        { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false },
        { formKey: 'stray:M.esp', editorId: 'StrayCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false },
      ],
      blocks: [],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);

    expect(wsChildren.filter(c => c instanceof CellNode)).toHaveLength(2);
    expect(present(wsChildren[0], 'the first cell row').label).toBe('TopCell');
    expect(present(wsChildren[1], 'the second cell row').label).toBe('StrayCell');
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const cellNode = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false }, 'Data');

    const groups = await provider.getChildren(cellNode);
    expect(groups).toHaveLength(1);
    const persistentGroup = present(groups[0], 'the sole group');
    expect(persistentGroup.label).toBe('Persistent');

    const placed = await provider.getChildren(persistentGroup);
    expect(placed).toHaveLength(1);
    expect(present(placed[0], 'the sole placed row').label).toBe('barrelRef');
  });

  it('nests the Cell group as blocks, then sub-blocks, then cells, labelled as xEdit labels them', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, displayName: 'Cell' }] });
    repo.setQueryAnswer('getInteriorCells', [
      ...oneSubBlock([interiorCell('a:M.esp', 'RoomA')], 0, 1),
      ...oneSubBlock([interiorCell('b:M.esp', 'RoomB')], 3, 7),
    ]);
    const provider = new PluginTreeProvider(repo);
    const [cellGroup] = await provider.getPluginChildren({ name: 'M.esp', origin: 'Data' });

    const blocks = await provider.getChildren(present(cellGroup, 'the Cell group'));
    const subBlocks = await provider.getChildren(present(blocks[1], 'the second block'));
    const cells = await provider.getChildren(present(subBlocks[0], 'its sole sub-block'));

    expect(blocks.map(b => b.label)).toEqual(['Block 0', 'Block 3']);
    expect(subBlocks.map(b => b.label)).toEqual(['Sub-Block 7']);
    expect(expectInstancesOf(cells, CellNode).map(c => c.label)).toEqual(['RoomB']);
  });

  it('lists every interior cell from one call', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getInteriorCells', oneSubBlock(Array.from({ length: 60 }, (_, i) => interiorCell(`${i}:M.esp`, `Room${i}`))));
    const provider = new PluginTreeProvider(repo);

    const cells = await interiorCellsBeneath(provider, group('cell', 'M.esp', 'Data', 60));

    expect(expectInstancesOf(cells, CellNode)).toHaveLength(60);
    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(1);
  });

  it('gives a worldspace an expander only when a cell is beneath it', () => {
    const holding = new WorldspaceNode('M.esp', { formKey: 'w1:M.esp', editorId: 'Holding', hasParseFailure: false, hasChildren: true }, 'Data');
    const empty = new WorldspaceNode('M.esp', { formKey: 'w2:M.esp', editorId: 'Empty', hasParseFailure: false, hasChildren: false }, 'Data');

    expect(holding.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(empty.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('gives a cell an expander only when it holds a placed reference', () => {
    const holding = new CellNode('M.esp', interiorCell('c1:M.esp', 'Holding', { hasChildren: true }), 'Data');
    const empty = new CellNode('M.esp', interiorCell('c2:M.esp', 'Empty'), 'Data');

    expect(holding.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(empty.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('gives a group an expander only when it holds a record', () => {
    expect(new RecordTypeNode('M.esp', recordTypeCountFixture({ type: 'weap', count: 1 }), 'Data').collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(new RecordTypeNode('M.esp', recordTypeCountFixture({ type: 'weap', count: 0 }), 'Data').collapsibleState).toBe(TreeItemCollapsibleState.None);
  });
});

describe('PluginTreeProvider fetch failures', () => {
  it('getPluginChildren: builds a plugin\'s children from its (origin, filename)', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'cell', count: 4, displayName: 'Cell' },
        { type: 'weap', count: 5, displayName: 'Weapon' },
        { type: 'wrld', count: 1, displayName: 'Worldspace' },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });

    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: [{ name: 'Plugin0.esp', origin: 'Data' }] });
    expect(children.map(c => c.label)).toEqual(['Cell', 'Weapon', 'Worldspace']);
  });

  it('getPluginChildren: records below it carry the open-editor command', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'weap', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const [recordType] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });

    const [record] = await provider.getChildren(recordType);

    expect(expectInstanceOf(record, RecordNode).command).toMatchObject({ command: 'modbench.record.open' });
  });

  it('getPluginChildren: renders an error node when getRecordTypes fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getRecordTypes', new Error('boom'));
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchRecords: renders an error node when getRecords fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getRecords', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new RecordTypeNode('Plugin0.esp', recordTypeCountFixture({ type: 'weap', count: 5 }), 'Data');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaces: renders an error node when getWorldspaces fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getWorldspaces', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = group('wrld', 'Plugin0.esp', 'Data');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaceChildren: renders an error node when getWorldspaceBlocks fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getWorldspaceBlocks', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Plugin0.esp', { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }, 'Data');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchCellGroups: renders an error node when getCellChildRecords fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getCellChildRecords', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false }, 'Data');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchInteriorCells: renders an error node when getInteriorCells fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getInteriorCells', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = group('cell', 'M.esp', 'Data');

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });
});

describe('PluginTreeProvider spatial origin threading', () => {
  it('fetchWorldspaces: asks the repository for the node\'s own plugin, and the WorldspaceNodes it builds carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    const provider = new PluginTreeProvider(repo);
    const node = group('wrld', 'Shared.esp', 'ModB');

    const wsNode = present(expectInstancesOf(await provider.getChildren(node), WorldspaceNode)[0], 'the sole WorldspaceNode');

    expect(repo.calls).toContainEqual({ method: 'getWorldspaces', args: [{ name: 'Shared.esp', origin: 'ModB' }] });
    expect(wsNode.origin).toBe('ModB');
  });

  it('fetchWorldspaceChildren: asks the repository for the node\'s own plugin, and its TopCell/Block children carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false }],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Shared.esp', { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }, 'ModB');

    const worldspaceChildren = await provider.getChildren(node);
    const topCellNode = expectInstanceOf(worldspaceChildren[0], CellNode);
    const blockNode = worldspaceChildren[1];

    expect(repo.calls).toContainEqual({ method: 'getWorldspaceBlocks', args: [{ name: 'Shared.esp', origin: 'ModB' }, 'wrld:M.esp'] });
    expect(topCellNode.origin).toBe('ModB');

    const [subBlockNode] = await provider.getChildren(blockNode);
    const cellNode = present(expectInstancesOf(await provider.getChildren(subBlockNode), CellNode)[0], 'the sole CellNode');
    expect(expectInstanceOf(subBlockNode, SubBlockNode).origin).toBe('ModB');
    expect(cellNode.origin).toBe('ModB');
  });

  it('fetchCellGroups: asks the repository for the node\'s own plugin, and its PlacedGroup/Placed children carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('Shared.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false }, 'ModB');

    const groupNode = present(expectInstancesOf(await provider.getChildren(node), ChildRecordGroupNode)[0], 'the sole ChildRecordGroupNode');
    expect(repo.calls).toContainEqual({ method: 'getCellChildRecords', args: [{ name: 'Shared.esp', origin: 'ModB' }, 'c:M.esp'] });
    expect(groupNode.origin).toBe('ModB');

    const placedNode = present(expectInstancesOf(await provider.getChildren(groupNode), ChildRecordNode)[0], 'the sole ChildRecordNode');
    expect(placedNode.origin).toBe('ModB');
  });

  it('fetchInteriorCells: asks the repository for the node\'s own plugin, and the rows it builds carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([interiorCell('i:M.esp', 'IntCell')]));
    const provider = new PluginTreeProvider(repo);
    const node = group('cell', 'Shared.esp', 'ModB', 1);

    const [block] = expectInstancesOf(await provider.getChildren(node), InteriorBlockNode);
    const [subBlock] = expectInstancesOf(await provider.getChildren(present(block, 'the sole block')), InteriorSubBlockNode);
    const [cellNode] = expectInstancesOf(await provider.getChildren(present(subBlock, 'the sole sub-block')), CellNode);

    expect(repo.calls).toContainEqual({ method: 'getInteriorCells', args: [{ name: 'Shared.esp', origin: 'ModB' }] });
    expect(present(block, 'the sole block').origin).toBe('ModB');
    expect(present(subBlock, 'the sole sub-block').origin).toBe('ModB');
    expect(present(cellNode, 'the sole cell').origin).toBe('ModB');
  });

  it('refCache: caches each plugin\'s cell references separately, so one plugin\'s page is never served for the other', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const cell = { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false };
    const fromA = new CellNode('Shared.esp', cell, 'ModA');
    const fromB = new CellNode('Shared.esp', cell, 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getCellChildRecords')).toHaveLength(2);
  });

  it('interiorCache: caches each plugin\'s interior cells separately, so one plugin\'s cells are never served for the other', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const fromA = group('cell', 'Shared.esp', 'ModA');
    const fromB = group('cell', 'Shared.esp', 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(2);
  });

  it('a cell row and a placed-reference row of a shared filename, expanded concurrently, read their own plugin\'s tracked/read-only facts, not the other plugin\'s', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }] });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null, hasParseFailure: false }],
      blocks: [],
    });
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ formKey: 'p:M.esp', editorId: 'DoorRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const TRACKED_EDITABLE: PluginConditions = { tracked: true, editable: true };
    const READ_ONLY: PluginConditions = { tracked: false, editable: false };

    const [fromA, fromB] = await Promise.all([
      rowsBeneath(provider, { name: 'Shared.esp', origin: 'ModA' }, TRACKED_EDITABLE),
      rowsBeneath(provider, { name: 'Shared.esp', origin: 'ModB' }, READ_ONLY),
    ]);
    const cellOf = (nodes: PluginTreeNode[]) =>
      expectInstanceOf(present(nodes.find((n) => n.kind === 'cell'), 'the cell row'), CellNode);
    const placedOf = (nodes: PluginTreeNode[]) =>
      expectInstanceOf(present(nodes.find((n) => n.kind === 'placed'), 'the placed row'), ChildRecordNode);
    const cellA = cellOf(fromA);
    const placedA = placedOf(fromA);
    const cellB = cellOf(fromB);
    const placedB = placedOf(fromB);

    expect(cellA.contextValue).toBe('cell tracked editable');
    expect(cellA.origin).toBe('ModA');
    expect(placedA.contextValue).toBe('placed tracked editable');
    expect(placedA.origin).toBe('ModA');
    expect(cellB.contextValue).toBe('cell untracked');
    expect(cellB.origin).toBe('ModB');
    expect(placedB.contextValue).toBe('placed untracked');
    expect(placedB.origin).toBe('ModB');
  });

});

describe('PluginTreeProvider.getPluginChildren (origin)', () => {
  const sharedClient = () => listsForThePluginAsked(makeClient({ recordTypes: [{ type: 'weap', count: 1 }] }));

  it('asks the repository for the plugin the row stands for', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'weap', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModB' });

    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: [{ name: 'Shared.esp', origin: 'ModB' }] });
  });

  it('carries that plugin through to its record pages', async () => {
    const repo = sharedClient();
    const provider = new PluginTreeProvider(repo);

    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModB' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(typeNode);

    expect(repo.calls).toContainEqual({ method: 'getRecords', args: [{ name: 'Shared.esp', origin: 'ModB' }, 'weap', 0, expect.any(Number)] });
  });

  it('caches each plugin separately, so one plugin\'s page is never served for the other', async () => {
    const repo = sharedClient();
    const provider = new PluginTreeProvider(repo);

    const fromA = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModA' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const fromB = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModB' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(2);
  });

  it('caches one plugin once, whatever case its filename and origin arrive in, as MO2 and a Windows filesystem compare them', async () => {
    const repo = sharedClient();
    const provider = new PluginTreeProvider(repo);

    const asListed = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModA' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const recased = present(expectInstancesOf(await provider.getPluginChildren({ name: 'shared.ESP', origin: 'moda' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(asListed);
    await provider.getChildren(recased);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
  });
});

function makeContainerChild(
  formKey: string, recordType: string, editorId: string | null = null, hasContainerChildren = false,
): ContainerChildSummary {
  return {
    formKey, editorId, plugin: 'Plugin0.esp', origin: 'Data',
    loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', recordType, hasContainerChildren, isContainer: false,
    hasParseFailure: false,
  };
}

describe('RecordNode collapsibility for container types', () => {
  it('is Collapsed when built as a "qust" row that actually has container children', () => {
    const node = new RecordNode(makeRecord(0), 'Data', undefined, 'qust', true);
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it('is Collapsed when built as a "dial" row that actually has container children', () => {
    const node = new RecordNode(makeRecord(0), 'Data', undefined, 'dial', true);
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it('stays None (a leaf) when built as a "qust" row with no container children', () => {
    const node = new RecordNode(makeRecord(0), 'Data', undefined, 'qust', false);
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('stays None (a leaf) when built as a "dial" row with no container children', () => {
    const node = new RecordNode(makeRecord(0), 'Data', undefined, 'dial', false);
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('stays None (a leaf) when no containerChildType is given, as every other record type does', () => {
    const node = new RecordNode(makeRecord(0), 'Data');
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });
});

describe('PluginTreeProvider.getChildren(RecordNode) — container children', () => {
  it('a "qust" RecordNode expands via repository.getContainerChildren into ordinary RecordNodes', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'),
      makeContainerChild('dlbr1:Fallout4.esm', 'dlbr', 'BranchA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, 'Data', undefined, 'qust');

    const children = await provider.getChildren(questNode);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: [{ name: 'Plugin0.esp', origin: 'Data' }, 'qust1:Fallout4.esm'] });
    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    expect(expectInstanceOf(children[0], RecordNode).record.editorId).toBe('TopicA');
    expect(expectInstanceOf(children[0], RecordNode).command).toMatchObject({ command: 'modbench.record.open' });
  });

  it('a returned "dial" child with its own children is itself Collapsed — expandable to its own Responses; one with none and a scene stay leaves', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA', true),
      makeContainerChild('dial2:Fallout4.esm', 'dial', 'TopicB', false),
      makeContainerChild('scen1:Fallout4.esm', 'scen', 'SceneA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, 'Data', undefined, 'qust', true);

    const children = expectInstancesOf(await provider.getChildren(questNode), RecordNode);

    const dialWithChildren = present(children.find(c => c.record.formKey === 'dial1:Fallout4.esm'), 'the dial1 row');
    const dialWithoutChildren = present(children.find(c => c.record.formKey === 'dial2:Fallout4.esm'), 'the dial2 row');
    const scenChild = present(children.find(c => c.record.formKey === 'scen1:Fallout4.esm'), 'the scen1 row');
    expect(dialWithChildren.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(dialWithoutChildren.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(scenChild.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('a "dial" RecordNode expands via repository.getContainerChildren into its Responses', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('info1:Fallout4.esm', 'info'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const topicNode = new RecordNode(
      { ...makeRecord(0), formKey: 'dial1:Fallout4.esm' }, 'Data', undefined, 'dial');

    const children = await provider.getChildren(topicNode);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: [{ name: 'Plugin0.esp', origin: 'Data' }, 'dial1:Fallout4.esm'] });
    expect(children).toHaveLength(1);
  });

  it('origin-keyed caching: two plugins that share a filename browse their own children independently', async () => {
    const repo = makeClient();
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-a:Shared.esp', 'dial', 'TopicModA')]);
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-b:Shared.esp', 'dial', 'TopicModB')]);
    const provider = new PluginTreeProvider(repo);
    const questA = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModA', undefined, 'qust');
    const questB = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModB', undefined, 'qust');

    const childrenA = expectInstancesOf(await provider.getChildren(questA), RecordNode);
    const childrenB = expectInstancesOf(await provider.getChildren(questB), RecordNode);

    const containerCalls = repo.calls.filter(c => c.method === 'getContainerChildren');
    expect(containerCalls).toHaveLength(2);
    expect(present(containerCalls[0], 'the first getContainerChildren call').args).toEqual([{ name: 'Shared.esp', origin: 'ModA' }, 'qust1:Shared.esp']);
    expect(present(containerCalls[1], 'the second getContainerChildren call').args).toEqual([{ name: 'Shared.esp', origin: 'ModB' }, 'qust1:Shared.esp']);
    expect(present(childrenA[0], "ModA's sole child").record.editorId).toBe('TopicModA');
    expect(present(childrenB[0], "ModB's sole child").record.editorId).toBe('TopicModB');
  });
});

describe('the failure prefix', () => {
  it('marks a record whose document could not be read, and only that record', async () => {
    const unreadable = { ...makeRecord(0), parseDiagnosis: 'Perk 0000EF — unknown: bad flag', hasParseFailure: true };
    const repo = makeClient({ records: { items: [unreadable, makeRecord(1)], total: 2 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const recordRows = expectInstancesOf(await provider.getChildren(typeNode), RecordNode);
    const failed = present(recordRows[0], 'the unreadable record row');
    const healthy = present(recordRows[1], 'the readable record row');

    expect(expectInstanceOf(failed.iconPath, ThemeIcon).id).toBe('error');
    expect(failed.tooltip).toContain('Perk 0000EF — unknown: bad flag');
    expect(healthy.iconPath).toBeUndefined();
  });

  it('marks the record-type node holding an unreadable record, and only that node', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'perk', count: 2, displayName: 'Perk', hasParseFailure: true },
        { type: 'weap', count: 5, displayName: 'Weapon', hasParseFailure: false },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const typeNodes = expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode);
    const perk = present(typeNodes[0], 'the perk type node');
    const weap = present(typeNodes[1], 'the WEAP type node');

    expect(expectInstanceOf(perk.iconPath, ThemeIcon).id).toBe('error');
    expect(perk.description).toBe('2');
    expect(weap.iconPath).toBeUndefined();
  });

  it('marks the whole worldspace chain a failure sits under, and nothing beside it', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1, hasParseFailure: true }] });
    repo.setQueryAnswer('getWorldspaces', [
      { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: true, hasChildren: true },
      { formKey: 'other:M.esp', editorId: 'Other', hasParseFailure: false, hasChildren: false },
    ]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [{ x: 0, y: 0, hasParseFailure: true, subBlocks: [{ x: 0, y: 0, hasParseFailure: true,
        cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 1, cellY: 1, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: true }] }] }],
    });
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ formKey: 'p:M.esp', editorId: 'Ref', baseFormKey: null, recordType: 'refr', hasParseFailure: true }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);

    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });
    const [failing, healthy] = await provider.getChildren(wsRoot);
    const [blockNode] = await provider.getChildren(failing);
    const [subBlock] = await provider.getChildren(blockNode);
    const [cellNode] = await provider.getChildren(subBlock);
    const [persistentGroup] = await provider.getChildren(cellNode);
    const [placedNode] = await provider.getChildren(persistentGroup);

    for (const node of [
      present(wsRoot, 'the worldspace root'),
      present(failing, 'the failing top cell'),
      present(blockNode, 'the block node'),
      present(subBlock, 'the sub-block node'),
      present(cellNode, 'the cell node'),
      present(persistentGroup, 'the persistent group'),
      present(placedNode, 'the placed node'),
    ]) {
      expect(expectInstanceOfOrUndefined(node.iconPath, ThemeIcon)?.id).toBe('error');
    }
    expect(present(healthy, 'the healthy top-level child').iconPath).toBeUndefined();
  });

  it('marks an interior cell that cannot be read, and its group node', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, hasParseFailure: true }] });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([
      interiorCell('bad:M.esp', 'Bad', { hasParseFailure: true }),
      interiorCell('ok:M.esp', 'Ok'),
    ]));
    const provider = new PluginTreeProvider(repo);

    const [interiorRootOrUndefined] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' });
    const interiorRoot = present(interiorRootOrUndefined, 'the interior-cells root');
    const [block] = await provider.getChildren(interiorRoot);
    const [subBlock] = await provider.getChildren(present(block, 'the sole block'));
    const [bad, ok] = await provider.getChildren(present(subBlock, 'the sole sub-block'));

    for (const node of [interiorRoot, present(block, 'the sole block'), present(subBlock, 'the sole sub-block')]) {
      expect(expectInstanceOf(node.iconPath, ThemeIcon).id).toBe('error');
    }
    expect(expectInstanceOf(present(bad, 'the unreadable interior cell').iconPath, ThemeIcon).id).toBe('error');
    expect(present(ok, 'the readable interior cell').iconPath).toBeUndefined();
  });

  it('marks a container child that cannot be read, and the container row above it', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'qust', count: 1 }],
      records: { items: [{ ...makeRecord(0, 'None', true), hasParseFailure: true }], total: 1 },
    });
    repo.setQueryAnswer('getContainerChildren', [
      { ...makeRecord(1), recordType: 'info', hasContainerChildren: false, isContainer: false,
        parseDiagnosis: 'INFO 12 — unknown: bad', hasParseFailure: true },
    ]);
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data' }), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const [questRowOrUndefined] = await provider.getChildren(typeNode);
    const questRow = present(questRowOrUndefined, 'the qust row');

    const [childRowOrUndefined] = await provider.getChildren(questRow);
    const childRow = present(childRowOrUndefined, 'the unreadable container child');

    expect(expectInstanceOf(questRow.iconPath, ThemeIcon).id).toBe('error');
    expect(expectInstanceOf(childRow.iconPath, ThemeIcon).id).toBe('error');
    expect(childRow.tooltip).toContain('INFO 12');
  });
});

