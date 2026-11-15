import { describe, it, expect, vi } from 'vitest';
import type { WorkingTreeStatesBeneath } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri,
}));

import { NOT_EDITABLE, soleChild, soleGroup } from './browserRows';
import { RecordBrowser, type RecordBrowserNode } from '../RecordBrowser';
import { rowResourceUri } from '../recordResourceUri';
import type { PluginAddress } from '../../wire/pluginAddress';
import { present } from '../../ports/present';

const PLUGIN: PluginAddress = { name: 'Plugin0.esp', origin: 'Data/' };
const NOTHING: WorkingTreeStatesBeneath = { plugin: [], recordTypes: {}, records: {} };

const uriOf = (row: RecordBrowserNode | undefined) => present(present(row, 'the row').resourceUri, 'the row\'s resourceUri');

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
  it('are the plugin row\'s, as mEdit answers when asked', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified', 'Added'] });
    const browser = new RecordBrowser(client);

    expect(await browser.statesBeneathOf(rowResourceUri(PLUGIN))).toEqual(['Modified', 'Added']);
  });

  it('are asked of mEdit each time, and kept by no one', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    const browser = new RecordBrowser(client);

    await browser.statesBeneathOf(rowResourceUri(PLUGIN));
    await browser.statesBeneathOf(rowResourceUri(PLUGIN));

    expect(beneathCalls(client)).toHaveLength(2);
  });

  it('are a record-type group\'s own, read off the group row', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 1 }), recordTypeCountFixture({ type: 'armo', count: 1 })]);
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'], recordTypes: { weap: ['Added'] } });
    const browser = new RecordBrowser(client);
    const [weap, armo] = await browser.getPluginChildren(PLUGIN, NOT_EDITABLE);

    expect([await browser.statesBeneathOf(uriOf(weap)), await browser.statesBeneathOf(uriOf(armo))]).toEqual([['Added'], []]);
  });

  it('are a worldspace\'s and a cell\'s by FormKey, and never their own state', async () => {
    const browser = new RecordBrowser(worldspaceClient({ ...NOTHING, records: { 'w:Plugin0.esp': ['Added'], 'c:Plugin0.esp': ['Modified'] } }));
    const { worldspace, cell } = await worldspaceRows(browser);

    expect([await browser.statesBeneathOf(uriOf(worldspace)), await browser.statesBeneathOf(uriOf(cell))]).toEqual([['Added'], ['Modified']]);
  });

  it('are nothing for a block or a group, which stands for no record mEdit names', async () => {
    const browser = new RecordBrowser(worldspaceClient({ ...NOTHING, plugin: ['Added'], recordTypes: { wrld: ['Added'] } }));
    const { block, subBlock, persistent } = await worldspaceRows(browser);

    expect([
      await browser.statesBeneathOf(uriOf(block)), await browser.statesBeneathOf(uriOf(subBlock)), await browser.statesBeneathOf(uriOf(persistent)),
    ]).toEqual([[], [], []]);
  });

  it('keep to the plugin\'s origin, so two plugins of one name answer apart', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', { ...NOTHING, plugin: ['Modified'] });
    const browser = new RecordBrowser(client);
    const modded = await browser.statesBeneathOf(rowResourceUri({ name: PLUGIN.name, origin: 'ModA' }));

    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);

    expect([modded, await browser.statesBeneathOf(rowResourceUri(PLUGIN))]).toEqual([['Modified'], []]);
  });

  it('are nothing when the read fails, and the failure is the message line\'s until a later read lands', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailureOnce('getWorkingTreeStatesBeneath', { failed: 'refused', refusal: 'boom' });
    const browser = new RecordBrowser(client);
    const told = vi.fn();
    browser.beneathFailure.onMessageChanged(told);

    const failed = await browser.statesBeneathOf(rowResourceUri(PLUGIN));
    const whileFailing = browser.beneathFailure.message();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    await browser.statesBeneathOf(rowResourceUri(PLUGIN));

    expect([failed, whileFailing, browser.beneathFailure.message(), told.mock.calls.length]).toEqual([[], 'Failed to load: boom', undefined, 2]);
  });

  it('leave a failure of one plugin standing while another plugin reads well, and forget it when a refresh names its plugin', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailureOnce('getWorkingTreeStatesBeneath', { failed: 'refused', refusal: 'boom' });
    client.setQueryAnswer('getWorkingTreeStatesBeneath', NOTHING);
    const browser = new RecordBrowser(client);
    await browser.statesBeneathOf(rowResourceUri(PLUGIN));
    await browser.statesBeneathOf(rowResourceUri({ name: 'Other.esp', origin: 'Data/' }));
    const standing = browser.beneathFailure.message();

    browser.refresh([PLUGIN]);

    expect([standing, browser.beneathFailure.message()]).toEqual(['Failed to load: boom', undefined]);
  });

  it('are announced by a refresh, so every row asks again', () => {
    const browser = new RecordBrowser(new InMemoryMEditClient());
    const announced = vi.fn();
    browser.onDidReadBeneath(announced);

    browser.refresh();

    expect(announced).toHaveBeenCalledTimes(1);
  });

  it('give the rows they badge an explicit blank icon, or the file icon theme draws one', async () => {
    const browser = new RecordBrowser(worldspaceClient(NOTHING));
    const { block, subBlock, persistent } = await worldspaceRows(browser);

    expect([block, subBlock, persistent].map((row) => row.iconPath)).toEqual(Array(3).fill(new ThemeIcon('blank')));
  });

  it('are nothing for a URI that is no row of this browser', async () => {
    const client = new InMemoryMEditClient();
    const browser = new RecordBrowser(client);

    expect(await browser.statesBeneathOf(Uri.file('/tmp/x'))).toEqual([]);
    expect(beneathCalls(client)).toHaveLength(0);
  });
});

describe('the rows that are expanded', () => {
  const row = rowResourceUri(PLUGIN, 'weap');

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

  it('stay expanded across a refresh, for VS Code keeps them open by their ids', () => {
    const browser = new RecordBrowser(new InMemoryMEditClient());
    browser.expandedRow(row);

    browser.refresh();
    browser.refresh([PLUGIN]);

    expect(browser.isExpanded(row)).toBe(true);
  });
});
