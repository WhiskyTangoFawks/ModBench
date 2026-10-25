import { describe, it, expect, vi } from 'vitest';
import {
  type RecordSummary, type RecordPage, type ContainerChildSummary, type CellSummary, type InteriorCellBlock,
  type ChildRecordSummary, type WorldspaceSummary,
} from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import * as vscode from 'vscode';
import { NOT_EDITABLE, browserClient, type BrowserAnswers, cellRow, childrenOf, placedRow, recordRow, soleChild, soleGroup, worldspaceRow } from './browserRows';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';
import type { PluginConditions } from '../../drivingLib/recordRowContext';
import { recordResourceUri } from '../recordResourceUri';
import type { PluginAddress } from '../../wire/pluginAddress';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';
import { CONTAINER_TYPES, listsForThePluginAsked, recordTypeCountFixture } from '../../client/test/fixtures';

function makeRecord(
  i: number, workingTreeState: RecordSummary['workingTreeState'] = 'None', hasContainerChildren = false,
): RecordSummary {
  return {
    formKey: `${String(i).padStart(6, '0')}:Fallout4.esm`,
    plugin: 'Plugin0.esp',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
    origin: 'Data/',
    workingTreeState,
    hasContainerChildren,
    hasParseFailure: false,
  };
}

const makeClient = (answers: BrowserAnswers = {}): InMemoryMEditClient => browserClient({
  recordTypes: [{ type: 'weap', count: 5, displayName: 'Weapon' }], records: { items: [makeRecord(0)], total: 1 }, ...answers,
});

const PLUGIN0: PluginAddress = { name: 'Plugin0.esp', origin: 'Data/' };

function openedArguments(row: RecordBrowserNode): unknown {
  return row.command?.arguments;
}

async function containerRowOver(
  record: RecordSummary, origin = 'Data/', client = makeClient(), provider = new RecordBrowser(client),
) {
  const row = await recordRow(record, origin, undefined, 'qust', { client, provider });
  return { provider, repo: client, row };
}

const ERROR_ICON: unknown = expect.objectContaining({ id: 'error' });
const FAILED_TO_LOAD = [['error', 'Failed to load: boom']];
const WORLDSPACE_OF_M = { workingTreeState: 'None' as const, formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false, hasChildren: true };

function interiorCell(formKey: string, editorId: string | null, overrides: Partial<CellSummary> = {}): CellSummary {
  return {
    formKey, editorId, cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'None',
    ...overrides,
  };
}

function oneSubBlock(cells: CellSummary[], block = 0, subBlock = 0): InteriorCellBlock[] {
  const hasParseFailure = cells.some(c => c.hasParseFailure);
  return [{ number: block, hasParseFailure, subBlocks: [{ number: subBlock, hasParseFailure, cells }] }];
}

async function interiorCellsBeneath(provider: RecordBrowser, cellGroup: RecordBrowserNode): Promise<RecordBrowserNode[]> {
  const [block] = await provider.getChildren(cellGroup);
  const [subBlock] = await provider.getChildren(present(block, 'the sole block'));
  return provider.getChildren(present(subBlock, 'the sole sub-block'));
}

async function interiorCellRow(
  repo: InMemoryMEditClient, provider: RecordBrowser, cell: CellSummary, plugin: PluginAddress = PLUGIN0,
): Promise<RecordBrowserNode> {
  repo.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'cell', count: 1 })]);
  repo.setQueryAnswer('getInteriorCells', oneSubBlock([cell]));
  const [row] = await interiorCellsBeneath(provider, await soleGroup(provider, plugin));
  return present(row, 'the interior cell row');
}

async function rowsBeneath(
  provider: RecordBrowser, plugin: PluginAddress, told: PluginConditions,
): Promise<RecordBrowserNode[]> {
  const states: RecordBrowserNode[] = [];
  const walk = async (nodes: readonly RecordBrowserNode[]): Promise<void> => {
    for (const node of nodes) {
      if (/^(recordType|record|worldspace|cell|placed)( |$)/.test(String(node.contextValue))) states.push(node);
      if (node.collapsibleState !== vscode.TreeItemCollapsibleState.None) await walk(await provider.getChildren(node));
    }
  };
  await walk(await provider.getPluginChildren(plugin, told));
  return states;
}

describe('a plugin\'s children, one group per record type', () => {
  it('returns one group per record type', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'weap', count: 10 }, { type: 'npc_', count: 3 }] });
    const provider = new RecordBrowser(repo);

    const children = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);

    expect(children).toHaveLength(2);
    expect(children.map(c => [c.label, c.description])).toEqual([['weap', '10'], ['npc_', '3']]);
  });

  it('builds the Worldspace and Cell groups as record-type groups of their type, so they offer create as any group does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'cell', count: 2 }] });
    const provider = new RecordBrowser(repo);

    const groups = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, { editable: true });

    expect(groups.map(g => [g.label, g.contextValue])).toEqual([
      ['wrld', 'recordType editable creatable'],
      ['cell', 'recordType editable creatable'],
    ]);
  });
});

describe('a plugin\'s children — an answer that is no failed read', () => {
  it('shows a row that cannot be built as no error row, and reaches the caller', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', [{ ...recordTypeCountFixture({ type: 'weap', count: 1 }), get type(): string { throw new Error('the row broke'); } }]);

    await expect(new RecordBrowser(client).getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE)).rejects.toThrow('the row broke');
  });

  it('shows a failed read as the one error row', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', { failed: 'unreachable' });

    const children = await new RecordBrowser(client).getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);

    expect(children.map(c => c.contextValue)).toEqual(['error']);
  });
});

