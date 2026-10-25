import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('vscode', () => ({ commands: { executeCommand } }));

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { notificationEventFixture } from '../../client/test/fixtures';
import { createdRecordSelection, type RecordPlace } from '../createdRecordSelection';

const PLUGIN = { name: 'MyPatch.esp', origin: 'ModA' };
const NPCS: RecordPlace<string> = { plugin: PLUGIN, recordType: 'npc_' };
const QUEST: RecordPlace<string> = { container: 'quest row' };
const OTHER = '000800:MyPatch.esp';
const NEW = '000900:MyPatch.esp';

const rowsChanged = (keys: string[], origin = PLUGIN.origin) => notificationEventFixture({ kind: 'rows-changed', plugin: PLUGIN.name, origin, keys });
const pluginChanged = (origin = PLUGIN.origin) => notificationEventFixture({ kind: 'plugin-changed', plugin: PLUGIN.name, origin });

function harness(shown: (formKey: string) => boolean = () => true) {
  const stream = new InMemoryMEditClient();
  const asked: string[] = [];
  const revealed: string[] = [];
  const selection = createdRecordSelection<string>({
    client: stream,
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
  const opened = () => executeCommand.mock.calls;
  const opening = () => new Promise<void>((resolve) => { executeCommand.mockImplementationOnce(() => { resolve(); }); });
  return { stream, asked, selection, revealed, opened, opening };
}

const aWindow = () => new Promise((resolve) => setTimeout(resolve, 0));

const OPEN_NEW = ['modbench.record.open', { argument: { kind: 'record', formKey: NEW, plugin: PLUGIN } }];

beforeEach(() => { executeCommand.mockReset(); });

describe('createdRecordSelection', () => {
  it('selects the new record\'s row once a change to its plugin names it, then opens its plugin\'s copy as a click does', async () => {
    const { stream, asked, selection, revealed, opened, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await open;

    expect(asked).toEqual([`npc_ ${NEW}`]);
    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens the new record without selecting a row when the gesture came from outside the Plugins tree', async () => {
    const { stream, asked, selection, revealed, opened, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(undefined, NEW);

    stream.emit(rowsChanged([NEW]));
    await open;

    expect([asked, revealed]).toEqual([[], []]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it.each([
    ['a change naming the record', rowsChanged([NEW])],
    ['a re-derived plugin', pluginChanged()],
  ])('selects at once when %s came before mEdit answered the create', async (_case, event) => {
    const { stream, selection, revealed, opened, opening } = harness();
    const open = opening();
    const watch = selection.watch(PLUGIN);
    stream.emit(event);

    watch.select(NPCS, NEW);
    await open;

    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits past a change before mEdit answered the create that does not name the record', async () => {
    const { stream, asked, selection, opened, opening } = harness();
    const open = opening();
    const watch = selection.watch(PLUGIN);
    stream.emit(rowsChanged([OTHER]));

    watch.select(NPCS, NEW);
    await aWindow();
    expect([asked, opened()]).toEqual([[], []]);

    stream.emit(rowsChanged([NEW]));
    await open;
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('finds the row beneath the container the record landed in', async () => {
    const { stream, asked, selection, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(QUEST, NEW);

    stream.emit(rowsChanged([NEW]));
    await open;

    expect(asked).toEqual([`quest row ${NEW}`]);
  });

  it.each([
    ['a plugin of the same name from another origin', rowsChanged([NEW], 'ModB')],
    ['a change that does not name the new record', rowsChanged([OTHER])],
  ])('waits past %s', async (_case, event) => {
    const { stream, selection, opened, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(event);
    await aWindow();
    expect(opened()).toEqual([]);

    stream.emit(rowsChanged([NEW]));
    await open;
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects the new record\'s row by its FormKey once mEdit re-derives its whole plugin, which names no record', async () => {
    const { stream, asked, selection, revealed, opened, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(QUEST, NEW);

    stream.emit(pluginChanged('ModB'));
    await aWindow();
    expect(opened()).toEqual([]);

    stream.emit(pluginChanged());
    await open;

    expect(asked).toEqual([`quest row ${NEW}`]);
    expect(revealed).toEqual([`row ${NEW} {"select":true,"focus":true}`]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('selects nothing at a later change naming the record, once a re-derived plugin settled the watch', async () => {
    const { stream, asked, selection, opened, opening } = harness(() => false);
    const open = opening();
    selection.watch(PLUGIN).select(NPCS, NEW);
    stream.emit(pluginChanged());
    await open;

    stream.emit(rowsChanged([NEW]));
    stream.emit(pluginChanged());
    await aWindow();

    expect(asked).toHaveLength(1);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens a new record no row shows, as when the record filter hides it, selecting nothing', async () => {
    const { stream, selection, revealed, opened, opening } = harness(() => false);
    const open = opening();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await open;

    expect(revealed).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('opens once, though the watch names the record again', async () => {
    const { stream, selection, opened, opening } = harness();
    const open = opening();
    selection.watch(PLUGIN).select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    stream.emit(rowsChanged([NEW]));
    await open;
    stream.emit(rowsChanged([NEW]));
    await aWindow();

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits only for the latest create', async () => {
    const { stream, selection, opened, opening } = harness();
    const open = opening();
    const first = selection.watch(PLUGIN);
    selection.watch(PLUGIN).select(NPCS, NEW);
    first.select(NPCS, OTHER);

    stream.emit(rowsChanged([OTHER, NEW]));
    await open;

    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('stops listening once forgotten', async () => {
    const { stream, asked, selection, opened } = harness();
    const watch = selection.watch(PLUGIN);
    watch.forget();
    watch.select(NPCS, NEW);

    stream.emit(rowsChanged([NEW]));
    await aWindow();

    expect(asked).toEqual([]);
    expect(opened()).toEqual([]);
  });
});
