import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { InMemoryMEditClient, UNLIMITED_RECORDS, type MEditClient } from '../../client';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { createdRecordSelection } from '../createdRecordSelection';

const NPCS = { plugin: { name: 'MyPatch.esp', origin: 'ModA' }, recordType: 'npc_' };
const OLD = '000800:MyPatch.esp';
const HIDDEN = '000801:MyPatch.esp';
const NEW = '000900:MyPatch.esp';
const OTHER_TYPE = '000901:MyPatch.esp';

function rowsChanged(keys: string[], origin = NPCS.plugin.origin) {
  return { kind: 'rows-changed', plugin: NPCS.plugin.name, origin, keys, sequence: 1 };
}

const page = (formKeys: readonly string[]) => ({
  items: formKeys.map((formKey) => recordSummaryFixture({ formKey, plugin: NPCS.plugin.name })), total: formKeys.length,
});

// mEdit as the selection reads it: the group's records, and among them the ones the record filter
// shows.
function harness(shown: (formKey: string) => boolean = () => true) {
  const stream = new InMemoryMEditClient();
  const group = { records: [OLD] as string[], failure: undefined as Error | undefined };
  const reads: unknown[][] = [];
  const getRecords: MEditClient['getRecords'] = (...args) => {
    reads.push(args);
    if (group.failure) return Promise.reject(group.failure);
    return Promise.resolve(page(args[5]?.unfiltered === true ? group.records : group.records.filter(shown)));
  };
  const reporter = recordingReporter();
  const revealed: string[] = [];
  const selection = createdRecordSelection<string>({
    client: { subscribe: (kind, listener) => stream.subscribe(kind, listener), getRecords },
    reporter,
    rowOf: (address, formKey) => Promise.resolve(address.recordType === NPCS.recordType && shown(formKey) ? `row ${formKey}` : undefined),
    view: {
      reveal: (row, options) => {
        revealed.push(`${row} ${JSON.stringify(options)}`);
        return Promise.resolve();
      },
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const opened = () => executeCommand.mock.calls;
  return { stream, group, reads, reporter, selection, revealed, settle, opened };
}

const OPEN_NEW = ['modbench.record.open', { formKey: NEW }];

beforeEach(() => { executeCommand.mockReset(); });

// plugins.md, Pickers, Create record, story 1: the new record is selected and opens in the record
// panel. The view finds it from the watch, and uses no result of create.
describe('createdRecordSelection', () => {
  it('selects the record its group newly lists at the plugin\'s next change, then opens it as a click does', async () => {
    const { stream, group, selection, revealed, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('reads the whole group it waits on, by (origin, filename), what the record filter hides too', async () => {
    const { reads, selection } = harness();

    await selection.selectWhenListed(NPCS);

    expect(reads).toEqual([['MyPatch.esp', 'npc_', 0, UNLIMITED_RECORDS, 'ModA', { unfiltered: true }]]);
  });

  it('waits past a change to a plugin of the same name from another origin', async () => {
    const { stream, group, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);
    group.records.push(NEW);

    stream.emit(rowsChanged([NEW], 'ModB'));
    await settle();
    expect(opened()).toEqual([]);

    stream.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits past a change after which the group lists nothing new', async () => {
    const { stream, group, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    stream.emit(rowsChanged([OLD, OTHER_TYPE]));
    await settle();
    expect(opened()).toEqual([]);

    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  // Never silently wrong: a change the watch brings first is not the new record.
  it.each([['of another type', OTHER_TYPE], ['of this type that the filter hides', HIDDEN]])(
    'opens nothing for a changed record %s while a record filter is in force', async (_what, changed) => {
      const { stream, group, selection, settle, opened } = harness((formKey) => formKey === OLD);
      group.records.push(HIDDEN);
      await selection.selectWhenListed(NPCS);

      stream.emit(rowsChanged([changed]));
      await settle();
      group.records.push(NEW);
      stream.emit(rowsChanged([NEW]));
      await settle();

      expect(opened()).toEqual([OPEN_NEW]);
    });

  it('opens a new record the record filter hides, selecting nothing', async () => {
    const { stream, group, selection, revealed, settle, opened } = harness((formKey) => formKey === OLD);
    await selection.selectWhenListed(NPCS);

    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(revealed).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens once, though the watch names the record again', async () => {
    const { stream, group, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);
    group.records.push(NEW);

    stream.emit(rowsChanged([NEW]));
    stream.emit(rowsChanged([NEW]));
    await settle();
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits only for the latest create', async () => {
    const { stream, group, selection, settle, opened } = harness();
    await selection.selectWhenListed({ ...NPCS, recordType: 'acti' });
    await selection.selectWhenListed(NPCS);

    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('says it will not select the new record when mEdit cannot list its group, and lets create go on', async () => {
    const { stream, group, reporter, selection, settle, opened } = harness();
    group.failure = new Error('mEdit is not running');

    await selection.selectWhenListed(NPCS);
    group.failure = undefined;
    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Could not select and open the new npc_ record in "MyPatch.esp".', detail: 'mEdit is not running',
    }]);
    expect(opened()).toEqual([]);
  });

  it('says it did not select the new record when mEdit cannot list its group after the change, and stops waiting', async () => {
    const { stream, group, reporter, selection, settle, opened } = harness();
    await selection.selectWhenListed(NPCS);

    group.failure = new Error('mEdit is not running');
    stream.emit(rowsChanged([NEW]));
    await settle();
    group.failure = undefined;
    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Could not select and open the new npc_ record in "MyPatch.esp".', detail: 'mEdit is not running',
    }]);
    expect(opened()).toEqual([]);
  });

  it('stops listening once forgotten', async () => {
    const { stream, group, reads, selection, settle, opened } = harness();
    const forget = await selection.selectWhenListed(NPCS);
    forget();

    group.records.push(NEW);
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(reads).toHaveLength(1);
    expect(opened()).toEqual([]);
  });
});
