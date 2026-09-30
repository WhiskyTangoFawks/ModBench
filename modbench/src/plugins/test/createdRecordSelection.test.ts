import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand }, TreeItem, TreeItemCollapsibleState, ThemeIcon, Uri: { from: uriFrom } }));

import { InMemoryMEditClient } from '../../client';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { createdRecordSelection } from '../createdRecordSelection';

const NPCS = { plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' };
const OLD = '000800:MyPatch.esp';
const NEW = '000900:MyPatch.esp';
const OTHER_TYPE = '000901:MyPatch.esp';

function rowsChanged(keys: string[], origin = NPCS.origin) {
  return { kind: 'rows-changed', plugin: NPCS.plugin, origin, keys, sequence: 1 };
}

const page = (...formKeys: string[]) => ({
  items: formKeys.map((formKey) => recordSummaryFixture({ formKey, plugin: NPCS.plugin })), total: formKeys.length,
});

// The Plugins view as the selection reads it: a row for each record the tree shows.
function harness(shown: (formKey: string) => boolean = () => true) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecords', page(OLD));
  client.setQueryAnswer('getActiveFilter', null);
  const revealed: string[] = [];
  const selection = createdRecordSelection<string>({
    client,
    rowOf: (group, formKey) => Promise.resolve(group.recordType === NPCS.recordType && shown(formKey) ? `row ${formKey}` : undefined),
    view: {
      reveal: (row, options) => {
        revealed.push(`${row} ${JSON.stringify(options)}`);
        return Promise.resolve();
      },
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const opened = () => executeCommand.mock.calls;
  return { client, selection, revealed, settle, opened };
}

const OPEN_NEW = ['modbench.record.open', { formKey: NEW, label: NEW }];

beforeEach(() => { executeCommand.mockReset(); });

// plugins.md, Pickers, Create record, story 1: the new record is selected and opens in the record
// panel. The view finds it from the watch, and uses no result of create.
describe('createdRecordSelection', () => {
  it('selects the record its group newly lists at the plugin\'s next change, then opens it as a click does', async () => {
    const { client, selection, revealed, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('reads the group it waits on, by (origin, filename)', async () => {
    const { client, selection } = harness();

    await selection.selectWhenListed(NPCS);

    expect(client.calls.filter((c) => c.method === 'getRecords').map((c) => c.args))
      .toEqual([['MyPatch.esp', 'npc_', 0, expect.any(Number), 'ModA']]);
  });

  it('waits past a change to a plugin of the same name from another origin', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);
    client.setQueryAnswer('getRecords', page(OLD, NEW));

    client.emit(rowsChanged([NEW], 'ModB'));
    await settle();
    expect(opened()).toEqual([]);

    client.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits past a change after which the group lists nothing new', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    client.emit(rowsChanged([OLD, OTHER_TYPE]));
    await settle();
    expect(opened()).toEqual([]);

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens the record, selecting nothing, when the view shows no row for it', async () => {
    const { client, selection, revealed, settle, opened } = harness(() => false);
    await selection.selectWhenListed(NPCS);

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(revealed).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens the one record the change names that the group did not list, when the record filter hides it', async () => {
    const { client, selection, revealed, settle, opened } = harness(() => false);
    await selection.selectWhenListed(NPCS);

    client.setQueryAnswer('getActiveFilter', { sql: 'SELECT 1', source: 'weapons.sql' });
    client.emit(rowsChanged([OLD, NEW]));
    await settle();

    expect(revealed).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens nothing for a record the group does not list while no record filter is in force', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    client.emit(rowsChanged([OTHER_TYPE]));
    await settle();

    expect(opened()).toEqual([]);
  });

  it('opens once, though the watch names the record again', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);
    client.setQueryAnswer('getRecords', page(OLD, NEW));

    client.emit(rowsChanged([NEW]));
    client.emit(rowsChanged([NEW]));
    await settle();
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits only for the latest create', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed({ ...NPCS, recordType: 'acti' });
    await selection.selectWhenListed(NPCS);

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('awaits nothing, and lets create go on, when mEdit cannot list the group', async () => {
    const { client, selection, settle, opened } = harness();
    client.setQueryFailureOnce('getRecords', new Error('mEdit is not running'));

    const forget = await selection.selectWhenListed(NPCS);
    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(forget).toEqual(expect.any(Function));
    expect(opened()).toEqual([]);
  });

  it('waits past a change after which mEdit cannot list the group', async () => {
    const { client, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    client.setQueryFailureOnce('getRecords', new Error('mEdit is not running'));
    client.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([]);

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('hears nothing once forgotten', async () => {
    const { client, selection, settle, opened } = harness();
    const forget = await selection.selectWhenListed(NPCS);
    forget();

    client.setQueryAnswer('getRecords', page(OLD, NEW));
    client.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([]);
  });
});