describe('a record-type group\'s children', () => {
  it('lists a record row for every record in one call', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeClient({ records: { items: records, total: 3 } });
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);

    const children = await provider.getChildren(typeNode);

    expect(children.map(c => c.label)).toEqual(['Record0', 'Record1', 'Record2']);
  });

  it('returns every record in one call at a large, realistic-worst-case count, as xEdit\'s record-type group nodes load in full', async () => {
    const FALLOUT4_ESM_INFO_COUNT = 78_089;
    const records = Array.from({ length: FALLOUT4_ESM_INFO_COUNT }, (_, i) => makeRecord(i));
    const repo = makeClient({ records: { items: records, total: FALLOUT4_ESM_INFO_COUNT } });
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(FALLOUT4_ESM_INFO_COUNT);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    const [plugin, recordType, offset, limit] = present(repo.calls.find(c => c.method === 'getRecords'), 'the getRecords call').args;
    expect([plugin, recordType, offset]).toEqual([{ name: 'Plugin0.esp', origin: 'Data/' }, 'weap', 0]);
    expect(limit).toSatisfy((asked: number) => asked > FALLOUT4_ESM_INFO_COUNT);
  });

  it('a "qust" row is expandable only when its own record holds children, not by its record type alone', async () => {
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
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);

    const children = await provider.getChildren(typeNode);

    expect(children.map(c => [c.description, c.collapsibleState])).toEqual([
      ['qustWithChildren:Fallout4.esm', TreeItemCollapsibleState.Collapsed],
      ['qustWithoutChildren:Fallout4.esm', TreeItemCollapsibleState.None],
    ]);
  });
});

describe('a record-type group\'s children — no per-row fan-out for container presence', () => {
  it('listing ~1,300 Quests reads the group once and asks nothing per row for its children', async () => {
    const FALLOUT4_ESM_APPROXIMATE_QUST_COUNT = 1_300;
    const records = Array.from(
      { length: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT }, (_, i) => makeRecord(i, 'None', i % 2 === 0));
    const repo = makeClient({ recordTypes: [{ type: 'qust', count: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT }], records: { items: records, total: FALLOUT4_ESM_APPROXIMATE_QUST_COUNT } });
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(FALLOUT4_ESM_APPROXIMATE_QUST_COUNT);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls.some(c => c.method === 'getContainerChildren')).toBe(false);
  });
});

describe('a record-type group row', () => {
  const groupOf = async (type: { type: string; count: number; displayName?: string; isCreatable?: boolean }) => {
    const provider = new RecordBrowser(makeClient({ recordTypes: [type] }));
    return soleGroup(provider, PLUGIN0);
  };

  it('uses the xEdit display name as label', async () => {
    expect((await groupOf({ type: 'weap', count: 42, displayName: 'Weapon' })).label).toBe('Weapon');
  });

  it.each([
    ['a type mEdit can create', 1234, true, '1,234', 'recordType creatable'],
    ['a type mEdit cannot create', 3, false, '3', 'recordType'],
  ])('states the count and create of %s', async (_label, count, isCreatable, description, contextValue) => {
    const group = await groupOf({ type: 'weap', count, isCreatable });

    expect([group.description, group.contextValue]).toEqual([description, contextValue]);
  });
});

describe('a record row', () => {
  const rowOf = async (record: RecordSummary, origin = 'Data/', conditions?: PluginConditions) =>
    recordRow(record, origin, conditions);

  it('wires .command to modbench.record.open with its own copy: its record\'s plugin in the row\'s origin', async () => {
    const record = makeRecord(0);

    const row = await rowOf(record, 'ModA');

    expect(row.command).toEqual({
      command: 'modbench.record.open',
      title: 'Open Record',
      arguments: [{ argument: { kind: 'record', formKey: record.formKey, plugin: { name: 'Plugin0.esp', origin: 'ModA' } } }],
    });
  });

  it('carries its record as its Argument: its plugin\'s address in the row\'s origin, and its FormKey', async () => {
    const record = makeRecord(3);

    const row = await rowOf(record, 'ModA');

    expect(row).toMatchObject({
      argument: { kind: 'record', plugin: { name: 'Plugin0.esp', origin: 'ModA' }, formKey: record.formKey },
    });
  });

  it.each<[string, RecordSummary, PluginConditions, string]>([
    ['an editable record', makeRecord(0), { editable: true }, 'record editable'],
    ['an override as the plugin\'s own records', { ...makeRecord(0), plugin: 'PatchMod.esp' }, { editable: true }, 'record editable'],
    ['a record of an immutable plugin read-only', makeRecord(0), { editable: false }, 'record'],
  ])('states %s', async (_label, record, conditions, contextValue) => {
    expect((await rowOf(record, 'Data/', conditions)).contextValue).toBe(contextValue);
  });

  it('carries a medit-record: resourceUri identifying (plugin, origin, formKey)', async () => {
    const record = makeRecord(0);

    const row = await rowOf(record, 'ModA');

    expect(row.resourceUri).toEqual(recordResourceUri({ name: record.plugin, origin: 'ModA' }, record.formKey));
  });
});

