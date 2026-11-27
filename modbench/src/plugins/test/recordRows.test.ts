import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import type * as vscode from 'vscode';
import { host, ThemeIcon, TreeItemCollapsibleState, Uri } from './vscodeHost';
import { pluginArgumentOf } from '../../drivingLib/argument';
import {
  UNLIMITED_RECORDS, type RecordSummary, type CellSummary, type InteriorCellBlock,
  type ChildRecordSummary, type WorldspaceSummary, type PluginAddress,
} from '../../client';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import {
  browserClient, browserOver, type Browsed, type Browser, type BrowserAnswers, type ContainerChildSummary, cellRow, childrenOf, placedRow, recordRow, soleChild,
  soleGroup, worldspaceRow,
} from './browserRows';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';
import { CONTAINER_TYPES, recordTypeCountFixture } from '../../client/test/fixtures';

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

const browsing = (client: InMemoryMEditClient, ...plugins: Browsed[]) => browserOver(client, plugins.length === 0 ? [PLUGIN0] : plugins);

function openedArguments(row: vscode.TreeItem): unknown {
  return row.command?.arguments;
}

const badgeOf = async (uri: unknown) => (await host.decorate(uri)).find((decoration) => decoration?.badge !== undefined)?.badge;

async function containerRowOver(record: RecordSummary, client = makeClient(), origin = 'Data/') {
  const { browser, row } = await recordRow(record, { name: record.plugin, origin }, 'qust', client);
  return { browser, repo: client, row };
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

async function interiorCellsBeneath(browser: Browser, cellGroup: vscode.TreeItem): Promise<vscode.TreeItem[]> {
  const [block] = await browser.children(cellGroup);
  const [subBlock] = await browser.children(present(block, 'the sole block'));
  return browser.children(present(subBlock, 'the sole sub-block'));
}

async function interiorCellRow(repo: InMemoryMEditClient, cell: CellSummary, plugin: Browsed = PLUGIN0) {
  repo.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'cell', count: 1 })]);
  repo.setQueryAnswer('getInteriorCells', oneSubBlock([cell]));
  const browser = await browsing(repo, plugin);
  const [row] = await interiorCellsBeneath(browser, await soleGroup(browser, plugin));
  return { browser, row: present(row, 'the interior cell row') };
}

async function rowsBeneath(browser: Browser, plugin: PluginAddress): Promise<vscode.TreeItem[]> {
  const states: vscode.TreeItem[] = [];
  const walk = async (nodes: readonly vscode.TreeItem[]): Promise<void> => {
    for (const node of nodes) {
      if (/^(recordType|record|worldspace|cell|placed)( |$)/.test(String(node.contextValue))) states.push(node);
      if (Number(node.collapsibleState) !== TreeItemCollapsibleState.None) await walk(await browser.children(node));
    }
  };
  await walk(await browser.pluginChildren(plugin));
  return states;
}

describe('a plugin\'s children, one group per record type', () => {
  it('returns one group per record type', async () => {
    const browser = await browsing(makeClient({ recordTypes: [{ type: 'weap', count: 10 }, { type: 'npc_', count: 3 }] }));

    const children = await browser.pluginChildren(PLUGIN0);

    expect(children.map(c => [c.label, c.description])).toEqual([['weap', '10'], ['npc_', '3']]);
  });

  it('builds the Worldspace and Cell groups as record-type groups of their type, so they offer create as any group does', async () => {
    const browser = await browsing(makeClient({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'cell', count: 2 }] }), { ...PLUGIN0, editable: true });

    const groups = await browser.pluginChildren(PLUGIN0);

    expect(groups.map(g => [g.label, g.contextValue])).toEqual([
      ['wrld', 'recordType editable creatable'],
      ['cell', 'recordType editable creatable'],
    ]);
  });
});

describe('a plugin\'s children — an answer that is no failed read', () => {
  it('shows a row that cannot be built as no error row, and reaches the caller', async () => {
    const client = makeClient();
    client.setQueryAnswer('getRecordTypes', [{ ...recordTypeCountFixture({ type: 'weap', count: 1 }), get type(): string { throw new Error('the row broke'); } }]);
    const browser = await browsing(client);

    await expect(browser.pluginChildren(PLUGIN0)).rejects.toThrow('the row broke');
  });

  it('shows a failed read as the one error row', async () => {
    const client = makeClient();
    client.setQueryAnswer('getRecordTypes', { failed: 'unreachable' });
    const browser = await browsing(client);

    const children = await browser.pluginChildren(PLUGIN0);

    expect(children.map(c => c.contextValue)).toEqual(['error']);
  });
});

