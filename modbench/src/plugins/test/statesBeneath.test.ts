import { describe, it, expect, vi } from 'vitest';
import type { WorkingTreeStatesBeneath } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import * as vscode from 'vscode';
import { soleChild, soleGroup } from './browserRows';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';
import { rowResourceUri } from '../recordResourceUri';
import type { PluginAddress } from '../../wire/pluginAddress';
import { present } from '../../ports/present';
import { settled } from '../../test/settled';

const PLUGIN: PluginAddress = { name: 'Plugin0.esp', origin: 'Data/' };
const NOTHING: WorkingTreeStatesBeneath = { plugin: [], recordTypes: {}, records: {} };

const uriOf = (row: RecordBrowserNode | undefined) => present(present(row, 'the row').resourceUri, 'the row\'s resourceUri');

async function askedTwice(browser: RecordBrowser, uri: vscode.Uri) {
  const before = browser.statesBeneathOf(uri);
  await settled();
  return { before, after: browser.statesBeneathOf(uri) };
}

const beneathCalls = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getWorkingTreeStatesBeneath');

function worldspaceClient(beneath: WorkingTreeStatesBeneath) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'wrld', count: 1 })]);
  client.setQueryAnswer('getWorkingTreeStatesBeneath', beneath);
  client.setQueryAnswer('getWorldspaces', [{ formKey: 'w:Plugin0.esp', hasParseFailure: false, hasChildren: true, workingTreeState: 'None' }]);
  client.setQueryAnswer('getWorldspaceBlocks', {
    topCells: [],
    blocks: [{
      x: 1, y: 2, hasParseFailure: false,
      subBlocks: [{ x: 3, y: 4, hasParseFailure: false, cells: [
        { formKey: 'c:Plugin0.esp', isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false, workingTreeState: 'Added' },
      ] }],
    }],
  });
  client.setQueryAnswer('getCellChildRecords', {
    persistent: [{ formKey: 'r:Plugin0.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'Modified' }], temporary: [],
  });
  return client;
}

async function worldspaceRows(browser: RecordBrowser) {
  const worldspace = await soleChild(browser, await soleGroup(browser, PLUGIN), 'the group');
  const block = await soleChild(browser, worldspace, 'the worldspace');
  const subBlock = await soleChild(browser, block, 'the block');
  const cell = await soleChild(browser, subBlock, 'the sub-block');
  const persistent = await soleChild(browser, cell, 'the cell');
  return { worldspace, block, subBlock, cell, persistent };
}

describe('the states beneath a row', () => {
  it('are nothing until mEdit answers, then the plugin row\'s, and the answer is announced', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified', 'Added'] });
    const browser = new RecordBrowser(client);
    const announced = vi.fn();
    browser.onDidReadBeneath(announced);

    const { before, after } = await askedTwice(browser, rowResourceUri(PLUGIN));

    expect([before, after, announced.mock.calls.length]).toEqual([[], ['Modified', 'Added'], 1]);
  });

  it('are asked of mEdit once for a plugin, however many of its rows ask', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    const browser = new RecordBrowser(client);

    browser.statesBeneathOf(rowResourceUri(PLUGIN));
    browser.statesBeneathOf(rowResourceUri(PLUGIN, 'weap'));
    await settled();

    expect(beneathCalls(client)).toHaveLength(1);
  });

  it('are a record-type group\'s own, read off the group row', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 }), recordTypeCountFixture({ type: 'armo', count: 1 })]);
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'], recordTypes: { weap: ['Added'] } });
    const browser = new RecordBrowser(client);
    const [weap, armo] = await browser.getPluginChildren(PLUGIN);

    const weapons = await askedTwice(browser, uriOf(weap));

    expect([weapons.after, browser.statesBeneathOf(uriOf(armo))]).toEqual([['Added'], []]);
  });

  it('are a worldspace\'s and a cell\'s by FormKey, and never their own state', async () => {
    const browser = new RecordBrowser(worldspaceClient({ ...NOTHING, records: { 'w:Plugin0.esp': ['Added'], 'c:Plugin0.esp': ['Modified'] } }));
    const { worldspace, cell } = await worldspaceRows(browser);

    await askedTwice(browser, uriOf(worldspace));

    expect([browser.statesBeneathOf(uriOf(worldspace)), browser.statesBeneathOf(uriOf(cell))]).toEqual([['Added'], ['Modified']]);
  });

  it('fold a block\'s and a sub-block\'s from the cells they hold, own state and beneath alike', async () => {
    const browser = new RecordBrowser(worldspaceClient({ ...NOTHING, records: { 'c:Plugin0.esp': ['Modified'] } }));
    const { block, subBlock } = await worldspaceRows(browser);

    await askedTwice(browser, uriOf(block));

    expect([browser.statesBeneathOf(uriOf(block)), browser.statesBeneathOf(uriOf(subBlock))])
      .toEqual([['Added', 'Modified'], ['Added', 'Modified']]);
  });

  it('fold a cell\'s placed group from the references it lists', async () => {
    const browser = new RecordBrowser(worldspaceClient(NOTHING));
    const { persistent } = await worldspaceRows(browser);

    expect((await askedTwice(browser, uriOf(persistent))).after).toEqual(['Modified']);
  });

  it('fold an interior block from the cells it holds', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'cell', count: 1 })]);
    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    client.setQueryAnswer('getInteriorCells', [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [
      { formKey: 'i:Plugin0.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'Modified' },
    ] }] }]);
    const browser = new RecordBrowser(client);
    const block = await soleChild(browser, await soleGroup(browser, PLUGIN), 'the group');
    const subBlock = await soleChild(browser, block, 'the block');

    await askedTwice(browser, uriOf(block));

    expect([browser.statesBeneathOf(uriOf(block)), browser.statesBeneathOf(uriOf(subBlock))]).toEqual([['Modified'], ['Modified']]);
  });

  it('give two blocks of one worldspace two rows', async () => {
    const client = worldspaceClient(NOTHING);
    client.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [0, 1].map((x) => ({
        x, y: 0, hasParseFailure: false,
        subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [
          { formKey: `c${x}:Plugin0.esp`, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: x === 0 ? 'Added' as const : 'None' as const },
        ] }],
      })),
    });
    const browser = new RecordBrowser(client);
    const worldspace = await soleChild(browser, await soleGroup(browser, PLUGIN), 'the group');
    const [first, second] = await browser.getChildren(worldspace);

    await askedTwice(browser, uriOf(first));

    expect([browser.statesBeneathOf(uriOf(first)), browser.statesBeneathOf(uriOf(second))]).toEqual([['Added'], []]);
  });

  it('keep to the plugin\'s origin, so two plugins of one name answer apart', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'] });
    const browser = new RecordBrowser(client);
    const modded = await askedTwice(browser, rowResourceUri({ name: PLUGIN.name, origin: 'ModA' }));

    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    const data = await askedTwice(browser, rowResourceUri(PLUGIN));

    expect([modded.after, data.after]).toEqual([['Modified'], []]);
  });

  it('keep the last answer on show while a refresh re-reads, then take the new one', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'] });
    const browser = new RecordBrowser(client);
    const row = rowResourceUri(PLUGIN);
    await askedTwice(browser, row);

    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    browser.refresh();
    const during = browser.statesBeneathOf(row);
    await settled();

    expect([during, browser.statesBeneathOf(row)]).toEqual([['Modified'], []]);
  });

  it('are announced by a refresh, so every row asks again', () => {
    const browser = new RecordBrowser(new InMemoryMEditClient());
    const announced = vi.fn();
    browser.onDidReadBeneath(announced);

    browser.refresh();

    expect(announced).toHaveBeenCalledTimes(1);
  });

  it('drop an answer a refresh overtook', async () => {
    const client = new InMemoryMEditClient();
    let release: (answer: WorkingTreeStatesBeneath) => void = () => undefined;
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', new Promise<WorkingTreeStatesBeneath>((resolve) => { release = resolve; }));
    const browser = new RecordBrowser(client);
    const row = rowResourceUri(PLUGIN);
    browser.statesBeneathOf(row);

    browser.refresh();
    release({ ...NOTHING, plugin: ['Modified'] });
    await settled();

    expect(browser.statesBeneathOf(row)).toEqual([]);
  });

  it('log a failed first read and say so on the message line, as the error row would, without asking again until a refresh', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getWorkingTreeStatesBeneath', new Error('boom'));
    const log = vi.fn();
    const browser = new RecordBrowser(client, log);
    const said = vi.fn();
    browser.beneathFailure.onMessageChanged(said);
    const row = rowResourceUri(PLUGIN);

    const { after } = await askedTwice(browser, row);
    browser.statesBeneathOf(row);
    await settled();

    expect(after).toEqual([]);
    expect(browser.beneathFailure.message()).toBe('Failed to load: boom');
    expect(said).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(beneathCalls(client)).toHaveLength(1);
  });

  it('keep the last answer on show when a re-read fails, and clear the message when a later read lands', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'] });
    const browser = new RecordBrowser(client);
    const row = rowResourceUri(PLUGIN);
    await askedTwice(browser, row);

    client.setQueryFailureOnce('getWorkingTreeStatesBeneath', new Error('boom'));
    browser.refresh();
    browser.statesBeneathOf(row);
    await settled();
    const failed = [browser.statesBeneathOf(row), browser.beneathFailure.message()];

    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    browser.refresh();
    browser.statesBeneathOf(row);
    await settled();

    expect(failed).toEqual([['Modified'], 'Showing the last good read: boom']);
    expect(browser.beneathFailure.message()).toBeUndefined();
  });

  it('forget a failure at each refresh, so a plugin that left the tree leaves the message line', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getWorkingTreeStatesBeneath', new Error('boom'));
    const browser = new RecordBrowser(client);
    await askedTwice(browser, rowResourceUri(PLUGIN));
    const said = vi.fn();
    browser.beneathFailure.onMessageChanged(said);

    browser.refresh();

    expect([browser.beneathFailure.message(), said.mock.calls.length]).toEqual([undefined, 1]);
  });

  it('forget the blocks it folded when a refresh begins, until the tree lists them again', async () => {
    const browser = new RecordBrowser(worldspaceClient(NOTHING));
    const { block } = await worldspaceRows(browser);
    await askedTwice(browser, uriOf(block));
    const before = browser.statesBeneathOf(uriOf(block));

    browser.refresh();
    await settled();

    expect([before, browser.statesBeneathOf(uriOf(block))]).toEqual([['Added'], []]);
  });

  it('give the rows they badge an explicit blank icon, or the file icon theme draws one', async () => {
    const browser = new RecordBrowser(worldspaceClient(NOTHING));
    const { block, subBlock, persistent } = await worldspaceRows(browser);

    expect([block, subBlock, persistent].map((row) => row.iconPath)).toEqual(Array(3).fill(new ThemeIcon('blank')));
  });

  it('are nothing for a URI that is no row of this browser', () => {
    const client = new InMemoryMEditClient();
    const browser = new RecordBrowser(client);

    expect(browser.statesBeneathOf(fakeUri('/tmp/x'))).toEqual([]);
    expect(beneathCalls(client)).toHaveLength(0);
  });
});