describe('every row is named as xEdit names it', () => {
  const A_ESP: PluginAddress = { name: 'A.esp', origin: 'ModA' };
  const UNREADABLE = 'This record could not be read into its document: bad flag';
  const unreadable = { hasParseFailure: true, parseDiagnosis: 'bad flag' };

  const record = (overrides: Partial<RecordSummary>) => recordRow({ ...makeRecord(0), plugin: 'A.esp', ...overrides }, 'ModA');
  const worldspace = (overrides: Partial<WorldspaceSummary>) => worldspaceRow(
    { workingTreeState: 'None', formKey: '000100:A.esp', hasParseFailure: false, hasChildren: false, ...overrides }, A_ESP,
  );
  const cell = (overrides: Partial<CellSummary>) => cellRow(
    { formKey: '000101:A.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'None', ...overrides }, A_ESP,
  );
  const interior = async (overrides: Partial<CellSummary>) => {
    const repo = makeClient();
    return interiorCellRow(repo, new RecordBrowser(repo), interiorCell('000201:A.esp', null, overrides));
  };
  const placed = (overrides: Partial<ChildRecordSummary>) => placedRow(
    { formKey: '000301:A.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'None', ...overrides }, A_ESP,
  );
  const containerChild = async (overrides: Partial<ContainerChildSummary>) => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('000501:A.esp', 'dial'), ...overrides }]);
    const { provider, row } = await containerRowOver(makeRecord(0, 'None', true), 'Data/', repo);
    return soleChild(provider, row, 'the container');
  };

  it.each<[string, () => Promise<RecordBrowserNode>, [unknown, unknown, unknown]]>([
    ['a record by its EditorID, described by its FormKey, tipped with its name',
      () => record({ formKey: '000001:A.esp', editorId: 'TheWeapon', fullName: 'Laser Rifle' }), ['TheWeapon', '000001:A.esp', 'Laser Rifle']],
    ['a record without an EditorID by its FormKey',
      () => record({ formKey: '000002:A.esp', editorId: null, fullName: null }), ['000002:A.esp', '000002:A.esp', undefined]],
    ['an unreadable record by its name and the reason',
      () => record({ formKey: '000003:A.esp', editorId: 'TheWeapon', fullName: 'Laser Rifle', ...unreadable }), ['TheWeapon', '000003:A.esp', `Laser Rifle\n${UNREADABLE}`]],
    ['a worldspace as a record',
      () => worldspace({ editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland' }), ['Commonwealth', '000100:A.esp', 'Commonwealth Wasteland']],
    ['a worldspace without an EditorID by its FormKey',
      () => worldspace({ editorId: null, fullName: null }), ['000100:A.esp', '000100:A.esp', undefined]],
    ['an unreadable worldspace by its name and the reason',
      () => worldspace({ editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland', ...unreadable }), ['Commonwealth', '000100:A.esp', `Commonwealth Wasteland\n${UNREADABLE}`]],
    ['an exterior cell with an EditorID as a record',
      () => cell({ editorId: 'SanctuaryExt', cellX: 12, cellY: -5, fullName: 'Sanctuary Hills' }), ['SanctuaryExt', '000101:A.esp', 'Sanctuary Hills']],
    ['an exterior cell without an EditorID by its grid position',
      () => cell({ cellX: 3, cellY: -2 }), ['<  3,  -2>', '000101:A.esp', undefined]],
    ['a persistent worldspace cell by its FormKey',
      () => cell({ isPersistentWorldspaceCell: true }), ['000101:A.esp', '000101:A.esp', undefined]],
    ['an unreadable cell by the reason alone',
      () => cell({ editorId: 'TopCell', ...unreadable }), ['TopCell', '000101:A.esp', UNREADABLE]],
    ['an interior cell as a record',
      () => interior({ editorId: 'Vault111', fullName: 'Vault 111' }), ['Vault111', '000201:A.esp', 'Vault 111']],
    ['an interior cell without an EditorID by its FormKey',
      () => interior({}), ['000201:A.esp', '000201:A.esp', undefined]],
    ['a placed reference by its EditorID',
      () => placed({ editorId: 'DoorRef', baseEditorId: 'VaultDoor', fullName: 'Vault Door' }), ['DoorRef', '000301:A.esp', 'Vault Door']],
    ['a placed reference without an EditorID by its base record\'s EditorID',
      () => placed({ baseEditorId: 'Barrel01', baseFormKey: '000400:A.esp' }), ['Barrel01', '000301:A.esp', undefined]],
    ['a placed reference without an EditorID or a base record\'s EditorID by its FormKey',
      () => placed({ baseFormKey: '000400:A.esp' }), ['000301:A.esp', '000301:A.esp', undefined]],
    ['an unreadable placed reference by the reason alone',
      () => placed({ editorId: 'DoorRef', ...unreadable }), ['DoorRef', '000301:A.esp', UNREADABLE]],
    ['a container\'s child as a record',
      () => containerChild({ editorId: 'MQ101Greeting', fullName: 'Hello' }), ['MQ101Greeting', '000501:A.esp', 'Hello']],
    ['a container\'s child without an EditorID by its FormKey',
      () => containerChild({ editorId: null }), ['000501:A.esp', '000501:A.esp', undefined]],
  ])('%s', async (_row, build, parts) => {
    const row = await build();

    expect([row.label, row.description, row.tooltip]).toEqual(parts);
  });
});

describe('the rows a group reads, and their working-tree state', () => {
  async function readGroup(repo: InMemoryMEditClient) {
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);
    const read: (readonly unknown[])[] = [];
    provider.onDidReadRecords((uris) => read.push(uris));
    return { provider, typeNode, read };
  }

  it('names each row of a group it reads from mEdit, by the row\'s own resource URI', async () => {
    const record = makeRecord(0, 'Modified');
    const { provider, typeNode, read } = await readGroup(makeClient({ records: { items: [record], total: 1 } }));

    const [row] = await provider.getChildren(typeNode);

    expect(read).toEqual([[present(row, 'the record row').resourceUri]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey))).toBe('Modified');
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

    const uri = recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey);
    expect(read).toEqual([[uri], [uri]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey))).toBe('Modified');
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
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey))).toBeUndefined();

    await provider.getChildren(typeNode);

    expect(read).toEqual([[recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey)]]);
    expect(provider.workingTreeStateOf(recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey))).toBe('Modified');
  });

  it('badges an override-stack row under the plugin that owns its copy, not the plugin browsed', async () => {
    const override = { ...makeRecord(0, 'Modified'), plugin: 'Other.esp' };
    const { provider, typeNode } = await readGroup(makeClient({ records: { items: [override], total: 1 } }));

    await provider.getChildren(typeNode);

    expect(provider.workingTreeStateOf(recordResourceUri({ name: 'Other.esp', origin: 'Data/' }, override.formKey))).toBe('Modified');
  });

  it('a record nothing has cached yet has no working-tree state', () => {
    const provider = new RecordBrowser(makeClient());
    expect(provider.workingTreeStateOf(recordResourceUri({ name: 'Plugin0.esp', origin: 'Data/' }, '000001:Fallout4.esm'))).toBeUndefined();
  });

  it('a URI outside the medit-record: scheme has no working-tree state', async () => {
    const record = makeRecord(0, 'Modified');
    const { provider, typeNode } = await readGroup(makeClient({ records: { items: [record], total: 1 } }));
    await provider.getChildren(typeNode);

    const { path } = recordResourceUri({ name: record.plugin, origin: 'Data/' }, record.formKey);
    expect(provider.workingTreeStateOf(fakeUri(path))).toBeUndefined();
  });
});