describe('a record-type group\'s children', () => {
  it('lists a row for every record, from one unpaged read', async () => {
    const repo = makeClient({ records: { items: [makeRecord(0), makeRecord(1), makeRecord(2)], total: 3 } });
    const browser = await browsing(repo);

    const children = await browser.children(await soleGroup(browser, PLUGIN0));

    expect(children.map(c => c.label)).toEqual(['Record0', 'Record1', 'Record2']);
    expect(repo.calls.filter(c => c.method === 'getRecords').map(c => c.args)).toEqual([[PLUGIN0, 'weap', 0, UNLIMITED_RECORDS]]);
  });

  it('a "qust" row is expandable only when its own record holds children, not by its record type alone', async () => {
    const browser = await browsing(makeClient({
      recordTypes: [{ type: 'qust', count: 2 }],
      records: {
        items: [
          { ...makeRecord(0, 'None', true), formKey: 'qustWithChildren:Fallout4.esm' },
          { ...makeRecord(1, 'None', false), formKey: 'qustWithoutChildren:Fallout4.esm' },
        ],
        total: 2,
      },
    }));

    const children = await browser.children(await soleGroup(browser, PLUGIN0));

    expect(children.map(c => [c.description, c.collapsibleState])).toEqual([
      ['qustWithChildren:Fallout4.esm', TreeItemCollapsibleState.Collapsed],
      ['qustWithoutChildren:Fallout4.esm', TreeItemCollapsibleState.None],
    ]);
  });
});

describe('a record-type group\'s children — no per-row fan-out for container presence', () => {
  it('reads a group of containers once and asks nothing per row for its children', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'qust', count: 2 }], records: { items: [makeRecord(0, 'None', true), makeRecord(1, 'None', false)], total: 2 } });
    const browser = await browsing(repo);

    const children = await browser.children(await soleGroup(browser, PLUGIN0));

    expect(children).toHaveLength(2);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls.some(c => c.method === 'getContainerChildren')).toBe(false);
  });
});

describe('a record-type group row', () => {
  const groupOf = async (type: { type: string; count: number; displayName?: string; isCreatable?: boolean }) =>
    soleGroup(await browsing(makeClient({ recordTypes: [type] })), PLUGIN0);

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
  const rowOf = async (record: RecordSummary, origin = 'Data/', editable = false) => (await recordRow(record, { name: record.plugin, origin, editable })).row;

  it('opens, and carries as its Argument, its own copy: its record\'s plugin in the row\'s origin', async () => {
    const record = makeRecord(0);

    const row = await rowOf(record, 'ModA');

    expect(row).toMatchObject({
      command: {
        command: 'modbench.record.open',
        title: 'Open Record',
        arguments: [{ argument: { kind: 'record', formKey: record.formKey, plugin: { name: 'Plugin0.esp', origin: 'ModA' } } }],
      },
      argument: { kind: 'record', plugin: { name: 'Plugin0.esp', origin: 'ModA' }, formKey: record.formKey },
    });
  });

  it.each<[string, RecordSummary, boolean, string]>([
    ['an editable record', makeRecord(0), true, 'record editable'],
    ['an override as the plugin\'s own records', { ...makeRecord(0), plugin: 'PatchMod.esp' }, true, 'record editable'],
    ['a record of an immutable plugin read-only', makeRecord(0), false, 'record'],
  ])('states %s', async (_label, record, editable, contextValue) => {
    expect((await rowOf(record, 'Data/', editable)).contextValue).toBe(contextValue);
  });

  it('carries a medit-record: resourceUri identifying (plugin, origin, formKey)', async () => {
    const row = await rowOf(makeRecord(0), 'ModA');

    expect(row.resourceUri).toMatchObject({ scheme: 'medit-record', path: '/Plugin0.esp/ModA/000000%3AFallout4.esm' });
  });
});

