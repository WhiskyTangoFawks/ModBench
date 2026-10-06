import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { createdRecordSelection, type RecordPlace } from '../createdRecordSelection';

const PLUGIN = { name: 'MyPatch.esp', origin: 'ModA' };
const NPCS: RecordPlace<string> = { plugin: PLUGIN, recordType: 'npc_' };
const QUEST: RecordPlace<string> = { container: 'quest row' };
const OTHER = '000800:MyPatch.esp';
const NEW = '000900:MyPatch.esp';

function rowsChanged(keys: string[], origin = PLUGIN.origin) {
  return { kind: 'rows-changed', plugin: PLUGIN.name, origin, keys, sequence: 1 };
}

function pluginChanged(origin = PLUGIN.origin) {
  return { kind: 'plugin-changed', plugin: PLUGIN.name, origin, keys: [], sequence: 1 };
}

function harness(shown: (formKey: string) => boolean = () => true) {
  const stream = new InMemoryMEditClient();
  const asked: string[] = [];
  const revealed: string[] = [];
  const selection = createdRecordSelection<string>({
    client: { onNotification: (kind, listener) => stream.onNotification(kind, listener) },
    rowOf: (place, formKey) => {
      asked.push(`${'container' in place ? place.container : place.recordType} ${formKey}`);
      return Promise.resolve(shown(formKey) ? `row ${formKey}` : undefined);
    },
    view: {
      reveal: (row, options) => {
        revealed.push(`${row} ${JSON.stringify(options)}`);
        return Promise.resolve();
      },
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const opened = () => executeCommand.mock.calls;
  return { stream, asked, selection, revealed, settle, opened };
}

const OPEN_NEW = ['modbench.record.open', { formKey: NEW, plugin: PLUGIN }];

beforeEach(() => { executeCommand.mockReset(); });

describe('createdRecordSelection', () => {
  it('selects the new record\'s row once a change to its plugin names it, then opens its plugin\'s copy as a click does', async () => {
    const { stream, asked, selection, revealed, settle, opened } = harness();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(asked).toEqual([`npc_ ${NEW}`]);
    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects at once when the change named the record before mEdit answered the create', async () => {
    const { stream, selection, revealed, settle, opened } = harness();
    const watch = selection.watch(PLUGIN);
    stream.emit(rowsChanged([NEW]));
    await settle();

    watch.select(NPCS, NEW);
    await settle();

    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits past a change before mEdit answered the create that does not name the record', async () => {
    const { stream, asked, selection, settle, opened } = harness();
    const watch = selection.watch(PLUGIN);
    stream.emit(rowsChanged([OTHER]));
    await settle();

    watch.select(NPCS, NEW);
    await settle();
    expect([asked, opened()]).toEqual([[], []]);

    stream.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('finds the row beneath the container the record landed in', async () => {
    const { stream, asked, selection, settle } = harness();
    selection.watch(PLUGIN).select(QUEST, NEW);

    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(asked).toEqual([`quest row ${NEW}`]);
  });

  it('waits past a change to a plugin of the same name from another origin', async () => {
    const { stream, selection, settle, opened } = harness();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW], 'ModB'));
    await settle();
    expect(opened()).toEqual([]);

    stream.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits past a change that does not name the new record', async () => {
    const { stream, selection, settle, opened } = harness();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([OTHER]));
    await settle();
    expect(opened()).toEqual([]);

    stream.emit(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects the new record\'s row by its FormKey once mEdit re-derives its whole plugin, which names no record', async () => {
    const { stream, asked, selection, revealed, settle, opened } = harness();
    selection.watch(PLUGIN).select(QUEST, NEW);

    stream.emit(pluginChanged('ModB'));
    await settle();
    expect(opened()).toEqual([]);

    stream.emit(pluginChanged());
    await settle();

    expect(asked).toEqual([`quest row ${NEW}`]);
    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects at once when mEdit re-derived the plugin before it answered the create', async () => {
    const { stream, selection, settle, opened } = harness();
    const watch = selection.watch(PLUGIN);
    stream.emit(pluginChanged());
    await settle();

    watch.select(NPCS, NEW);
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects nothing at a later change naming the record, once a re-derived plugin settled the watch', async () => {
    const { stream, asked, selection, settle, opened } = harness(() => false);
    selection.watch(PLUGIN).select(NPCS, NEW);
    stream.emit(pluginChanged());
    await settle();

    stream.emit(rowsChanged([NEW]));
    stream.emit(pluginChanged());
    await settle();

    expect(asked).toHaveLength(1);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens a new record no row shows, as when the record filter hides it, selecting nothing', async () => {
    const { stream, selection, revealed, settle, opened } = harness(() => false);
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(revealed).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens once, though the watch names the record again', async () => {
    const { stream, selection, settle, opened } = harness();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    stream.emit(rowsChanged([NEW]));
    await settle();
    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits only for the latest create', async () => {
    const { stream, selection, settle, opened } = harness();
    const first = selection.watch(PLUGIN);
    selection.watch(PLUGIN).select(NPCS, NEW);
    first.select(NPCS, OTHER);

    stream.emit(rowsChanged([OTHER, NEW]));
    await settle();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('stops listening once forgotten', async () => {
    const { stream, asked, selection, settle, opened } = harness();
    const watch = selection.watch(PLUGIN);
    watch.forget();
    watch.select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await settle();

    expect(asked).toEqual([]);
    expect(opened()).toEqual([]);
  });
});