describe('worldspace, cell and placed rows state their record', () => {
  const A_ESP: PluginAddress = { name: 'A.esp', origin: 'ModA' };
  const RECORD = { formKey: '000801:A.esp', editorId: 'World' };

  async function spatialRowsOver() {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [{ workingTreeState: 'None', ...RECORD, hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ workingTreeState: 'None', ...RECORD, cellX: 1, cellY: 2, isPersistentWorldspaceCell: false, hasChildren: true, fullName: null, hasParseFailure: false }],
      blocks: [],
    });
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ workingTreeState: 'None', formKey: RECORD.formKey, editorId: RECORD.editorId, baseFormKey: '000802:A.esp', recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new RecordBrowser(repo);
    const worldspace = await soleChild(provider, await soleGroup(provider, A_ESP), 'the worldspace group');
    const cell = await soleChild(provider, worldspace, 'the worldspace');
    const placed = await soleChild(provider, await soleChild(provider, cell, 'the cell'), 'the placed group');
    return { worldspace, cell, placed };
  }

  it.each(['worldspace', 'cell', 'placed'] as const)('a %s row', async (which) => {
    const row = (await spatialRowsOver())[which];

    expect({ label: row.label, description: row.description }).toEqual({ label: 'World', description: '000801:A.esp' });
    expect(row.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record',
      arguments: [{ argument: { kind: 'record', formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } } }],
    });
  });

  it.each(['worldspace', 'cell', 'placed'] as const)('a %s row carries its record as its Argument', async (which) => {
    const row = (await spatialRowsOver())[which];

    expect(row).toMatchObject({
      argument: { kind: 'record', plugin: { name: 'A.esp', origin: 'ModA' }, formKey: '000801:A.esp' },
    });
  });
});

describe('a plugin\'s conditions reach every row beneath it', () => {
  const EDITABLE_PLUGIN: PluginConditions = { editable: true };
  const cell = {
    formKey: '000002:Plugin0.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: true, fullName: null, hasParseFailure: false, workingTreeState: 'None' as const,
  };
  const placed = { formKey: '000003:Plugin0.esp', editorId: 'ref', baseFormKey: null, recordType: 'refr', hasParseFailure: false, workingTreeState: 'None' as const };

  function spatialClient(): InMemoryMEditClient {
    const repo = makeClient({
      recordTypes: [{ type: 'weap', count: 1 }, { type: 'qust', count: 1 }, { type: 'wrld', count: 1 }, { type: 'cell', count: 1 }],
      records: { items: [makeRecord(0, 'None', true)], total: 1 },
    });
    repo.setQueryAnswer('getContainerChildren', [{ ...makeRecord(1), recordType: 'dial', hasContainerChildren: false, isContainer: true }]);
    repo.setQueryAnswer('getWorldspaces', [{ workingTreeState: 'None', formKey: '000001:Plugin0.esp', editorId: 'World', hasParseFailure: false, hasChildren: true }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [cell],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [cell] }] }],
    });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([cell]));
    repo.setQueryAnswer('getCellChildRecords', { persistent: [placed], temporary: [placed] });
    return repo;
  }

  it('states every row beneath an editable plugin editable: its groups, records, a container\'s children, worldspace, cells and placed references', async () => {
    const states = (await rowsBeneath(new RecordBrowser(spatialClient()), { name: 'Plugin0.esp', origin: 'Data/' }, EDITABLE_PLUGIN))
      .map((n) => String(n.contextValue));

    expect(states).toEqual([
      'recordType editable creatable', 'record editable',
      'recordType editable creatable', 'record editable container', 'record editable container',
      'recordType editable creatable', 'worldspace editable container',
      'cell editable container', 'placed editable', 'placed editable',
      'cell editable container', 'placed editable', 'placed editable',
      'recordType editable creatable',
      'cell editable container', 'placed editable', 'placed editable',
    ]);
  });
});