describe('every row is named as xEdit names it', () => {
  const A_ESP: PluginAddress = { name: 'A.esp', origin: 'ModA' };
  const UNREADABLE = 'This record could not be read into its document: bad flag';
  const unreadable = { hasParseFailure: true, parseDiagnosis: 'bad flag' };

  const record = async (overrides: Partial<RecordSummary>) => (await recordRow({ ...makeRecord(0), plugin: 'A.esp', ...overrides }, A_ESP)).row;
  const worldspace = (overrides: Partial<WorldspaceSummary>) => worldspaceRow(
    { workingTreeState: 'None', formKey: '000100:A.esp', hasParseFailure: false, hasChildren: false, ...overrides }, A_ESP,
  );
  const cell = (overrides: Partial<CellSummary>) => cellRow(
    { formKey: '000101:A.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'None', ...overrides }, A_ESP,
  );
  const interior = async (overrides: Partial<CellSummary>) => (await interiorCellRow(makeClient(), interiorCell('000201:A.esp', null, overrides))).row;
  const placed = (overrides: Partial<ChildRecordSummary>) => placedRow(
    { formKey: '000301:A.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'None', ...overrides }, A_ESP,
  );
  const containerChild = async (overrides: Partial<ContainerChildSummary>) => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('000501:A.esp', 'dial'), ...overrides }]);
    const { browser, row } = await containerRowOver(makeRecord(0, 'None', true), repo);
    return soleChild(browser, row, 'the container');
  };

  it.each<[string, () => Promise<vscode.TreeItem>, [unknown, unknown, unknown]]>([
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
    const browser = await browsing(repo);
    const typeNode = await soleGroup(browser, PLUGIN0);
    return { browser, typeNode, read: host.decorationChanges() };
  }

  it('names each row of a group it reads from mEdit, by the row\'s own resource URI', async () => {
    const { browser, typeNode, read } = await readGroup(makeClient({ records: { items: [makeRecord(0, 'Modified')], total: 1 } }));

    const [row] = await browser.children(typeNode);

    const uri = present(row, 'the record row').resourceUri;
    expect([read, await badgeOf(uri)]).toEqual([[[uri]], 'M']);
  });

  it('asks mEdit each time VS Code asks for the group, and keeps no listing', async () => {
    const repo = makeClient();
    const { browser, typeNode } = await readGroup(repo);
    await browser.children(typeNode);

    await browser.children(typeNode);

    expect(repo.calls.filter((call) => call.method === 'getRecords')).toHaveLength(2);
  });

  it('names the rows again, with mEdit\'s new state, when a refresh makes the group read again', async () => {
    const record = makeRecord(0, 'None');
    const repo = makeClient({ records: { items: [record], total: 1 } });
    const { browser, typeNode, read } = await readGroup(repo);
    const [row] = await browser.children(typeNode);

    repo.setQueryAnswer('getRecords', { items: [{ ...record, workingTreeState: 'Modified' }], total: 1 });
    repo.change(undefined);
    await browser.children(typeNode);

    const uri = present(row, 'the record row').resourceUri;
    expect(read.filter((changed) => Array.isArray(changed))).toEqual([[uri], [uri]]);
    expect(await badgeOf(uri)).toBe('M');
  });

  it('badges an override-stack row under the plugin that owns its copy, not the plugin browsed', async () => {
    const override = { ...makeRecord(0, 'Modified'), plugin: 'Other.esp' };
    const { browser, typeNode } = await readGroup(makeClient({ records: { items: [override], total: 1 } }));

    const [row] = await browser.children(typeNode);

    expect([present(row, 'the override row').resourceUri?.path, await badgeOf(row?.resourceUri)]).toEqual(['/Other.esp/Data%2F/000000%3AFallout4.esm', 'M']);
  });

  it('a record nothing has cached yet has no working-tree state', async () => {
    await readGroup(makeClient({ records: { items: [makeRecord(0, 'Modified')], total: 1 } }));

    expect(await badgeOf(Uri.parse('medit-record:/Plugin0.esp/Data%2F/000000%3AFallout4.esm'))).toBeUndefined();
  });

  it('a URI outside the medit-record: scheme has no working-tree state', async () => {
    const { browser, typeNode } = await readGroup(makeClient({ records: { items: [makeRecord(0, 'Modified')], total: 1 } }));
    const [row] = await browser.children(typeNode);

    expect(await badgeOf(Uri.file(present(row?.resourceUri, 'the row\'s URI').path))).toBeUndefined();
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
    const browser = await browsing(repo, A_ESP);
    const worldspace = await soleChild(browser, await soleGroup(browser, A_ESP), 'the worldspace group');
    const cell = await soleChild(browser, worldspace, 'the worldspace');
    const placed = await soleChild(browser, await soleChild(browser, cell, 'the cell'), 'the placed group');
    return { worldspace, cell, placed };
  }

  it.each(['worldspace', 'cell', 'placed'] as const)('a %s row', async (which) => {
    const row = (await spatialRowsOver())[which];

    expect(row).toMatchObject({
      label: 'World', description: '000801:A.esp', argument: { kind: 'record', plugin: { name: 'A.esp', origin: 'ModA' }, formKey: '000801:A.esp' },
    });
    expect(row.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record',
      arguments: [{ argument: { kind: 'record', formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } } }],
    });
  });
});