describe('the rows that are expanded', () => {
  const row = rowResourceUri(PLUGIN, 'weap');
  const browserWithGroup = async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 })]);
    client.setQueryAnswer('getRecords', { items: [], total: 0 });
    const browser = new RecordBrowser(client);
    return { browser, group: present((await browser.getPluginChildren(PLUGIN))[0], 'the group') };
  };

  it('are the ones VS Code says it expanded, until it says it collapsed them', () => {
    const browser = new RecordBrowser(new InMemoryMEditClient());
    const states = [browser.isExpanded(row)];
    browser.expandedRow(row);
    states.push(browser.isExpanded(row));
    browser.collapsedRow(row);
    states.push(browser.isExpanded(row));

    expect(states).toEqual([false, true, false]);
  });

  it('name the row that expanded or collapsed, so VS Code asks again', () => {
    const browser = new RecordBrowser(new InMemoryMEditClient());
    const read = vi.fn();
    browser.onDidReadRecords(read);

    browser.expandedRow(row);
    browser.collapsedRow(row);

    expect(read.mock.calls).toEqual([[[row]], [[row]]]);
  });

  it('stay expanded across a refresh once the tree reopens them', async () => {
    const { browser, group } = await browserWithGroup();
    const uri = uriOf(group);
    browser.expandedRow(uri);

    browser.refresh();
    const forgotten = browser.isExpanded(uri);
    browser.reopen(uri);

    expect([forgotten, browser.isExpanded(uri)]).toEqual([false, true]);
  });

  it('are forgotten by a refresh the tree does not reopen them after', async () => {
    const { browser, group } = await browserWithGroup();
    browser.expandedRow(uriOf(group));

    browser.refresh();
    browser.refresh();

    expect(browser.isExpanded(uriOf(group))).toBe(false);
  });

  it('are not brought back by a walk of the children of a row that was collapsed', async () => {
    const { browser, group } = await browserWithGroup();
    browser.expandedRow(uriOf(group));
    browser.refresh();
    browser.collapsedRow(uriOf(group));

    browser.reopen(uriOf(group));

    expect(browser.isExpanded(uriOf(group))).toBe(false);
  });

  it('include a plugin row', async () => {
    const { browser } = await browserWithGroup();
    browser.expandedRow(rowResourceUri(PLUGIN));

    browser.refresh();
    browser.reopen(rowResourceUri(PLUGIN));

    expect(browser.isExpanded(rowResourceUri(PLUGIN))).toBe(true);
  });
});