describe('refreshing the browser', () => {
  it('asks the view to render again, and the group then lists what mEdit now holds', async () => {
    const repo = makeClient({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);
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

describe('the worldspace tree', () => {
  it('expands a worldspace into its persistent cell and blocks, labeled the way xEdit does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ workingTreeState: 'None', formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false }],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }] }],
    });
    const provider = new RecordBrowser(repo);
    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);
    const [topCellNode, blockNode] = wsChildren;
    const subBlocks = await provider.getChildren(blockNode);
    const cells = await provider.getChildren(subBlocks[0]);

    expect(wsChildren).toHaveLength(2);
    expect(present(topCellNode, 'the persistent-cell child').label).toBe('TopCell');
    expect(present(blockNode, 'the block child').label).toBe('Block 0, 0');
    expect(present(subBlocks[0], "the fixture's single sub-block").label).toBe('Sub-Block 0, 0');
    const RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL = '< 12,  -5>';
    expect(present(cells[0], "the fixture's single cell").label).toBe(RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL);
  });

  it('surfaces every block-less cell row under a worldspace, not just the first', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [
        { workingTreeState: 'None', formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false },
        { workingTreeState: 'None', formKey: 'stray:M.esp', editorId: 'StrayCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false },
      ],
      blocks: [],
    });
    const provider = new RecordBrowser(repo);
    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);

    expect(wsChildren).toHaveLength(2);
    expect(present(wsChildren[0], 'the first cell row').label).toBe('TopCell');
    expect(present(wsChildren[1], 'the second cell row').label).toBe('StrayCell');
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ workingTreeState: 'None', formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new RecordBrowser(repo);
    const cellNode = await interiorCellRow(repo, provider, interiorCell('c:M.esp', 'TheCell'));

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
    const provider = new RecordBrowser(repo);
    const [cellGroup] = await provider.getPluginChildren({ name: 'M.esp', origin: 'Data/' }, NOT_EDITABLE);

    const blocks = await provider.getChildren(present(cellGroup, 'the Cell group'));
    const subBlocks = await provider.getChildren(present(blocks[1], 'the second block'));
    const cells = await provider.getChildren(present(subBlocks[0], 'its sole sub-block'));

    expect(blocks.map(b => b.label)).toEqual(['Block 0', 'Block 3']);
    expect(subBlocks.map(b => b.label)).toEqual(['Sub-Block 7']);
    expect(cells.map(c => c.label)).toEqual(['RoomB']);
  });

  it('lists every interior cell from one call', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 60 }] });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock(Array.from({ length: 60 }, (_, i) => interiorCell(`${i}:M.esp`, `Room${i}`))));
    const provider = new RecordBrowser(repo);

    const cells = await interiorCellsBeneath(provider, await soleGroup(provider, { name: 'M.esp', origin: 'Data/' }));

    expect(cells).toHaveLength(60);
    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(1);
  });

  it('gives a worldspace an expander only when a cell is beneath it', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 2 }] });
    repo.setQueryAnswer('getWorldspaces', [
      { workingTreeState: 'None', formKey: 'w1:M.esp', editorId: 'Holding', hasParseFailure: false, hasChildren: true },
      { workingTreeState: 'None', formKey: 'w2:M.esp', editorId: 'Empty', hasParseFailure: false, hasChildren: false },
    ]);
    const provider = new RecordBrowser(repo);

    const worldspaces = await childrenOf(provider, await soleGroup(provider, PLUGIN0), 'the worldspace group');

    expect(worldspaces.map(w => [w.label, w.collapsibleState])).toEqual([
      ['Holding', TreeItemCollapsibleState.Collapsed],
      ['Empty', TreeItemCollapsibleState.None],
    ]);
  });

  it('gives a cell an expander only when it holds a placed reference', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2 }] });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([
      interiorCell('c1:M.esp', 'Holding', { hasChildren: true }),
      interiorCell('c2:M.esp', 'Empty'),
    ]));
    const provider = new RecordBrowser(repo);

    const cells = await interiorCellsBeneath(provider, await soleGroup(provider, PLUGIN0));

    expect(cells.map(c => [c.label, c.collapsibleState])).toEqual([
      ['Holding', TreeItemCollapsibleState.Collapsed],
      ['Empty', TreeItemCollapsibleState.None],
    ]);
  });

  it('gives a group an expander only when it holds a record', async () => {
    const provider = new RecordBrowser(makeClient({ recordTypes: [{ type: 'weap', count: 1 }, { type: 'npc_', count: 0 }] }));

    const groups = await provider.getPluginChildren(PLUGIN0, NOT_EDITABLE);

    expect(groups.map(g => g.collapsibleState)).toEqual([TreeItemCollapsibleState.Collapsed, TreeItemCollapsibleState.None]);
  });
});

describe('a failed fetch', () => {
  it.each<[string, () => Promise<RecordBrowserNode[]>]>([
    ['getRecordTypes', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getRecordTypes', { failed: 'refused', refusal: 'boom' });
      return new RecordBrowser(repo).getPluginChildren(PLUGIN0, NOT_EDITABLE);
    }],
    ['getRecords', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getRecords', { failed: 'refused', refusal: 'boom' });
      const provider = new RecordBrowser(repo);
      return provider.getChildren(await soleGroup(provider, PLUGIN0));
    }],
    ['getWorldspaces', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryFailure('getWorldspaces', { failed: 'refused', refusal: 'boom' });
      const provider = new RecordBrowser(repo);
      return provider.getChildren(await soleGroup(provider, PLUGIN0));
    }],
    ['getWorldspaceBlocks', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      repo.setQueryFailure('getWorldspaceBlocks', { failed: 'refused', refusal: 'boom' });
      const provider = new RecordBrowser(repo);
      return provider.getChildren(await soleChild(provider, await soleGroup(provider, PLUGIN0), 'the worldspace group'));
    }],
    ['getCellChildRecords', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getCellChildRecords', { failed: 'refused', refusal: 'boom' });
      const provider = new RecordBrowser(repo);
      return provider.getChildren(await interiorCellRow(repo, provider, interiorCell('c:M.esp', 'TheCell')));
    }],
    ['getInteriorCells', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'cell', count: 1 }] });
      repo.setQueryFailure('getInteriorCells', { failed: 'refused', refusal: 'boom' });
      const provider = new RecordBrowser(repo);
      return provider.getChildren(await soleGroup(provider, PLUGIN0));
    }],
  ])('renders an error node when %s fails', async (_query, expand) => {
    const children = await expand();

    expect(children.map(c => [c.contextValue, c.label])).toEqual(FAILED_TO_LOAD);
  });
});