describe('a plugin\'s conditions reach every row beneath it', () => {
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
    const states = (await rowsBeneath(await browsing(spatialClient(), { ...PLUGIN0, editable: true }), PLUGIN0)).map((n) => String(n.contextValue));

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
    const browser = await browsing(repo);
    const typeNode = await soleGroup(browser, PLUGIN0);
    const labelsBeneath = async () => (await browser.children(typeNode)).map((n) => n.label);
    const before = await labelsBeneath();
    const redrawn: unknown[] = [];
    browser.view().treeDataProvider.onDidChangeTreeData?.((row) => redrawn.push(row));

    repo.setQueryAnswer('getRecords', { items: [makeRecord(0), makeRecord(1)], total: 2 });
    repo.change(undefined);

    expect([before, redrawn.includes(undefined), await labelsBeneath()]).toEqual([['Record0'], true, ['Record0', 'Record1']]);
  });
});

describe('refreshing the browser for named plugins', () => {
  const OTHER: PluginAddress = { name: 'Other.esp', origin: 'Data/' };

  async function browsedBoth() {
    const row = (plugin: PluginAddress) => ({ ...makeRecord(0, 'Modified'), formKey: '000000:Fallout4.esm', plugin: plugin.name });
    const repo = makeClient({ records: { items: [row(PLUGIN0)], total: 1 } });
    const browser = await browsing(repo, PLUGIN0, OTHER);
    const [ours] = await browser.children(await soleGroup(browser, PLUGIN0));
    repo.setQueryAnswer('getRecords', { items: [row(OTHER)], total: 1 });
    const [theirs] = await browser.children(await soleGroup(browser, OTHER));
    const redrawn: unknown[] = [];
    browser.view().treeDataProvider.onDidChangeTreeData?.((changed) => redrawn.push(changed));
    const badges = async () => [await badgeOf(ours?.resourceUri), await badgeOf(theirs?.resourceUri)];
    return { browser, repo, redrawn, badges };
  }

  it('makes the named plugin\'s rows forget their own state and leaves every other\'s, and leaves redrawing to the plugin row\'s owner', async () => {
    const { repo, redrawn, badges } = await browsedBoth();

    repo.change([{ plugin: PLUGIN0 }]);

    expect([await badges(), redrawn.map((row) => pluginArgumentOf(row)?.plugin)]).toEqual([[undefined, 'M'], [PLUGIN0, PLUGIN0]]);
  });

  it('makes every plugin\'s rows forget their own state, and redraws the tree, for a change that names none', async () => {
    const { repo, redrawn, badges } = await browsedBoth();

    repo.change(undefined);

    expect([await badges(), redrawn.includes(undefined)]).toEqual([[undefined, undefined], true]);
  });
});

