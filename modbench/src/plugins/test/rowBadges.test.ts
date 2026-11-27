import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, ThemeColor, ThemeIcon, Uri } from './vscodeHost';
import { indexedOver, pluginsOf, pluginsOver } from './pluginsOver';
import type { WorkingTreeStatesBeneath } from '../../client';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { changeNamesPlugin } from '../../client/test/says';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { waitForMessage } from '../../drivingLib/test/nameFilterViewHarness';
import { settled } from '../../test/eventually';
import { present } from '../../ports/present';
import type { components } from '../../wire/generated/api';

type WorkingTreeState = components['schemas']['WorkingTreeState'];

const PLUGIN = { name: 'Plugin0.esp', origin: 'Data/' };
const NOTHING: WorkingTreeStatesBeneath = { plugin: [], recordTypes: {}, records: {} };
const MODIFIED = new ThemeColor('gitDecoration.modifiedResourceForeground');
const ADDED = new ThemeColor('gitDecoration.addedResourceForeground');
const DOT = { badge: '•', tooltip: 'Contains emphasized items' };

const settle = () => new Promise((resolve) => setImmediate(resolve));
const decorationOf = async (uri: unknown) => (await host.decorate(uri)).find((decoration) => decoration !== undefined);
const failing = (message: string | undefined) => message?.endsWith('Failed to load: boom') === true;
const beneathCalls = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getWorkingTreeStatesBeneath');

interface Worldspace { worldspace?: WorkingTreeState; cell?: WorkingTreeState; placed?: WorkingTreeState }

function holdingWorldspace(client: InMemoryMEditClient, { worldspace = 'None', cell = 'None', placed = 'None' }: Worldspace = {}): void {
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'wrld', count: 1 })]);
  client.setQueryAnswer('getWorldspaces', [{ formKey: 'w:Plugin0.esp', hasParseFailure: false, hasChildren: true, workingTreeState: worldspace }]);
  client.setQueryAnswer('getWorldspaceBlocks', {
    topCells: [],
    blocks: [{
      x: 1, y: 2, hasParseFailure: false,
      subBlocks: [{ x: 3, y: 4, hasParseFailure: false, cells: [
        { formKey: 'c:Plugin0.esp', isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false, workingTreeState: cell },
      ] }],
    }],
  });
  client.setQueryAnswer('getCellChildRecords', {
    persistent: [{ formKey: 'r:Plugin0.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: placed }], temporary: [],
  });
}

async function worldspaceRows(states: Worldspace = {}, beneath = NOTHING) {
  const made = await indexedOver([PLUGIN.name], { origin: PLUGIN.origin });
  holdingWorldspace(made.client, states);
  made.client.setQueryAnswer('getWorkingTreeStatesBeneath', beneath);
  const sole = async (parent: unknown, what: string) => present((await made.rows(parent))[0], what);
  const group = await sole(made.row(PLUGIN.name), 'the group');
  const worldspace = await sole(group, 'the worldspace');
  const block = await sole(worldspace, 'the block');
  const subBlock = await sole(block, 'the sub-block');
  const cell = await sole(subBlock, 'the cell');
  const persistent = await sole(cell, 'the persistent group');
  const placed = await sole(persistent, 'the placed reference');
  const uriOf = async (row: unknown) => (await made.item(row)).resourceUri;
  return { ...made, uriOf, rowsOf: { group, worldspace, block, subBlock, cell, persistent, placed } };
}

describe('the working-tree badge of a row, in git\'s letters', () => {
  it.each<[WorkingTreeState, unknown]>([
    ['None', undefined],
    ['Modified', { badge: 'M', color: MODIFIED, tooltip: 'Modified' }],
    ['Added', { badge: 'A', color: ADDED, tooltip: 'Added' }],
  ])('badges a record whose working-tree state is %s as git does', async (state, decoration) => {
    const { client, rows, row, item } = await indexedOver(['Test.esp']);
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 })]);
    client.setQueryAnswer('getRecords', { items: [{
      formKey: '000800:Test.esp', plugin: 'Test.esp', loadOrderIndex: 0, isWinner: true, editorId: 'Gun', origin: 'ModA',
      workingTreeState: state, hasContainerChildren: false, hasParseFailure: false,
    }], total: 1 });
    const [group] = await rows(row('Test.esp'));
    const [record] = await rows(group);

    expect(await decorationOf((await item(record)).resourceUri)).toEqual(decoration);
  });

  it('shows M on a modified worldspace, A on an added exterior cell and M on a modified placed reference', async () => {
    const { uriOf, rowsOf } = await worldspaceRows({ worldspace: 'Modified', cell: 'Added', placed: 'Modified' });

    const badges = await Promise.all([rowsOf.worldspace, rowsOf.cell, rowsOf.placed].map(async (row) => (await decorationOf(await uriOf(row)))?.badge));

    expect(badges).toEqual(['M', 'A', 'M']);
  });

  it('shows M on a modified interior cell', async () => {
    const { client, rows, row, item } = await indexedOver([PLUGIN.name], { origin: PLUGIN.origin });
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'cell', count: 1 })]);
    client.setQueryAnswer('getInteriorCells', [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [
      { formKey: 'i:Plugin0.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'Modified' },
    ] }] }]);
    const [group] = await rows(row(PLUGIN.name));
    const [block] = await rows(group);
    const [subBlock] = await rows(block);
    const [cell] = await rows(subBlock);

    expect((await decorationOf((await item(cell)).resourceUri))?.badge).toBe('M');
  });

  it('names a row it reads, so a decoration VS Code holds is refreshed', async () => {
    const { client, rows, row, item } = await indexedOver([PLUGIN.name], { origin: PLUGIN.origin });
    holdingWorldspace(client, { worldspace: 'Modified' });
    const [group] = await rows(row(PLUGIN.name));
    const changes = host.decorationChanges();

    const [worldspace] = await rows(group);

    expect(changes).toEqual([[(await item(worldspace)).resourceUri]]);
  });

  it('give the rows they badge an explicit blank icon, or the file icon theme draws one', async () => {
    const { item, rowsOf } = await worldspaceRows();

    const icons = await Promise.all([rowsOf.block, rowsOf.subBlock, rowsOf.persistent].map(async (row) => (await item(row)).iconPath));

    expect(icons).toEqual(Array(3).fill(new ThemeIcon('blank')));
  });
});