describe('spatial rows of a shared filename', () => {
  const SHARED_B: PluginAddress = { name: 'Shared.esp', origin: 'ModB' };
  type Walk = { repo: InMemoryMEditClient; opened: RecordBrowserNode[] };
  const openedAs = (formKey: string) => [{ argument: { kind: 'record', formKey, plugin: SHARED_B } }];

  it.each<[string, () => Promise<Walk>, { method: string; args: unknown[] }[], unknown[]]>([
    ['getWorldspaces', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      const provider = new RecordBrowser(repo);
      return { repo, opened: [await soleChild(provider, await soleGroup(provider, SHARED_B), 'the worldspace group')] };
    }, [{ method: 'getWorldspaces', args: [SHARED_B] }], [openedAs('wrld:M.esp')]],
    ['getWorldspaceBlocks', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      repo.setQueryAnswer('getWorldspaceBlocks', {
        topCells: [{ workingTreeState: 'None', formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false }],
        blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false }] }] }],
      });
      repo.setQueryAnswer('getCellChildRecords', { persistent: [], temporary: [] });
      const provider = new RecordBrowser(repo);
      const worldspace = await soleChild(provider, await soleGroup(provider, SHARED_B), 'the worldspace group');
      const [topCellNode, blockNode] = await provider.getChildren(worldspace);
      const [subBlockNode] = await childrenOf(provider, blockNode, 'the block');
      const cellNode = await soleChild(provider, subBlockNode, 'the sub-block');
      await provider.getChildren(cellNode);
      return { repo, opened: [present(topCellNode, 'the top cell'), cellNode] };
    }, [
      { method: 'getWorldspaceBlocks', args: [SHARED_B, 'wrld:M.esp'] }, { method: 'getCellChildRecords', args: [SHARED_B, 'c:M.esp'] },
    ], [openedAs('top:M.esp'), openedAs('c:M.esp')]],
    ['getCellChildRecords', async () => {
      const repo = makeClient();
      repo.setQueryAnswer('getCellChildRecords', {
        persistent: [{ workingTreeState: 'None', formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
        temporary: [],
      });
      const provider = new RecordBrowser(repo);
      const node = await interiorCellRow(repo, provider, interiorCell('c:M.esp', 'TheCell'), SHARED_B);
      const groupNode = await soleChild(provider, node, 'the cell');
      return { repo, opened: [await soleChild(provider, groupNode, 'the placed group')] };
    }, [{ method: 'getCellChildRecords', args: [SHARED_B, 'c:M.esp'] }], [openedAs('b:M.esp')]],
    ['getInteriorCells', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'cell', count: 1 }] });
      repo.setQueryAnswer('getInteriorCells', oneSubBlock([interiorCell('i:M.esp', 'IntCell', { hasChildren: true })]));
      const provider = new RecordBrowser(repo);
      const [cellNode] = await interiorCellsBeneath(provider, await soleGroup(provider, SHARED_B));
      await provider.getChildren(present(cellNode, 'the sole cell'));
      return { repo, opened: [present(cellNode, 'the sole cell')] };
    }, [
      { method: 'getInteriorCells', args: [SHARED_B] }, { method: 'getCellChildRecords', args: [SHARED_B, 'i:M.esp'] },
    ], [openedAs('i:M.esp')]],
  ])('%s: asks for the node\'s own plugin, and the rows it builds carry that origin forward', async (_query, walk, calls, openedArgs) => {
    const { repo, opened } = await walk();

    expect(repo.calls).toEqual(expect.arrayContaining(calls));
    expect(opened.map(openedArguments)).toEqual(openedArgs);
  });

  it('caches each plugin\'s cell references separately, so one plugin\'s page is never served for the other', async () => {
    const repo = makeClient();
    const provider = new RecordBrowser(repo);
    const cell = interiorCell('c:M.esp', 'TheCell');
    const fromA = await interiorCellRow(repo, provider, cell, { name: 'Shared.esp', origin: 'ModA' });
    const fromB = await interiorCellRow(repo, provider, cell, { name: 'Shared.esp', origin: 'ModB' });

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getCellChildRecords')).toHaveLength(2);
  });

  it('caches each plugin\'s interior cells separately, so one plugin\'s cells are never served for the other', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 1 }] });
    const provider = new RecordBrowser(repo);
    const fromA = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModA' });
    const fromB = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModB' });

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(2);
  });

  it('a cell row and a placed-reference row of a shared filename, expanded concurrently, read their own plugin\'s editable/read-only facts, not the other plugin\'s', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }] });
    repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: true, fullName: null, hasParseFailure: false }],
      blocks: [],
    });
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ workingTreeState: 'None', formKey: 'p:M.esp', editorId: 'DoorRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new RecordBrowser(repo);
    const EDITABLE: PluginConditions = { editable: true };
    const READ_ONLY: PluginConditions = { editable: false };

    const [fromA, fromB] = await Promise.all([
      rowsBeneath(provider, { name: 'Shared.esp', origin: 'ModA' }, EDITABLE),
      rowsBeneath(provider, { name: 'Shared.esp', origin: 'ModB' }, READ_ONLY),
    ]);
    const rowOf = (nodes: RecordBrowserNode[], kind: string) =>
      present(nodes.find((n) => String(n.contextValue).split(' ')[0] === kind), `the ${kind} row`);
    const cellOf = (nodes: RecordBrowserNode[]) => rowOf(nodes, 'cell');
    const placedOf = (nodes: RecordBrowserNode[]) => rowOf(nodes, 'placed');
    const cellA = cellOf(fromA);
    const placedA = placedOf(fromA);
    const cellB = cellOf(fromB);
    const placedB = placedOf(fromB);

    expect(cellA.contextValue).toBe('cell editable container');
    expect(openedArguments(cellA)).toMatchObject([{ argument: { plugin: { origin: 'ModA' } } }]);
    expect(placedA.contextValue).toBe('placed editable');
    expect(openedArguments(placedA)).toMatchObject([{ argument: { plugin: { origin: 'ModA' } } }]);
    expect(cellB.contextValue).toBe('cell container');
    expect(openedArguments(cellB)).toMatchObject([{ argument: { plugin: { origin: 'ModB' } } }]);
    expect(placedB.contextValue).toBe('placed');
    expect(openedArguments(placedB)).toMatchObject([{ argument: { plugin: { origin: 'ModB' } } }]);
  });

});