describe('the worldspace tree', () => {
  it('expands a worldspace into every cell outside a block, then its blocks, labeled the way xEdit does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [
        { workingTreeState: 'None', formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false },
        { workingTreeState: 'None', formKey: 'stray:M.esp', editorId: 'StrayCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false },
      ],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }] }],
    });
    const browser = await browsing(repo);
    const wsNode = await soleChild(browser, await soleGroup(browser, PLUGIN0), 'the worldspace group');

    const wsChildren = await browser.children(wsNode);
    const subBlocks = await childrenOf(browser, wsChildren[2], 'the block');
    const cells = await childrenOf(browser, subBlocks[0], 'the sub-block');

    expect(wsChildren.map((row) => row.label)).toEqual(['TopCell', 'StrayCell', 'Block 0, 0']);
    expect(present(subBlocks[0], "the fixture's single sub-block").label).toBe('Sub-Block 0, 0');
    const RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL = '< 12,  -5>';
    expect(present(cells[0], "the fixture's single cell").label).toBe(RIGHT_JUSTIFIED_WIDTH_3_COORDINATES_LABEL);
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellChildRecords', {
      persistent: [{ workingTreeState: 'None', formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const { browser, row: cellNode } = await interiorCellRow(repo, interiorCell('c:M.esp', 'TheCell'));

    const groups = await browser.children(cellNode);
    const placed = await childrenOf(browser, groups[0], 'the sole group');

    expect([groups.map((group) => group.label), placed.map((row) => row.label)]).toEqual([['Persistent'], ['barrelRef']]);
  });

  it('nests the Cell group as blocks, then sub-blocks, then cells, labelled as xEdit labels them, from one read', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, displayName: 'Cell' }] });
    repo.setQueryAnswer('getInteriorCells', [
      ...oneSubBlock([interiorCell('a:M.esp', 'RoomA')], 0, 1),
      ...oneSubBlock([interiorCell('b:M.esp', 'RoomB')], 3, 7),
    ]);
    const browser = await browsing(repo);

    const blocks = await browser.children(await soleGroup(browser, PLUGIN0));
    const subBlocks = await childrenOf(browser, blocks[1], 'the second block');
    const cells = await childrenOf(browser, subBlocks[0], 'its sole sub-block');

    expect(blocks.map(b => b.label)).toEqual(['Block 0', 'Block 3']);
    expect(subBlocks.map(b => b.label)).toEqual(['Sub-Block 7']);
    expect(cells.map(c => c.label)).toEqual(['RoomB']);
    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(1);
  });

  it('gives a worldspace an expander only when a cell is beneath it', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 2 }] });
    repo.setQueryAnswer('getWorldspaces', [
      { workingTreeState: 'None', formKey: 'w1:M.esp', editorId: 'Holding', hasParseFailure: false, hasChildren: true },
      { workingTreeState: 'None', formKey: 'w2:M.esp', editorId: 'Empty', hasParseFailure: false, hasChildren: false },
    ]);
    const browser = await browsing(repo);

    const worldspaces = await browser.children(await soleGroup(browser, PLUGIN0));

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
    const browser = await browsing(repo);

    const cells = await interiorCellsBeneath(browser, await soleGroup(browser, PLUGIN0));

    expect(cells.map(c => [c.label, c.collapsibleState])).toEqual([
      ['Holding', TreeItemCollapsibleState.Collapsed],
      ['Empty', TreeItemCollapsibleState.None],
    ]);
  });

  it('gives a group an expander only when it holds a record', async () => {
    const browser = await browsing(makeClient({ recordTypes: [{ type: 'weap', count: 1 }, { type: 'npc_', count: 0 }] }));

    const groups = await browser.pluginChildren(PLUGIN0);

    expect(groups.map(g => g.collapsibleState)).toEqual([TreeItemCollapsibleState.Collapsed, TreeItemCollapsibleState.None]);
  });
});