describe('a row with changes beneath it', () => {
  async function pluginRow(beneath: WorkingTreeStatesBeneath) {
    const made = await indexedOver(['A.esp']);
    made.client.setQueryAnswer('getWorkingTreeStatesBeneath', beneath);
    return { ...made, uri: (await made.item(made.row('A.esp'))).resourceUri };
  }

  it.each<[string, WorkingTreeState[], unknown]>([
    ['a dot in the modified colour for modifications', ['Modified'], { ...DOT, color: MODIFIED }],
    ['a dot in the added colour for additions alone', ['Added'], { ...DOT, color: ADDED }],
    ['a dot in the modified colour for modifications and additions both', ['Added', 'Modified'], { ...DOT, color: MODIFIED }],
    ['nothing for nothing', [], undefined],
  ])('shows, while collapsed, %s beneath it', async (_case, plugin, decoration) => {
    const { uri } = await pluginRow({ ...NOTHING, plugin });

    expect(await decorationOf(uri)).toEqual(decoration);
  });

  it('is a dot on a plugin row with changes beneath it, only while the row is collapsed', async () => {
    const { uri, view, row } = await pluginRow({ ...NOTHING, plugin: ['Modified'] });

    const collapsed = (await decorationOf(uri))?.badge;
    view().expand(row('A.esp'));
    const expanded = (await decorationOf(uri))?.badge;
    view().collapse(row('A.esp'));

    expect([collapsed, expanded, (await decorationOf(uri))?.badge]).toEqual(['•', undefined, '•']);
  });

  it('shows its own letter rather than the dot when it has a change of its own', async () => {
    const { uriOf, rowsOf } = await worldspaceRows({ worldspace: 'Added' }, { ...NOTHING, records: { 'w:Plugin0.esp': ['Modified'] } });

    expect(await decorationOf(await uriOf(rowsOf.worldspace))).toEqual({ badge: 'A', color: ADDED, tooltip: 'Added' });
  });

  it.each<[string, WorkingTreeState, string | undefined]>([
    ['its own letter still', 'Modified', 'M'],
    ['nothing of what is beneath it', 'None', undefined],
  ])('shows no dot while expanded, and %s', async (_case, state, badge) => {
    const { uriOf, rowsOf, view } = await worldspaceRows({ worldspace: state }, { ...NOTHING, records: { 'w:Plugin0.esp': ['Added'] } });

    view().expand(rowsOf.worldspace);

    expect((await decorationOf(await uriOf(rowsOf.worldspace)))?.badge).toBe(badge);
  });

  it('leaves a locked row its grey, whatever is beneath it', async () => {
    const { client, pluginRows, item } = pluginsOver({
      value: instanceValueFixture({ pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] }),
    });
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'] });
    const row = await pluginRows();

    expect(await host.decorate((await item(row('Fallout4.esm', 'Data/'))).resourceUri)).toEqual([undefined, { color: new ThemeColor('disabledForeground') }]);
  });

  it('asks again of a row once per change, until VS Code asks a decoration of it again', async () => {
    const { client, uri } = await pluginRow(NOTHING);
    await decorationOf(uri);
    const changes = host.decorationChanges();

    changeNamesPlugin(client, { name: 'A.esp', origin: 'ModA' });
    changeNamesPlugin(client, { name: 'A.esp', origin: 'ModA' });
    await settled(() => { expect(changes).toEqual([[uri]]); });
    await settle();

    expect(changes).toEqual([[uri]]);
  });
});