describe('a plugin of a shared filename browses its own children', () => {
  const sharedClient = () => listsForThePluginAsked(makeClient({ recordTypes: [{ type: 'weap', count: 1 }] }));

  it('asks for the plugin the row stands for', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'weap', count: 1 }] });
    const provider = new RecordBrowser(repo);

    await provider.getPluginChildren({ name: 'Shared.esp', origin: 'ModB' }, NOT_EDITABLE);

    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: [{ name: 'Shared.esp', origin: 'ModB' }] });
  });

  it('carries that plugin through to its record pages', async () => {
    const repo = sharedClient();
    const provider = new RecordBrowser(repo);

    const typeNode = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModB' });
    await provider.getChildren(typeNode);

    expect(repo.calls).toContainEqual({ method: 'getRecords', args: [{ name: 'Shared.esp', origin: 'ModB' }, 'weap', 0, expect.any(Number)] });
  });

  it('caches each plugin separately, so one plugin\'s page is never served for the other', async () => {
    const repo = sharedClient();
    const provider = new RecordBrowser(repo);

    const fromA = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModA' });
    const fromB = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModB' });
    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(2);
  });

  it('caches one plugin once, whatever case its filename and origin arrive in, as MO2 and a Windows filesystem compare them', async () => {
    const repo = sharedClient();
    const provider = new RecordBrowser(repo);

    const asListed = await soleGroup(provider, { name: 'Shared.esp', origin: 'ModA' });
    const recased = await soleGroup(provider, { name: 'shared.ESP', origin: 'moda' });
    await provider.getChildren(asListed);
    await provider.getChildren(recased);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
  });
});

function makeContainerChild(
  formKey: string, recordType: string, editorId: string | null = null, hasContainerChildren = false,
): ContainerChildSummary {
  return {
    formKey, editorId, plugin: 'Plugin0.esp', origin: 'Data/',
    loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', recordType, hasContainerChildren, isContainer: CONTAINER_TYPES.has(recordType),
    hasParseFailure: false,
  };
}

describe('which record rows are containers is mEdit\'s answer', () => {
  it('a group mEdit calls a container lists container rows that expand into their children, whatever the type', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'xxxx', count: 1, isContainer: true }], records: { items: [makeRecord(0, 'None', true)], total: 1 } });
    repo.setQueryAnswer('getContainerChildren', [makeContainerChild('child1:Fallout4.esm', 'yyyy')]);
    const provider = new RecordBrowser(repo);
    const [typeNode] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);
    const [row] = await provider.getChildren(present(typeNode, 'the sole group'));

    const children = await provider.getChildren(present(row, 'the sole record row'));

    expect(present(row, 'the sole record row').contextValue).toBe('record container');
    expect(children.map((c) => c.description)).toEqual(['child1:Fallout4.esm']);
  });

  it('a group mEdit calls no container lists leaves, whatever the type', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'qust', count: 1, isContainer: false }], records: { items: [makeRecord(0, 'None', true)], total: 1 } });
    const provider = new RecordBrowser(repo);
    const [typeNode] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);

    const [row] = await provider.getChildren(present(typeNode, 'the sole group'));

    expect(present(row, 'the sole record row').contextValue).toBe('record');
    expect(present(row, 'the sole record row').collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it.each([
    ['a container with children of a type no container has', 'xxxx', true, true, 'record container', TreeItemCollapsibleState.Collapsed],
    ['a container with no children', 'dial', true, false, 'record container', TreeItemCollapsibleState.None],
    ['no container, of a type a container has', 'dial', false, true, 'record', TreeItemCollapsibleState.None],
  ])('a container\'s child expands as mEdit answers for it: %s', async (_label, recordType, isContainer, hasContainerChildren, contextValue, collapsibleState) => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('child1:Fallout4.esm', recordType, null, hasContainerChildren), isContainer }]);
    const { provider, row } = await containerRowOver(makeRecord(0, 'None', true), 'Data/', repo);

    const children = await provider.getChildren(row);

    expect(children.map((c) => [c.contextValue, c.collapsibleState])).toEqual([[contextValue, collapsibleState]]);
  });
});