describe('a failed fetch', () => {
  const BOOM = { failed: 'refused', refusal: 'boom' } as const;
  const groupBeneath = async (repo: InMemoryMEditClient) => {
    const browser = await browsing(repo);
    return { browser, group: await soleGroup(browser, PLUGIN0) };
  };

  it.each<[string, () => Promise<vscode.TreeItem[]>]>([
    ['getRecordTypes', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getRecordTypes', BOOM);
      return (await browsing(repo)).pluginChildren(PLUGIN0);
    }],
    ['getRecords', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getRecords', BOOM);
      const { browser, group } = await groupBeneath(repo);
      return browser.children(group);
    }],
    ['getWorldspaces', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryFailure('getWorldspaces', BOOM);
      const { browser, group } = await groupBeneath(repo);
      return browser.children(group);
    }],
    ['getWorldspaceBlocks', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      repo.setQueryFailure('getWorldspaceBlocks', BOOM);
      const { browser, group } = await groupBeneath(repo);
      return browser.children(await soleChild(browser, group, 'the worldspace group'));
    }],
    ['getCellChildRecords', async () => {
      const repo = makeClient();
      repo.setQueryFailure('getCellChildRecords', BOOM);
      const { browser, row } = await interiorCellRow(repo, interiorCell('c:M.esp', 'TheCell'));
      return browser.children(row);
    }],
    ['getInteriorCells', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'cell', count: 1 }] });
      repo.setQueryFailure('getInteriorCells', BOOM);
      const { browser, group } = await groupBeneath(repo);
      return browser.children(group);
    }],
  ])('renders an error node when %s fails', async (_query, expand) => {
    const children = await expand();

    expect(children.map(c => [c.contextValue, c.label])).toEqual(FAILED_TO_LOAD);
  });
});