describe('the states beneath a row', () => {
  it('are asked of mEdit once for a plugin while a read is in flight, however many of its rows ask, and kept by no one', async () => {
    const { client, rows, row, item } = await indexedOver(['A.esp']);
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 })]);
    const [group] = await rows(row('A.esp'));
    const uris = [(await item(row('A.esp'))).resourceUri, (await item(group)).resourceUri];

    await Promise.all(uris.map((uri) => host.decorate(uri)));
    const sharedCalls = beneathCalls(client).length;
    await host.decorate(uris[0]);

    expect([sharedCalls, beneathCalls(client).length]).toEqual([1, 2]);
  });

  it('give two blocks of one worldspace two rows', async () => {
    const { client, rows, row, item } = await indexedOver([PLUGIN.name], { origin: PLUGIN.origin });
    holdingWorldspace(client);
    client.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [0, 1].map((x) => ({
        x, y: 0, hasParseFailure: false,
        subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [
          { formKey: `c${x}:Plugin0.esp`, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'None' as const },
        ] }],
      })),
    });
    const [group] = await rows(row(PLUGIN.name));
    const [worldspace] = await rows(group);

    const blocks = await rows(worldspace);

    expect(new Set(await Promise.all(blocks.map(async (block) => String((await item(block)).resourceUri)))).size).toBe(2);
  });

  it('are a record-type group\'s own, read off the group row', async () => {
    const { client, rows, row, item } = await indexedOver(['A.esp']);
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 }), recordTypeCountFixture({ type: 'armo', count: 1 })]);
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'], recordTypes: { weap: ['Added'] } });

    const groups = await rows(row('A.esp'));

    expect(await Promise.all(groups.map(async (group) => decorationOf((await item(group)).resourceUri)))).toEqual([{ ...DOT, color: ADDED }, undefined]);
  });

  it('are a worldspace\'s and a cell\'s by FormKey, and never their own state', async () => {
    const { uriOf, rowsOf } = await worldspaceRows({}, { ...NOTHING, records: { 'w:Plugin0.esp': ['Added'], 'c:Plugin0.esp': ['Modified'] } });

    expect([await decorationOf(await uriOf(rowsOf.worldspace)), await decorationOf(await uriOf(rowsOf.cell))])
      .toEqual([{ ...DOT, color: ADDED }, { ...DOT, color: MODIFIED }]);
  });

  it('are nothing for a block or a group, which stands for no record mEdit names', async () => {
    const { uriOf, rowsOf } = await worldspaceRows({}, { ...NOTHING, plugin: ['Added'], recordTypes: { wrld: ['Added'] } });

    const shown = await Promise.all([rowsOf.block, rowsOf.subBlock, rowsOf.persistent].map(async (row) => decorationOf(await uriOf(row))));

    expect(shown).toEqual([undefined, undefined, undefined]);
  });

  it('keep to the plugin\'s origin, so two plugins of one name answer apart', async () => {
    const { client, pluginRows, item } = pluginsOver({
      value: instanceValueFixture({ plugins: [...pluginsOf(['A.esp']), ...pluginsOf(['A.esp'], 'Data/')] }),
    });
    const row = await pluginRows();

    await host.decorate((await item(row('A.esp', 'ModA'))).resourceUri);
    await host.decorate((await item(row('A.esp', 'Data/'))).resourceUri);

    expect(beneathCalls(client).map(({ args }) => args[0])).toEqual([{ name: 'A.esp', origin: 'ModA' }, { name: 'A.esp', origin: 'Data/' }]);
  });

  it('are nothing when the read fails, and the failure is the message line\'s until a later read lands', async () => {
    const made = await indexedOver(['A.esp']);
    const uri = (await made.item(made.row('A.esp'))).resourceUri;
    made.client.setQueryFailureOnce('getWorkingTreeStatesBeneath', { failed: 'refused', refusal: 'boom' });

    const failed = await decorationOf(uri);
    await waitForMessage(made.view(), failing, 'the failure on the message line');
    made.client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    await decorationOf(uri);

    expect(failed).toBeUndefined();
    await waitForMessage(made.view(), (message) => !failing(message), 'the message line once a read lands');
  });

  it.each([
    ['its plugin', [{ plugin: { name: 'A.esp', origin: 'ModA' } }]],
    ['none', undefined],
  ])('leave a failure of one plugin standing while another plugin reads well, and forget it when a change names %s', async (_case, change) => {
    const made = await indexedOver(['A.esp', 'B.esp']);
    made.client.setQueryFailureOnce('getWorkingTreeStatesBeneath', { failed: 'refused', refusal: 'boom' });
    made.client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    await decorationOf((await made.item(made.row('A.esp'))).resourceUri);
    await decorationOf((await made.item(made.row('B.esp'))).resourceUri);
    await waitForMessage(made.view(), failing, 'the failure standing');

    made.client.change(change);

    await waitForMessage(made.view(), (message) => !failing(message), 'the failure forgotten');
  });

  it('are nothing for a URI that is no row of this browser', async () => {
    const { client } = await indexedOver(['A.esp']);

    expect(await decorationOf(Uri.file('/tmp/x'))).toBeUndefined();
    expect(beneathCalls(client)).toHaveLength(0);
  });
});

describe('the rows that are expanded', () => {
  async function groupRow() {
    const made = await indexedOver(['A.esp']);
    made.client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 })]);
    made.client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, recordTypes: { weap: ['Added'] } });
    const [group] = await made.rows(made.row('A.esp'));
    return { ...made, group, uri: (await made.item(group)).resourceUri };
  }

  it('name the row that expanded or collapsed, so VS Code asks again', async () => {
    const { view, group, uri } = await groupRow();
    const changes = host.decorationChanges();

    view().expand(group);
    view().collapse(group);

    expect(changes).toEqual([[uri], [uri]]);
  });

  it('stay expanded across a refresh, for VS Code keeps them open by their ids', async () => {
    const { client, view, group, uri } = await groupRow();
    view().expand(group);
    const changes = host.decorationChanges();

    client.change(undefined);
    changeNamesPlugin(client, { name: 'A.esp', origin: 'ModA' });
    await settled(() => { expect(changes).toContain(undefined); });

    expect(await decorationOf(uri)).toBeUndefined();
  });
});