describe('a container row\'s children', () => {
  it('a quest row expands into ordinary record rows', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'),
      makeContainerChild('dlbr1:Fallout4.esm', 'dlbr', 'BranchA'),
    ]);
    const { provider, row } = await containerRowOver({ ...makeRecord(0, 'None', true), formKey: 'qust1:Fallout4.esm' }, 'Data/', repo);

    const children = await provider.getChildren(row);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: [{ name: 'Plugin0.esp', origin: 'Data/' }, 'qust1:Fallout4.esm'] });
    expect(children.map(c => c.label)).toEqual(['TopicA', 'BranchA']);
    expect(present(children[0], 'the first child').command).toMatchObject({ command: 'modbench.record.open' });
  });

  it('a container\'s listed child answers its working-tree state and is named as read', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'), workingTreeState: 'Added' }]);
    const { provider, row } = await containerRowOver({ ...makeRecord(0, 'None', true), formKey: 'qust1:Fallout4.esm' }, 'Data/', repo);
    const read: (readonly unknown[])[] = [];
    provider.onDidReadRecords((uris) => read.push(uris));

    const [child] = await provider.getChildren(row);

    const uri = recordResourceUri({ name: 'Plugin0.esp', origin: 'Data/' }, 'dial1:Fallout4.esm');
    expect(present(child, 'the listed child').resourceUri).toEqual(uri);
    expect(read).toEqual([[uri]]);
    expect(provider.workingTreeStateOf(uri)).toBe('Added');
  });

  it('two plugins that share a filename browse their own children independently', async () => {
    const repo = makeClient();
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-a:Shared.esp', 'dial', 'TopicModA')]);
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-b:Shared.esp', 'dial', 'TopicModB')]);
    const quest = { ...makeRecord(0, 'None', true), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' };
    const provider = new RecordBrowser(repo);
    const a = await containerRowOver(quest, 'ModA', repo, provider);
    const b = await containerRowOver(quest, 'ModB', repo, provider);

    const childrenA = await provider.getChildren(a.row);
    const childrenB = await provider.getChildren(b.row);

    const containerCalls = repo.calls.filter(c => c.method === 'getContainerChildren');
    expect(containerCalls).toHaveLength(2);
    expect(present(containerCalls[0], 'the first getContainerChildren call').args).toEqual([{ name: 'Shared.esp', origin: 'ModA' }, 'qust1:Shared.esp']);
    expect(present(containerCalls[1], 'the second getContainerChildren call').args).toEqual([{ name: 'Shared.esp', origin: 'ModB' }, 'qust1:Shared.esp']);
    expect(childrenA.map(c => c.label)).toEqual(['TopicModA']);
    expect(childrenB.map(c => c.label)).toEqual(['TopicModB']);
  });
});

describe('the failure prefix', () => {
  it('marks a record whose document could not be read, and only that record', async () => {
    const unreadable = { ...makeRecord(0), parseDiagnosis: 'Perk 0000EF — unknown: bad flag', hasParseFailure: true };
    const repo = makeClient({ records: { items: [unreadable, makeRecord(1)], total: 2 } });
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);

    const recordRows = await provider.getChildren(typeNode);
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
    const provider = new RecordBrowser(repo);

    const typeNodes = await provider.getPluginChildren(PLUGIN0, NOT_EDITABLE);
    const perk = present(typeNodes[0], 'the perk type node');
    const weap = present(typeNodes[1], 'the WEAP type node');

    expect(expectInstanceOf(perk.iconPath, ThemeIcon).id).toBe('error');
    expect(perk.description).toBe('2');
    expect(weap.iconPath).toEqual(new ThemeIcon('blank'));
  });

  it('marks the whole worldspace chain a failure sits under, and nothing beside it', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1, hasParseFailure: true }] });
    repo.setQueryAnswer('getWorldspaces', [
      { workingTreeState: 'None', formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: true, hasChildren: true },
      { workingTreeState: 'None', formKey: 'other:M.esp', editorId: 'Other', hasParseFailure: false, hasChildren: false },
    ]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [{ x: 0, y: 0, hasParseFailure: true, subBlocks: [{ x: 0, y: 0, hasParseFailure: true,
        cells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: null, cellX: 1, cellY: 1, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: true }] }] }],
    });
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ workingTreeState: 'None', formKey: 'p:M.esp', editorId: 'Ref', baseFormKey: null, recordType: 'refr', hasParseFailure: true }],
      temporary: [],
    });
    const provider = new RecordBrowser(repo);

    const [wsRoot] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);
    const [failing, healthy] = await provider.getChildren(wsRoot);
    const [blockNode] = await provider.getChildren(failing);
    const [subBlock] = await provider.getChildren(blockNode);
    const [cellNode] = await provider.getChildren(subBlock);
    const [persistentGroup] = await provider.getChildren(cellNode);
    const [placedNode] = await provider.getChildren(persistentGroup);

    expect([wsRoot, failing, blockNode, subBlock, cellNode, persistentGroup, placedNode, healthy].map((node) => node?.iconPath))
      .toEqual([...Array<unknown>(7).fill(ERROR_ICON), undefined]);
  });

  it('marks an interior cell that cannot be read, and its group node', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, hasParseFailure: true }] });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([
      interiorCell('bad:M.esp', 'Bad', { hasParseFailure: true }),
      interiorCell('ok:M.esp', 'Ok'),
    ]));
    const provider = new RecordBrowser(repo);

    const [interiorRootOrUndefined] = await provider.getPluginChildren({ name: 'Plugin0.esp', origin: 'Data/' }, NOT_EDITABLE);
    const interiorRoot = present(interiorRootOrUndefined, 'the interior-cells root');
    const [block] = await provider.getChildren(interiorRoot);
    const [subBlock] = await provider.getChildren(present(block, 'the sole block'));
    const [bad, ok] = await provider.getChildren(present(subBlock, 'the sole sub-block'));

    expect([interiorRoot, block, subBlock, bad, ok].map((node) => node?.iconPath)).toEqual([...Array<unknown>(4).fill(ERROR_ICON), undefined]);
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
    const provider = new RecordBrowser(repo);
    const typeNode = await soleGroup(provider, PLUGIN0);
    const [questRowOrUndefined] = await provider.getChildren(typeNode);
    const questRow = present(questRowOrUndefined, 'the qust row');

    const [childRowOrUndefined] = await provider.getChildren(questRow);
    const childRow = present(childRowOrUndefined, 'the unreadable container child');

    expect(expectInstanceOf(questRow.iconPath, ThemeIcon).id).toBe('error');
    expect(expectInstanceOf(childRow.iconPath, ThemeIcon).id).toBe('error');
    expect(childRow.tooltip).toContain('INFO 12');
  });
});