describe('spatial rows of a shared filename', () => {
  const SHARED_B: PluginAddress = { name: 'Shared.esp', origin: 'ModB' };
  type Walk = { repo: InMemoryMEditClient; opened: vscode.TreeItem[] };
  const openedAs = (formKey: string) => [{ argument: { kind: 'record', formKey, plugin: SHARED_B } }];

  it.each<[string, () => Promise<Walk>, { method: string; args: unknown[] }[], unknown[]]>([
    ['getWorldspaces', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      const browser = await browsing(repo, SHARED_B);
      return { repo, opened: [await soleChild(browser, await soleGroup(browser, SHARED_B), 'the worldspace group')] };
    }, [{ method: 'getWorldspaces', args: [SHARED_B] }], [openedAs('wrld:M.esp')]],
    ['getWorldspaceBlocks', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
      repo.setQueryAnswer('getWorldspaces', [WORLDSPACE_OF_M]);
      repo.setQueryAnswer('getWorldspaceBlocks', {
        topCells: [{ workingTreeState: 'None', formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasChildren: false, hasParseFailure: false }],
        blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false }] }] }],
      });
      repo.setQueryAnswer('getCellChildRecords', { persistent: [], temporary: [] });
      const browser = await browsing(repo, SHARED_B);
      const worldspace = await soleChild(browser, await soleGroup(browser, SHARED_B), 'the worldspace group');
      const [topCellNode, blockNode] = await browser.children(worldspace);
      const [subBlockNode] = await childrenOf(browser, blockNode, 'the block');
      const cellNode = await soleChild(browser, subBlockNode, 'the sub-block');
      await browser.children(cellNode);
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
      const { browser, row } = await interiorCellRow(repo, interiorCell('c:M.esp', 'TheCell'), SHARED_B);
      const groupNode = await soleChild(browser, row, 'the cell');
      return { repo, opened: [await soleChild(browser, groupNode, 'the placed group')] };
    }, [{ method: 'getCellChildRecords', args: [SHARED_B, 'c:M.esp'] }], [openedAs('b:M.esp')]],
    ['getInteriorCells', async () => {
      const repo = makeClient({ recordTypes: [{ type: 'cell', count: 1 }] });
      repo.setQueryAnswer('getInteriorCells', oneSubBlock([interiorCell('i:M.esp', 'IntCell', { hasChildren: true })]));
      const browser = await browsing(repo, SHARED_B);
      const [cellNode] = await interiorCellsBeneath(browser, await soleGroup(browser, SHARED_B));
      await browser.children(present(cellNode, 'the sole cell'));
      return { repo, opened: [present(cellNode, 'the sole cell')] };
    }, [
      { method: 'getInteriorCells', args: [SHARED_B] }, { method: 'getCellChildRecords', args: [SHARED_B, 'i:M.esp'] },
    ], [openedAs('i:M.esp')]],
  ])('%s: asks for the node\'s own plugin, and the rows it builds carry that origin forward', async (_query, walk, calls, openedArgs) => {
    const { repo, opened } = await walk();

    expect(repo.calls).toEqual(expect.arrayContaining(calls));
    expect(opened.map(openedArguments)).toEqual(openedArgs);
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
    const SHARED_A = { name: 'Shared.esp', origin: 'ModA' };
    const browser = await browsing(repo, { ...SHARED_A, editable: true }, SHARED_B);

    const [fromA, fromB] = await Promise.all([rowsBeneath(browser, SHARED_A), rowsBeneath(browser, SHARED_B)]);
    const rowOf = (nodes: vscode.TreeItem[], kind: string) =>
      present(nodes.find((n) => String(n.contextValue).split(' ')[0] === kind), `the ${kind} row`);
    const stated = (nodes: vscode.TreeItem[]) => ['cell', 'placed'].map((kind) => {
      const row = rowOf(nodes, kind);
      return [row.contextValue, openedArguments(row)];
    });

    expect([stated(fromA), stated(fromB)]).toMatchObject([
      [['cell editable container', [{ argument: { plugin: { origin: 'ModA' } } }]], ['placed editable', [{ argument: { plugin: { origin: 'ModA' } } }]]],
      [['cell container', [{ argument: { plugin: { origin: 'ModB' } } }]], ['placed', [{ argument: { plugin: { origin: 'ModB' } } }]]],
    ]);
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
    const browser = await browsing(repo);
    const row = await soleChild(browser, await soleGroup(browser, PLUGIN0), 'the sole group');

    const children = await browser.children(row);

    expect(row.contextValue).toBe('record container');
    expect(children.map((c) => c.description)).toEqual(['child1:Fallout4.esm']);
  });

  it('a group mEdit calls no container lists leaves, whatever the type', async () => {
    const browser = await browsing(makeClient({ recordTypes: [{ type: 'qust', count: 1, isContainer: false }], records: { items: [makeRecord(0, 'None', true)], total: 1 } }));

    const row = await soleChild(browser, await soleGroup(browser, PLUGIN0), 'the sole group');

    expect([row.contextValue, row.collapsibleState]).toEqual(['record', TreeItemCollapsibleState.None]);
  });

  it.each([
    ['a container with children of a type no container has', 'xxxx', true, true, 'record container', TreeItemCollapsibleState.Collapsed],
    ['a container with no children', 'dial', true, false, 'record container', TreeItemCollapsibleState.None],
    ['no container, of a type a container has', 'dial', false, true, 'record', TreeItemCollapsibleState.None],
  ])('a container\'s child expands as mEdit answers for it: %s', async (_label, recordType, isContainer, hasContainerChildren, contextValue, collapsibleState) => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('child1:Fallout4.esm', recordType, null, hasContainerChildren), isContainer }]);
    const { browser, row } = await containerRowOver(makeRecord(0, 'None', true), repo);

    const children = await browser.children(row);

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
    const { browser, row } = await containerRowOver({ ...makeRecord(0, 'None', true), formKey: 'qust1:Fallout4.esm' }, repo);

    const children = await browser.children(row);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: [{ name: 'Plugin0.esp', origin: 'Data/' }, 'qust1:Fallout4.esm'] });
    expect(children.map(c => c.label)).toEqual(['TopicA', 'BranchA']);
    expect(present(children[0], 'the first child').command).toMatchObject({ command: 'modbench.record.open' });
  });

  it('a container\'s listed child answers its working-tree state and is named as read', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [{ ...makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'), workingTreeState: 'Added' }]);
    const { browser, row } = await containerRowOver({ ...makeRecord(0, 'None', true), formKey: 'qust1:Fallout4.esm' }, repo);
    const read = host.decorationChanges();

    const [child] = await browser.children(row);

    const uri = present(child, 'the listed child').resourceUri;
    expect([uri?.path, read, await badgeOf(uri)]).toEqual(['/Plugin0.esp/Data%2F/dial1%3AFallout4.esm', [[uri]], 'A']);
  });

  it('two plugins that share a filename browse their own children independently', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'qust', count: 1 }] });
    const quest = { ...makeRecord(0, 'None', true), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' };
    repo.setQueryAnswer('getRecords', { items: [quest], total: 1 });
    const browser = await browsing(repo, { name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' });
    const a = await soleChild(browser, await soleGroup(browser, { name: 'Shared.esp', origin: 'ModA' }), 'the group of ModA');
    const b = await soleChild(browser, await soleGroup(browser, { name: 'Shared.esp', origin: 'ModB' }), 'the group of ModB');
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-a:Shared.esp', 'dial', 'TopicModA')]);
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-b:Shared.esp', 'dial', 'TopicModB')]);

    const childrenA = await browser.children(a);
    const childrenB = await browser.children(b);

    expect(repo.calls.filter(c => c.method === 'getContainerChildren').map(({ args }) => args)).toEqual([
      [{ name: 'Shared.esp', origin: 'ModA' }, 'qust1:Shared.esp'], [{ name: 'Shared.esp', origin: 'ModB' }, 'qust1:Shared.esp'],
    ]);
    expect([childrenA.map(c => c.label), childrenB.map(c => c.label)]).toEqual([['TopicModA'], ['TopicModB']]);
  });
});

describe('the failure prefix', () => {
  it('marks a record whose document could not be read, and only that record', async () => {
    const unreadable = { ...makeRecord(0), parseDiagnosis: 'Perk 0000EF — unknown: bad flag', hasParseFailure: true };
    const browser = await browsing(makeClient({ records: { items: [unreadable, makeRecord(1)], total: 2 } }));

    const [failed, healthy] = await browser.children(await soleGroup(browser, PLUGIN0));

    expect(expectInstanceOf(failed?.iconPath, ThemeIcon).id).toBe('error');
    expect(failed?.tooltip).toContain('Perk 0000EF — unknown: bad flag');
    expect(healthy?.iconPath).toBeUndefined();
  });

  it('marks the record-type node holding an unreadable record, and only that node', async () => {
    const browser = await browsing(makeClient({
      recordTypes: [
        { type: 'perk', count: 2, displayName: 'Perk', hasParseFailure: true },
        { type: 'weap', count: 5, displayName: 'Weapon', hasParseFailure: false },
      ],
    }));

    const [perk, weap] = await browser.pluginChildren(PLUGIN0);

    expect(expectInstanceOf(perk?.iconPath, ThemeIcon).id).toBe('error');
    expect(perk?.description).toBe('2');
    expect(weap?.iconPath).toEqual(new ThemeIcon('blank'));
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
    const browser = await browsing(repo);

    const wsRoot = await soleGroup(browser, PLUGIN0);
    const [failing, healthy] = await browser.children(wsRoot);
    const blockNode = await soleChild(browser, failing, 'the failing worldspace');
    const subBlock = await soleChild(browser, blockNode, 'the block');
    const cellNode = await soleChild(browser, subBlock, 'the sub-block');
    const persistentGroup = await soleChild(browser, cellNode, 'the cell');
    const placedNode = await soleChild(browser, persistentGroup, 'the persistent group');

    expect([wsRoot, failing, blockNode, subBlock, cellNode, persistentGroup, placedNode, healthy].map((node) => node?.iconPath))
      .toEqual([...Array<unknown>(7).fill(ERROR_ICON), undefined]);
  });

  it('marks an interior cell that cannot be read, and its group node', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, hasParseFailure: true }] });
    repo.setQueryAnswer('getInteriorCells', oneSubBlock([
      interiorCell('bad:M.esp', 'Bad', { hasParseFailure: true }),
      interiorCell('ok:M.esp', 'Ok'),
    ]));
    const browser = await browsing(repo);

    const interiorRoot = await soleGroup(browser, PLUGIN0);
    const block = await soleChild(browser, interiorRoot, 'the interior-cells root');
    const subBlock = await soleChild(browser, block, 'the sole block');
    const [bad, ok] = await childrenOf(browser, subBlock, 'the sole sub-block');

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
    const browser = await browsing(repo);
    const questRow = await soleChild(browser, await soleGroup(browser, PLUGIN0), 'the qust group');

    const childRow = await soleChild(browser, questRow, 'the qust row');

    expect(expectInstanceOf(questRow.iconPath, ThemeIcon).id).toBe('error');
    expect(expectInstanceOf(childRow.iconPath, ThemeIcon).id).toBe('error');
    expect(childRow.tooltip).toContain('INFO 12');
  });
});
