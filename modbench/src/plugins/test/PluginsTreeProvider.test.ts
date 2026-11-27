import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import type * as vscode from 'vscode';
import { DataTransfer, EventEmitter, host, ThemeColor, ThemeIcon, TreeItemCheckboxState, TreeItemCollapsibleState, Uri } from './vscodeHost';
import { deferred, factsOver, indexedOver, pluginsOver, settle } from './pluginsOver';
import { browserClient } from './browserRows';
import type { PluginAddress, PluginLoadFailure, PluginMetadata } from '../../client';
import { listsForThePluginAsked, pluginMetadataFixture, recordSummaryFixture } from '../../client/test/fixtures';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { changeNamesPlugin } from '../../client/test/says';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import { FileConflictLookup } from '../../instanceLoader/fileConflictIndex';
import { ABSENT_SORTING_RULE_FILES, type OriginFile } from '../../instanceAdapter/instanceAdapter';
import type { LastModStatuses } from '../../pluginCommands/plugins';
import type { FileReads } from '../../sortingRules/lootConditions';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { READ_SORTING_RULE_FILES } from '../../test/readSortingRuleFiles';
import { fileIn } from '../../test/fakeInstanceAdapter';
import { status } from '../../test/modStatusFixture';
import { FakeCancellationToken } from '../../test/vscodeMock';
import { pluginArgumentOf } from '../../drivingLib/argument';
import { present } from '../../ports/present';

const SOME_MOD = 'SomeMod';
const FOUND = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
const NO_PLUGINS_MESSAGE = 'No plugins: plugins.txt lists none, and mEdit names none the game loads on its own. Create Plugin…, in the title bar, adds one.';
const GAME_FOLDER_MESSAGE = "Game folder not found: set modbench.mods.gameFolder. The Toolbox's Game row names each place Modbench looked.";
const LOCKED_TOOLTIP = "This plugin can't be disabled or moved (enforced by the game).";
const TOKEN = new FakeCancellationToken();

interface Line { name: string; origin?: string; line?: number | null; enabled?: boolean; winning?: boolean; path?: string }

const placed = (plugin: Omit<LoadOrderPlugin, 'path'>, path: string | undefined): LoadOrderPlugin | LoadOrderPluginLine =>
  (path === undefined ? { ...plugin, path } : { ...plugin, path });

const pathOf = ({ name, origin }: PluginAddress) => (origin === 'Data/' ? `/game/Data/${name}` : `/mods/${origin}/${name}`);

function valueOf(lines: readonly Line[], { noLine, ...value }: Partial<InstanceValue> & { noLine?: readonly (string | PluginAddress)[] } = {}): InstanceValue {
  const plugins = lines.map((line, at) => {
    const address = { name: line.name, origin: line.origin ?? SOME_MOD };
    return placed({ ...address, line: line.line === undefined ? at : line.line, enabled: line.enabled ?? true, winning: line.winning ?? true },
      'path' in line ? line.path : pathOf(address));
  });
  const mods = [...new Set(plugins.map(({ origin }) => origin))].filter((origin) => origin !== 'Data/' && origin !== 'overwrite/');
  return instanceValueFixture({
    mods: mods.map((name) => ({ kind: 'mod', name, enabled: true })), gameFolder: FOUND, plugins,
    pluginsLoadedWithNoLine: noLine?.map((plugin) => {
      const address = typeof plugin === 'string' ? { name: plugin, origin: 'Data/' } : plugin;
      return { ...address, path: pathOf(address) };
    }),
    ...value,
  });
}

const linesOf = (...names: string[]): Line[] => names.map((name) => ({ name }));
const held = (name: string, overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name, ...overrides });
const labelOf = (item: vscode.TreeItem) => (typeof item.label === 'object' ? item.label.label : item.label);
const nameOf = (row: unknown) => pluginArgumentOf(row)?.plugin.name;
const kindOf = (item: vscode.TreeItem) => item.contextValue?.split(' ')[0];

type SceneOver = NonNullable<Parameters<typeof factsOver>[1]>;

function scene(value: InstanceValue, over: SceneOver = {}) {
  const made = factsOver([], { client: browserClient(), ...over, value });
  const items = async (parent?: unknown) => Promise.all((await made.rows(parent)).map(made.item));
  const controller = () => present(made.view().options.dragAndDropController, 'the view\'s drag and drop');
  return {
    ...made, items,
    labels: async (parent?: unknown) => (await items(parent)).map(labelOf),
    names: async () => (await made.rows()).map(nameOf),
    rowNamed: async (name: string, origin = SOME_MOD) => present((await made.rows()).find((row) => {
      const plugin = pluginArgumentOf(row)?.plugin;
      return plugin?.name === name && plugin.origin === origin;
    }), `the row of ${name}`),
    settledMessage: async () => { await settle(); return made.message(); },
    filters: async (text: string) => {
      made.shown.nameFilter.open();
      present(host.inputBox(), 'the name filter').type(text);
      await settle();
    },
    drags: async (rows: readonly unknown[]) => {
      const dragged = new DataTransfer();
      await controller().handleDrag?.(rows, dragged, TOKEN);
      return dragged;
    },
    drops: async (dragged: DataTransfer, target?: unknown) => { await controller().handleDrop?.(target, dragged, TOKEN); },
    sorts: (direction: 'WinningAtTop' | 'LosingAtTop') => host.run(`modbench.plugin.sort${direction}`),
  };
}

type Scene = ReturnType<typeof scene>;

const moves = () => host.executed.filter(([id]) => id === 'modbench.plugin.move').map(([, , rows, drop]) => ({
  plugins: Array.isArray(rows) ? rows.map((row) => pluginArgumentOf(row)?.plugin) : [], drop,
}));
const movesOf = (...names: string[]) => (drop: unknown) => [{ plugins: names.map((name) => ({ name, origin: SOME_MOD })), drop }];

async function filtersRecords(made: Scene, source: string): Promise<void> {
  host.files.set(source, 'SELECT form_key FROM "armo"');
  made.client.setQueryAnswer('setFilter', null);
  made.client.setQueryAnswer('getActiveFilter', { sql: 'SELECT form_key FROM "armo"', source });
  await host.run('modbench.record.filter', Uri.file(`/workspace/${source}`));
  await settle();
}

describe('a plugin the game loads with no line: its row\'s leading line', () => {
  it('renders a lock icon, not a checkbox, as VS Code has no non-interactive checkbox variant', async () => {
    const [locked] = await scene(valueOf([], { noLine: ['Fallout4.esm'] })).items();

    expect([locked?.iconPath, locked?.checkboxState]).toEqual([new ThemeIcon('lock'), undefined]);
  });
});

describe('a plugin row\'s click opens the plugin header', () => {
  it.each([
    ['a plugin line', valueOf([{ name: 'A.esp', origin: 'ModA' }])],
    ['a plugin the game loads with none', valueOf([], { noLine: [{ name: 'A.esp', origin: 'ModA' }] })],
  ])('%s opens the header at the plugin and origin its row stands for', async (_what, value) => {
    const [item] = await scene(value).items();

    expect(item?.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey: '000000:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } } }],
    });
  });

  it('does nothing on a disabled plugin but select it', async () => {
    const [item] = await scene(valueOf([{ name: 'A.esp', enabled: false }])).items();

    expect(item?.command).toBeUndefined();
  });
});

describe('a plugin row carries its plugin as its Argument', () => {
  it.each([
    ['a plugin line', valueOf([{ name: 'A.esp', origin: 'ModA' }])],
    ['a plugin the game loads with none', valueOf([], { noLine: [{ name: 'A.esp', origin: 'ModA' }] })],
  ])('%s', async (_what, value) => {
    const [row] = await scene(value).rows();

    expect(pluginArgumentOf(row)).toEqual({ kind: 'plugin', plugin: { name: 'A.esp', origin: 'ModA' } });
  });
});

describe('the rows come from the Instance value', () => {
  it('renders a plain row — no icon, no description', async () => {
    const [item] = await scene(valueOf(linesOf('A.esp'))).items();

    expect([item?.iconPath, item?.description]).toEqual([new ThemeIcon('blank'), undefined]);
  });

  it('builds one row per plugins.txt line, in Plugin load order, with the enabled checkbox', async () => {
    const items = await scene(valueOf([{ name: 'A.esp', enabled: false }, { name: 'B.esp' }])).items();

    expect(items.map((item) => [labelOf(item), item.checkboxState])).toEqual([
      ['0 A.esp', TreeItemCheckboxState.Unchecked], ['1 B.esp', TreeItemCheckboxState.Checked],
    ]);
  });

  it('renders no row, and says so in the message line, with no lines and no locked plugins', async () => {
    const made = scene(valueOf([]));

    expect([await made.rows(), await made.settledMessage()]).toEqual([[], NO_PLUGINS_MESSAGE]);
  });

  it('says nothing about an empty list while the game loads a plugin on its own', async () => {
    const made = scene(valueOf([], { noLine: ['Fallout4.esm'] }));

    expect([await made.names(), await made.settledMessage()]).toEqual([['Fallout4.esm'], undefined]);
  });

  it('takes the message back once a line lands', async () => {
    const made = scene(valueOf([]));
    await made.rows();

    made.instance.publish(valueOf(linesOf('A.esp')));
    await made.rows();

    expect(await made.settledMessage()).toBeUndefined();
  });

  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    const redrawn = made.redraws();

    made.instance.fail('EACCES plugins.txt');
    const failed = await made.settledMessage();
    const redrawnOnFailure = redrawn.length;
    made.instance.publish(valueOf(linesOf('A.esp')));

    expect([failed, redrawnOnFailure, await made.settledMessage()]).toEqual(['Showing the last good read: EACCES plugins.txt', 1, undefined]);
  });

  it('says the message line again once a read lands after a failed one, though it finds nothing new', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    made.instance.fail('EACCES plugins.txt');
    const redrawn = made.redraws();

    made.instance.publish(made.instance.value);

    expect([await made.settledMessage(), redrawn]).toEqual([undefined, [undefined]]);
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const made = pluginsOver({ instance, value: instance.value });

    const pending = made.rows();
    instance.publish(valueOf(linesOf('A.esp', 'B.esp')));

    expect([(await pending).map(nameOf), (await made.rows()).map(nameOf)]).toEqual([['A.esp', 'B.esp'], ['A.esp', 'B.esp']]);
  });

  it('settles a failed first read on the one error row naming the reason, raises nothing, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const made = pluginsOver({ instance, value: instance.value });
    const reason = 'EISDIR: illegal operation on a directory, read plugins.txt';

    const pending = made.rows();
    instance.fail(reason);
    const errors = await Promise.all((await pending).map(made.item));
    instance.publish(valueOf(linesOf('A.esp')));

    expect(errors.map(({ label, tooltip, iconPath }) => ({ label, tooltip, iconPath }))).toEqual([
      { label: `Failed to load: ${reason}`, tooltip: reason, iconPath: new ThemeIcon('error') },
    ]);
    expect((await made.rows()).map(nameOf)).toEqual(['A.esp']);
  });

  it('says nothing about an empty list before the first read lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const made = pluginsOver({ instance, value: instance.value });

    const pending = made.rows();
    await settle();
    const before = made.view().message;
    instance.publish(valueOf([]));
    await pending;
    await settle();

    expect([before, made.view().message]).toEqual([undefined, NO_PLUGINS_MESSAGE]);
  });
});

describe('a plugin row is identified by its kind and (origin, filename)', () => {
  const idsOf = async (made: Scene) => (await made.items()).map(({ id }) => id);

  it('keeps each row\'s identity across a rebuild that moves it', async () => {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp')));
    const [a, b] = await idsOf(made);

    made.instance.publish(valueOf(linesOf('B.esp', 'A.esp')));

    expect([await idsOf(made), a === b]).toEqual([[b, a], false]);
  });

  it('gives the plugin of the same name from another origin another identity', async () => {
    const made = scene(valueOf([{ name: 'A.esp', origin: 'ModA' }]));
    const [fromModA] = await idsOf(made);

    made.instance.publish(valueOf([{ name: 'A.esp', origin: 'ModB' }]));

    const [fromModB] = await idsOf(made);
    expect([fromModB === undefined, fromModB === fromModA]).toEqual([false, false]);
  });

  it('gives a locked row an identity of its own kind, never a plugin row\'s', async () => {
    const [lineId] = await idsOf(scene(valueOf([{ name: 'Fallout4.esm', origin: 'Data/' }])));
    const [lockedId] = await idsOf(scene(valueOf([], { noLine: ['Fallout4.esm'] })));

    expect([lockedId === undefined, lockedId === lineId]).toEqual([false, false]);
  });
});

describe('the name filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const made = scene(valueOf(linesOf('Alpha.esp', 'Beta.esp', 'AlphaExtra.esp')));

    await made.filters('ALPHA');

    expect(await made.names()).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('finds no row for a plugin the name filter hides', async () => {
    const made = scene(valueOf(linesOf('Alpha.esp', 'Beta.esp')));
    const [alpha] = await made.rows();
    made.view().selectRows([alpha]);

    await made.filters('beta');
    Object.assign(made.view(), { selection: [] });

    expect(made.shown.followed.selection).toEqual([]);
  });

  it('returns an empty list, and no empty-list message, when the filter matches nothing', async () => {
    const made = scene(valueOf(linesOf('Alpha.esp', 'Beta.esp')));

    await made.filters('nomatch');

    expect([await made.rows(), await made.settledMessage()]).toEqual([[], 'No matches for "nomatch".']);
  });

  it('survives an instance value change, narrowing whatever it turns up', async () => {
    const made = scene(valueOf(linesOf('Alpha.esp', 'Beta.esp')));
    await made.filters('alpha');
    const before = await made.names();

    made.instance.publish(valueOf(linesOf('Alpha.esp', 'Beta.esp', 'AlphaTwo.esp')));

    expect([before, await made.names()]).toEqual([['Alpha.esp'], ['Alpha.esp', 'AlphaTwo.esp']]);
  });

  it('narrowing a rendered tree asks it to render again, and its rows come back narrowed', async () => {
    const made = scene(valueOf(linesOf('Alpha.esp', 'Beta.esp')));
    await made.rows();
    const redrawn = made.redraws();

    await made.filters('alpha');

    expect([redrawn.includes(undefined), await made.names()]).toEqual([true, ['Alpha.esp']]);
  });
});

describe('drag-and-drop reorder (plugins.md, Drag and drop)', () => {
  const ORDER = linesOf('A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp');
  const dragging = (lines: readonly Line[] = ORDER) => scene(valueOf(lines));

  it('a drop of rows the view does not hold moves nothing, and does not fall back to the selection', async () => {
    const made = dragging();
    const dragged = await made.drags([await made.rowNamed('A.esp')]);
    made.view().selectRows([await made.rowNamed('B.esp')]);

    made.instance.publish(valueOf(linesOf('B.esp', 'C.esp', 'D.esp', 'E.esp')));
    await made.drops(dragged, await made.rowNamed('D.esp'));

    expect(moves()).toEqual([]);
  });

  it('a drop fires nothing before the read lands', async () => {
    const made = dragging();
    const dragged = await made.drags([await made.rowNamed('A.esp')]);
    const redrawn = made.redraws();

    await made.drops(dragged, await made.rowNamed('D.esp'));

    expect([redrawn, moves()]).toEqual([[], movesOf('A.esp')({ kind: 'before', name: 'D.esp' })]);
  });

  it.each([
    ['a record row', async (made: Scene, group: unknown) => (await made.rows(group))[0]],
    ['a record-type group row', (_made: Scene, group: unknown) => Promise.resolve(group)],
  ])('drop onto %s of this tree is refused, not treated as the end of the list', async (_name, beneath) => {
    const client = browserClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }], records: { items: [recordSummaryFixture()], total: 1 } });
    const made = scene(valueOf(ORDER), { client });
    await made.reconciled(ORDER.map(({ name }) => held(name)));
    const [group] = await made.rows(await made.rowNamed('A.esp'));
    const dragged = await made.drags([await made.rowNamed('A.esp')]);

    await made.drops(dragged, await beneath(made, present(group, 'the Weapon group')));

    expect(moves()).toEqual([]);
    expect(made.reporter('pluginListTree.drop').reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.', detail: 'A plugin goes above a plugin row or at the bottom of the view, not on a record or a group.',
    }]);
  });

  it.each([['C.esp', SOME_MOD], ['c.ESP', 'ModB']])('a drop on a row being dragged asks for nothing, the dragged name being %s', async (name, origin) => {
    const made = dragging([...ORDER, { name: 'c.ESP', origin: 'ModB' }]);
    const dragged = await made.drags([await made.rowNamed('A.esp'), await made.rowNamed(name, origin)]);

    await made.drops(dragged, await made.rowNamed('C.esp'));

    expect(moves()).toEqual([]);
    expect(made.reporter('pluginListTree.drop').reports).toEqual([{ severity: 'error', message: 'Could not move plugins.', detail: 'C.esp is being dragged, so nothing goes above it.' }]);
  });

  it('an empty drag payload is a no-op (no write)', async () => {
    const made = dragging();

    await made.drops(new DataTransfer(), await made.rowNamed('A.esp'));

    expect(moves()).toEqual([]);
  });

  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const made = dragging(linesOf('M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'));
    await made.filters('m');
    const shown = await made.names();
    const dragged = await made.drags([await made.rowNamed('M1.esp')]);

    await made.drops(dragged, await made.rowNamed('M3.esp'));

    expect([shown, moves()]).toEqual([['M1.esp', 'M2.esp', 'M3.esp'], movesOf('M1.esp')({ kind: 'before', name: 'M3.esp' })]);
  });

  it('drags only plugin lines, never a locked row', async () => {
    const made = scene(valueOf(linesOf('Mod.esp'), { noLine: ['Fallout4.esm'] }));

    await made.drops(await made.drags(await made.rows()));

    expect(moves()).toEqual(movesOf('Mod.esp')({ kind: 'winningEnd' }));
  });
});

describe('a drop asks for the place it is shown, in either sort direction', () => {
  const rowOf = (name: string, origin?: string) => (made: Scene) => made.rowNamed(name, origin);
  const LOCKED = rowOf('Fallout4.esm', 'Data/');
  const BELOW_THE_LAST_ROW = () => Promise.resolve(undefined);

  it.each([
    { direction: 'LosingAtTop', moved: ['E.esp'], where: 'B.esp', target: rowOf('B.esp'), drop: { kind: 'before', name: 'B.esp' } },
    { direction: 'LosingAtTop', moved: ['B.esp', 'C.esp', 'D.esp'], where: 'A.esp', target: rowOf('A.esp'), drop: { kind: 'before', name: 'A.esp' } },
    { direction: 'LosingAtTop', moved: ['A.esp', 'C.esp', 'E.esp'], where: 'D.esp', target: rowOf('D.esp'), drop: { kind: 'before', name: 'D.esp' } },
    { direction: 'LosingAtTop', moved: ['A.esp'], where: 'below the last row', target: BELOW_THE_LAST_ROW, drop: { kind: 'winningEnd' } },
    { direction: 'LosingAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED, drop: { kind: 'losingEnd' } },
    { direction: 'WinningAtTop', moved: ['A.esp'], where: 'D.esp', target: rowOf('D.esp'), drop: { kind: 'after', name: 'D.esp' } },
    { direction: 'WinningAtTop', moved: ['A.esp', 'B.esp'], where: 'D.esp', target: rowOf('D.esp'), drop: { kind: 'after', name: 'D.esp' } },
    { direction: 'WinningAtTop', moved: ['E.esp'], where: 'below the last row', target: BELOW_THE_LAST_ROW, drop: { kind: 'losingEnd' } },
    { direction: 'WinningAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED, drop: { kind: 'losingEnd' } },
  ] as const)('$direction: $moved dropped on $where asks for $drop', async ({ direction, moved, target, drop }) => {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'), { noLine: ['Fallout4.esm'] }));
    await made.sorts(direction);
    const dragged = await made.drags(await Promise.all(moved.map((name) => made.rowNamed(name))));

    await made.drops(dragged, await target(made));

    expect(moves()).toEqual(movesOf(...moved)(drop));
  });

  it('moves the dragged plugin alone when another origin holds a plugin of its file name', async () => {
    const made = scene(valueOf([{ name: 'A.esp' }, { name: 'Same.esp', origin: 'ModA' }, { name: 'Same.esp', origin: 'ModB' }]));
    const dragged = await made.drags([await made.rowNamed('Same.esp', 'ModB')]);

    await made.drops(dragged, await made.rowNamed('A.esp'));

    expect(moves().flatMap(({ plugins }) => plugins)).toEqual([{ name: 'Same.esp', origin: 'ModB' }]);
  });
});

describe('the places a move offers are the drops on its rows', () => {
  const moved = (plugins: readonly string[], toIndex: number) => [{ verb: 'changePluginOrderOverProvided', profile: 'Default', changes: [{ kind: 'move', plugins, toIndex }] }];

  async function moving() {
    const made = await indexedOver(['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'], {
      commandsClient: { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) },
      value: { pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] },
    });
    const selection = [made.row('B.esp'), made.row('D.esp')];
    return { ...made, move: async (picked?: string) => { host.picks(() => picked); await host.run('modbench.plugin.move', selection[0], selection); } };
  }

  it('losing at the top: above each row outside the selection, as shown, then the bottom of the view at the winning end', async () => {
    const { fake, move } = await moving();

    await move('Bottom of the view');

    expect(host.quickPicks.map(({ items }) => items)).toEqual([['A.esp', 'C.esp', 'E.esp', 'Bottom of the view']]);
    expect(fake.calls).toEqual(moved(['B.esp', 'D.esp'], 3));
  });

  it('winning at the top: above each row outside the selection, as shown, then the bottom of the view at the losing end', async () => {
    const { fake, move } = await moving();
    await host.run('modbench.plugin.sortWinningAtTop');

    await move('Bottom of the view');

    expect(host.quickPicks.map(({ items }) => items)).toEqual([['E.esp', 'C.esp', 'A.esp', 'Bottom of the view']]);
    expect(fake.calls).toEqual(moved(['B.esp', 'D.esp'], 0));
  });

  it('offers a row the name filter hides', async () => {
    const { move, shown } = await moving();
    shown.nameFilter.open();
    present(host.inputBox(), 'the name filter').type('b');

    await move();

    expect(host.quickPicks.map(({ items }) => items)).toEqual([['A.esp', 'C.esp', 'E.esp', 'Bottom of the view']]);
  });
});

describe('the places a load after offers are the active plugins outside the selection', () => {
  it('offers each enabled line outside the selection, in the order the view shows them', async () => {
    const names = ['A.esp', 'B.esp', 'C.esp', 'D.esp'];
    const made = await indexedOver(names, {
      reading: { pluginOrder: names.map((name) => ({ name, enabled: name !== 'C.esp' })) },
      value: {
        plugins: names.map((name, line) => ({ name, origin: 'ModA', path: `/mods/ModA/${name}`, line, enabled: name !== 'C.esp', winning: true })),
        pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
      },
    });
    const loadAfterB = () => host.run('modbench.plugin.loadAfter', made.row('B.esp'), [made.row('B.esp')]);

    await loadAfterB();
    await host.run('modbench.plugin.sortWinningAtTop');
    await loadAfterB();

    expect(host.quickPicks.map(({ items }) => items)).toEqual([['Fallout4.esm', 'A.esp', 'D.esp'], ['D.esp', 'A.esp', 'Fallout4.esm']]);
  });
});

describe('the rows of the plugins the game loads with no line', () => {
  it('draws the plugins the game loads with no line before the plugins.txt lines, in the order given, not sorted (DLCCoast.esm would sort ahead of Fallout4.esm), with no checkbox and contextValue pluginImplicit', async () => {
    const items = await scene(valueOf(linesOf('Mod.esp'), { noLine: ['Fallout4.esm', 'DLCCoast.esm'] })).items();

    expect(items.map((item) => [labelOf(item), kindOf(item), item.checkboxState])).toEqual([
      ['Fallout4.esm', 'pluginImplicit', undefined], ['DLCCoast.esm', 'pluginImplicit', undefined], ['0 Mod.esp', 'plugin', TreeItemCheckboxState.Checked],
    ]);
  });

  it('renders a plugins.txt line of the same filename from another origin as its own row (ADR-0012)', async () => {
    const items = await scene(valueOf([{ name: 'Fallout4.esm' }], { noLine: ['Fallout4.esm'] })).items();

    expect(items.map(kindOf)).toEqual(['pluginImplicit', 'plugin']);
  });

  it('gives two game folder files that differ only in case a row each, each with an id of its own', async () => {
    const items = await scene(valueOf([], { noLine: ['Master.esm', 'master.esm'] })).items();

    expect([items.map(labelOf), new Set(items.map(({ id }) => id)).size]).toEqual([['Master.esm', 'master.esm'], 2]);
  });

  it('renders no implicit row, and every plugins.txt line, when the value cannot say', async () => {
    expect(await scene(valueOf(linesOf('Mod.esp'))).labels()).toEqual(['0 Mod.esp']);
  });

  it('shows a line naming a locked plugin as an ordinary row while the value cannot say, then locks it at the losing end', async () => {
    const lines = [{ name: 'Fallout4.esm', origin: 'Data/' }, { name: 'Mod.esp' }];
    const made = scene(valueOf(lines));
    const shape = async () => (await made.rows()).map(async (row) => `${kindOf(await made.item(row))} ${nameOf(row)}`);
    const before = await Promise.all(await shape());

    made.instance.publish(valueOf(lines, { noLine: ['Fallout4.esm', 'DLCRobot.esm'] }));

    expect([before, await Promise.all(await shape())]).toEqual([
      ['plugin Fallout4.esm', 'plugin Mod.esp'], ['pluginImplicit Fallout4.esm', 'pluginImplicit DLCRobot.esm', 'plugin Mod.esp'],
    ]);
  });

  it('never adds a read-only line to the locked row — its tooltip is the one sentence alone', async () => {
    const made = scene(valueOf([], { noLine: ['Fallout4.esm'] }));
    await made.reconciled([held('Fallout4.esm', { origin: 'Data/', isImmutable: true })]);

    const [item] = await made.items();

    expect(item?.tooltip).toBe(LOCKED_TOOLTIP);
  });
});

describe('a plugin row reveals its own file (plugins.md, Reveal in Explorer)', () => {
  it('resolves a locked row the game loads from a mod to that mod\'s copy, not the game folder\'s', async () => {
    const made = scene(valueOf([{ name: 'Fallout4.esm', origin: 'SomeMod', line: null }], { noLine: [{ name: 'Fallout4.esm', origin: SOME_MOD }] }));

    await host.run('modbench.plugin.reveal', await made.rowNamed('Fallout4.esm'));

    expect(host.executed).toEqual([['revealFileInOS', Uri.file('/mods/SomeMod/Fallout4.esm')]]);
  });
});

describe('the selection\'s keys read each plugin\'s line as it is now', () => {
  it('reads the selected row\'s own line as the instance holds it now, never the line of its file name at another origin', async () => {
    const lines = (enabled: boolean) => valueOf([{ name: 'Mod.esp', origin: 'ModA' }, { name: 'Mod.esp', origin: 'ModB', enabled }]);
    const made = scene(lines(false));
    made.view().selectRows([await made.rowNamed('Mod.esp', 'ModB')]);
    const toggle = () => host.context('modbench.plugin.selectionToggle').at(-1);
    const before = toggle();

    made.instance.publish(lines(true));
    await made.rows();

    expect([before, toggle()]).toEqual(['enable', 'disable']);
  });
});

describe('the sort direction', () => {
  const LINES = valueOf(linesOf('A.esp', 'B.esp', 'C.esp'), { noLine: ['Fallout4.esm', 'DLCRobot.esm'] });
  const LOSING_AT_TOP = ['Fallout4.esm', 'DLCRobot.esm', 'A.esp', 'B.esp', 'C.esp'];

  it('lists losing at the top until told otherwise', async () => {
    expect(await scene(LINES).names()).toEqual(LOSING_AT_TOP);
  });

  it('lists winning at the top with the locked plugins at the bottom, and back again', async () => {
    const made = scene(LINES);

    await made.sorts('WinningAtTop');
    const winningAtTop = await made.names();
    await made.sorts('LosingAtTop');

    expect([winningAtTop, await made.names()]).toEqual([['C.esp', 'B.esp', 'A.esp', 'DLCRobot.esm', 'Fallout4.esm'], LOSING_AT_TOP]);
  });

  it('flips the very rows it had, rebuilding none', async () => {
    const made = scene(LINES);
    const before = await made.rows();
    const redrawn = made.redraws();

    await made.sorts('WinningAtTop');

    expect([redrawn, [...await made.rows()].reverse()]).toEqual([[undefined], before]);
    expect((await made.rows()).every((row) => before.includes(row))).toBe(true);
  });

  it('keeps the order of the groups and records beneath a plugin', async () => {
    const client = browserClient({
      recordTypes: [{ type: 'acti', count: 2, displayName: 'Activator' }, { type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummaryFixture({ formKey: '000001:A.esp', editorId: 'First' }), recordSummaryFixture({ formKey: '000002:A.esp', editorId: 'Second' })], total: 2 },
    });
    const made = scene(valueOf(linesOf('A.esp')), { client });
    await made.reconciled([held('A.esp')]);
    const beneath = async () => {
      const groups = await made.rows(await made.rowNamed('A.esp'));
      return [...await made.labels(await made.rowNamed('A.esp')), ...await made.labels(groups[0])];
    };
    const losingAtTop = await beneath();

    await made.sorts('WinningAtTop');

    expect([losingAtTop, await beneath()]).toEqual([['Activator', 'Weapon', 'First', 'Second'], ['Activator', 'Weapon', 'First', 'Second']]);
  });

  it('narrows the flipped rows by the name filter', async () => {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp', 'C.esp', 'AB.esp')));

    await made.sorts('WinningAtTop');
    await made.filters('a');

    expect(await made.names()).toEqual(['AB.esp', 'A.esp']);
  });
});

describe('the order Editing hands mEdit is the order the view shows', () => {
  const at = (name: string) => ({ name, origin: 'Data/' });
  const snapshot = (gameRelease: string) => ({
    gameRelease, active: ['Base.esm', 'Blueprint.esm', 'A.esp'].map(at), loadedWithNoLine: ['Base.esm', 'Blueprint.esm'].map(at),
  });
  const FACTS = [held('Base.esm', { origin: 'Data/' }), held('Blueprint.esm', { origin: 'Data/', isMaster: true, isBlueprint: true }), held('A.esp', { origin: 'Data/' })];
  const over = () => scene(valueOf(linesOf('A.esp'), { noLine: ['Base.esm', 'Blueprint.esm'] }));

  it.each([
    ['puts a blueprint plugin Editing read last, in a release that loads them last', 'Starfield', FACTS, ['Base.esm', 'A.esp', 'Blueprint.esm']],
    ['keeps the plugins.txt order in a release that does not', 'Fallout4', FACTS, ['Base.esm', 'Blueprint.esm', 'A.esp']],
    ['keeps the plugins.txt order for a plugin Editing has not read', 'Starfield', [], ['Base.esm', 'Blueprint.esm', 'A.esp']],
  ])('%s', async (_name, gameRelease, read, expected) => {
    const made = over();
    await made.reconciled(read);

    expect(made.shown.editingInPluginsView.viewOrder.of(snapshot(gameRelease)).map(({ name }) => name)).toEqual(expected);
  });

  it('tells its listener when Editing has read the plugins', async () => {
    const made = over();
    let told = 0;
    made.shown.editingInPluginsView.viewOrder.onChange(() => { told++; });

    await made.reconciled(FACTS);

    expect(told).toBeGreaterThan(0);
  });
});

describe('a plugin the game loads with no line sits where the game loads it (plugins.md, The tree, story 2)', () => {
  const BLUEPRINT = 'Blueprint.esm';
  const over = (blueprintLoadsLast = true) => scene(valueOf(linesOf('A.esp', 'B.esp', 'Ship.esm'), { noLine: ['Base.esm', BLUEPRINT], blueprintLoadsLast }));
  const FACTS = [
    held('Base.esm', { origin: 'Data/' }), held(BLUEPRINT, { origin: 'Data/', isMaster: true, isBlueprint: true }), held('A.esp'), held('B.esp'),
    held('Ship.esm', { isMaster: true, isBlueprint: true, masters: [BLUEPRINT] }),
  ];

  it('draws it after every line that is not a blueprint plugin, and before a blueprint line, once mEdit has read the plugins', async () => {
    const made = over();
    await made.reconciled(FACTS);

    expect(await made.names()).toEqual(['Base.esm', 'A.esp', 'B.esp', BLUEPRINT, 'Ship.esm']);
  });

  it('draws it at the losing end in a release that does not load blueprint plugins last', async () => {
    const made = over(false);
    await made.reconciled(FACTS);

    expect(await made.names()).toEqual(['Base.esm', BLUEPRINT, 'A.esp', 'B.esp', 'Ship.esm']);
  });

  it('draws it at the losing end until mEdit says it is a blueprint plugin', async () => {
    expect(await over().names()).toEqual(['Base.esm', BLUEPRINT, 'A.esp', 'B.esp', 'Ship.esm']);
  });

  it('still takes a drop on it at the losing end of plugins.txt, wherever it is drawn', async () => {
    const made = over();
    await made.reconciled(FACTS);
    const dragged = await made.drags([await made.rowNamed('A.esp')]);

    await made.drops(dragged, await made.rowNamed(BLUEPRINT, 'Data/'));

    expect(moves()).toEqual(movesOf('A.esp')({ kind: 'losingEnd' }));
  });
});

describe('a plugin row\'s expander follows its line, not what mEdit holds', () => {
  it('gives an enabled row a chevron whether or not mEdit holds its plugin, and a disabled row none', async () => {
    const made = scene(valueOf([{ name: 'A.esp' }, { name: 'B.esp' }, { name: 'Off.esp', enabled: false }]));
    await made.reconciled([held('A.esp'), held('Off.esp')]);
    const chevrons = async () => (await made.items()).map(({ collapsibleState }) => collapsibleState);
    const whileHeld = await chevrons();

    await made.changed({ failed: 'refused', refusal: 'No load order has been received.' });

    const { Collapsed, None } = TreeItemCollapsibleState;
    expect([whileHeld, await chevrons()]).toEqual([[Collapsed, Collapsed, None], [Collapsed, Collapsed, None]]);
  });

  it.each([
    ['has no expander once the Data folder is listed without it', { kind: 'listed', names: new Set<string>() } as const, TreeItemCollapsibleState.None],
    ['keeps its chevron while the Data folder cannot be listed, so the records mEdit holds still show', { kind: 'unreadable', reason: 'EACCES' } as const, TreeItemCollapsibleState.Collapsed],
  ])('an enabled line no file answers to %s', async (_case, dataFolderPlugins, collapsibleState) => {
    const [item] = await scene(valueOf([{ name: 'Gone.esp', origin: 'Data/', path: undefined }], { dataFolderPlugins })).items();

    expect(item?.collapsibleState).toBe(collapsibleState);
  });

  it('never abandons the row: it stays collapsible, but expands to the error node — it will never be indexed', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.reconciled([], { failures: [{ name: 'A.esp', origin: SOME_MOD, reason: 'Malformed record' }] });

    const [item] = await made.items();

    expect([item?.collapsibleState, await made.expansion('A.esp')]).toEqual([TreeItemCollapsibleState.Collapsed, { kind: 'error', message: 'Malformed record' }]);
  });

  it('never asks the record browser before any reconcile has landed, answering "still indexing" instead', async () => {
    const made = scene(valueOf(linesOf('A.esp')));

    expect([await made.expansion('A.esp'), made.client.calls.filter(({ method }) => method === 'getRecordTypes')]).toEqual([{ kind: 'indexing' }, []]);
  });
});

describe('a line a mod\'s manifest names, not restored (plugins.md, A row, Plugin statuses)', () => {
  type ModStatus = NonNullable<ReturnType<LastModStatuses['of']>>;
  const gone = (mod: string, ...paths: string[]): ModStatus => status(mod, { gone: paths });
  const statusesAnswering = (...answered: ModStatus[]) => {
    const changed = new EventEmitter<void>();
    const byMod = new Map(answered.map((each) => [each.mod, each]));
    return { of: (mod: string) => byMod.get(mod), onDidChange: changed.event, answer: (each: ModStatus) => { byMod.set(each.mod, each); changed.fire(); } };
  };
  const UNRESTORED: Line[] = [{ name: 'Unrestored.esp', origin: 'Data/', path: undefined }];
  const cloneValue = ({ holdsRepository = true, enabled = true, lines = UNRESTORED } = {}) => valueOf(lines, {
    mods: [{ kind: 'mod', name: 'Provider', enabled: true }, { kind: 'mod', name: 'Unrestored', enabled }],
    dataFolderPlugins: { kind: 'listed', names: new Set<string>() }, holdsRepository,
  });
  const shownWith = async (value: InstanceValue, modStatuses: LastModStatuses) => {
    const [item] = await scene(value, { modStatuses }).items();
    return { description: item?.description, icon: item?.iconPath, tooltip: item?.tooltip };
  };

  it('says not restored, in yellow, on a line no file answers to that a mod\'s manifest names', async () => {
    expect(await shownWith(cloneValue(), statusesAnswering(gone('Unrestored', 'Unrestored.esp')))).toEqual({
      description: 'not restored',
      icon: new ThemeIcon('warning', new ThemeColor('problemsWarningIcon.foreground')),
      tooltip: 'Unrestored.esp\nUnrestored\nNot restored: its mod\'s manifest names it, and the mod\'s folder lacks it.',
    });
  });

  it('gives as its origin the mod that wins it in mod order, when two enabled mods\' manifests name it', async () => {
    const { tooltip } = await shownWith(cloneValue(), statusesAnswering(gone('Unrestored', 'Unrestored.esp'), gone('Provider', 'Unrestored.esp')));

    expect(tooltip).toContain('Unrestored.esp\nProvider\n');
  });

  it('says it once mEdit\'s answer lands after the row is shown', async () => {
    const statuses = statusesAnswering();
    const made = scene(cloneValue(), { modStatuses: statuses });
    await made.rows();

    statuses.answer(gone('Unrestored', 'Unrestored.esp'));

    expect((await made.items())[0]?.description).toBe('not restored');
  });

  it.each([
    ['the instance holds no repository', cloneValue({ holdsRepository: false }), 'Unrestored.esp'],
    ['a file answers to the line', cloneValue({ lines: [{ name: 'Unrestored.esp', origin: 'Provider' }] }), 'Unrestored.esp'],
    ['the manifest names it only below its folder\'s root', cloneValue(), 'optional/Unrestored.esp'],
    ['only a disabled mod\'s manifest names it', cloneValue({ enabled: false }), 'Unrestored.esp'],
  ])('says nothing of it when %s', async (_, value, named) => {
    expect((await shownWith(value, statusesAnswering(gone('Unrestored', named)))).description).toBeUndefined();
  });
});

describe('the conditions a record row reads are its plugin row\'s', () => {
  const weapon = (record = recordSummaryFixture()) => browserClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }], records: { items: [record], total: 1 } });
  const beneath = async (made: Scene, row: unknown) => {
    const [group] = await made.rows(row);
    const [record] = await made.items(present(group, 'the Weapon group'));
    return { group: await made.item(present(group, 'the Weapon group')), record: present(record, 'the record row') };
  };

  it('redraws every row while a record filter is in force, which decides which plugins have a row', async () => {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp')), { client: weapon() });
    await made.reconciled([held('A.esp'), held('B.esp')]);
    await filtersRecords(made, 'a.sql');
    const redrawn = made.redraws();

    changeNamesPlugin(made.client, { name: 'A.esp', origin: SOME_MOD });

    expect(new Set(redrawn)).toEqual(new Set([undefined]));
  });

  it('gives a record-type group an id of its own, so VS Code keeps it open across a redraw', async () => {
    const made = scene(valueOf(linesOf('A.esp')), { client: weapon() });
    await made.reconciled([held('A.esp')]);

    const { group } = await beneath(made, await made.rowNamed('A.esp'));
    const again = (await beneath(made, await made.rowNamed('A.esp'))).group;

    expect([group.id, again.id]).toEqual(Array(2).fill(present(group.resourceUri, 'the group\'s URI').toString()));
  });

  it('flips a record row on the reconcile after its mod is decompiled and committed', async () => {
    const made = scene(valueOf(linesOf('A.esp')), { client: weapon() });
    await made.reconciled([held('A.esp')]);
    const before = (await beneath(made, await made.rowNamed('A.esp'))).record.contextValue;

    await made.reconciled([held('A.esp', { isCompiledPlugin: true })]);

    expect([before, (await beneath(made, await made.rowNamed('A.esp'))).record.contextValue]).toEqual(['record', 'record editable']);
  });

  const DATA_COPY = held('Fallout4.esm', { origin: 'Data/', isImmutable: true });
  const MOD_COPY = held('Fallout4.esm', { origin: 'ModA', isCompiledPlugin: true });
  const locked = (modCopyWins: boolean) => scene(
    valueOf([{ name: 'Fallout4.esm', line: null, origin: 'ModA', winning: modCopyWins }, { name: 'A.esp', line: 0 }],
      { noLine: [{ name: 'Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data/' }] }),
    { client: weapon(recordSummaryFixture({ plugin: 'Fallout4.esm', formKey: '000001:Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data/' })) },
  );

  it.each([['last', [DATA_COPY, MOD_COPY]], ['first', [MOD_COPY, DATA_COPY]]])(
    'states a locked row the game folder provides by the game folder\'s copy, with the mod\'s copy listed %s',
    async (_order, answer) => {
      const made = locked(false);
      await made.reconciled([...answer, held('A.esp')]);

      const { group, record } = await beneath(made, await made.rowNamed('Fallout4.esm', 'Data/'));

      expect([group.contextValue, record.contextValue]).toEqual(['recordType creatable', 'record']);
    });

  it('expands a locked row mEdit names no plugin for at its origin as still indexing', async () => {
    const made = locked(false);
    await made.reconciled([MOD_COPY, held('A.esp')]);

    expect(await made.expansion('Fallout4.esm', 'Data/')).toEqual({ kind: 'indexing' });
  });

  it.each([['last', [MOD_COPY, DATA_COPY]], ['first', [DATA_COPY, MOD_COPY]]])(
    'states a locked row the game loads from a mod by that mod\'s copy, with the game folder\'s listed %s',
    async (_order, answer) => {
      const made = locked(true);
      await made.reconciled([...answer, held('A.esp')]);

      const { group, record } = await beneath(made, await made.rowNamed('Fallout4.esm', 'ModA'));

      expect([group.contextValue, record.contextValue]).toEqual(['recordType editable creatable', 'record editable']);
    });
});

describe('the message line takes the first message that holds (common.md, States 5; plugins.md, States 1, 5 and 6)', () => {
  const INDEX_FAILED = { kind: 'failed', message: 'the record index threw' } as const;

  it('puts the game folder over a failed index', async () => {
    const made = scene(valueOf(linesOf('A.esp'), { gameFolder: GAME_FOLDER_NOT_FOUND }));
    await made.rows();

    await made.refused(INDEX_FAILED);

    expect(await made.settledMessage()).toBe(GAME_FOLDER_MESSAGE);
  });

  it('puts a failed index over no rows', async () => {
    const made = scene(valueOf([]));
    await made.rows();

    await made.refused(INDEX_FAILED);

    expect(await made.settledMessage()).toBe('Indexing failed: the record index threw');
  });

  it('takes the failed index off the message line on the next tick that indexes', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    await made.refused(INDEX_FAILED);
    const failed = await made.settledMessage();

    await made.indexed({ indexed: [{ name: 'A.esp', origin: SOME_MOD }] });

    expect([failed, await made.settledMessage()]).toEqual(['Indexing failed: the record index threw', undefined]);
  });

  const withoutMasterlist = async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    made.instance.publish(valueOf(linesOf('A.esp'), { sortingRuleFiles: ABSENT_SORTING_RULE_FILES }));
    return made;
  };

  it('says there is no masterlist, naming update masterlist, once the instance has read', async () => {
    const made = await withoutMasterlist();

    expect(await made.settledMessage()).toMatch(/No masterlist.*update masterlist/);
  });

  describe('the lines it gives the agent', () => {
    it('hold the missing masterlist apart from the plugins\' own, the view\'s line saying it', async () => {
      const made = await withoutMasterlist();

      expect([await made.settledMessage(), made.plugins.standing.plugins(), made.plugins.standing.sortingRules()]).toEqual([
        expect.stringMatching(/No masterlist/), [], [expect.stringMatching(/^No masterlist/)],
      ]);
    });

    it('leave out the empty list, which a read of the plugins shows', async () => {
      const made = scene(valueOf([]));
      await made.rows();

      expect([await made.settledMessage(), made.plugins.standing.plugins()]).toEqual([NO_PLUGINS_MESSAGE, []]);
    });

    it('leave out the instance\'s last good read, which the instance says to the agent', async () => {
      const made = scene(valueOf(linesOf('A.esp')));
      await made.rows();

      made.instance.fail('the modlist is unreadable');

      expect([await made.settledMessage(), made.plugins.standing.plugins()]).toEqual(['Showing the last good read: the modlist is unreadable', []]);
    });
  });

  it('puts no rows over a record filter that matched nothing', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.reconciled([held('A.esp', { hasMatchingRecords: false })]);
    await filtersRecords(made, 'a.sql');
    const filtered = await made.settledMessage();

    made.instance.publish(valueOf([]));
    await made.rows();

    expect([filtered, await made.settledMessage()]).toEqual(['No records match a.sql.', NO_PLUGINS_MESSAGE]);
  });
});

describe('the sorting rules are judged again as the instance changes (plugins.md, Sorting rules)', () => {
  const userlist = (text: string) => ({ ...READ_SORTING_RULE_FILES, userlist: { path: '/instance/userlist.yaml', kind: 'text', text } }) as const;
  const NEEDS_MESH = userlist('plugins:\n  - name: A.esp\n    req: [Meshes/x.nif]\n');
  const MISSING_MESH = '"A.esp" requires "Meshes/x.nif", which is missing.';
  const messagesOf = (collection: string) => host.problems(collection).flatMap(([, problems]) => problems.map(({ message }) => message));
  const errors = () => messagesOf('modbench-sorting-errors');
  const warnings = () => messagesOf('modbench-sorting-warnings');
  const meshes = (...paths: string[]) => {
    const files = new FileConflictLookup();
    for (const mesh of paths) files.set({ relativePath: mesh, winner: `/mods/SomeMod/${mesh}`, winnerOrigin: { kind: 'mod', name: SOME_MOD }, providers: [{ kind: 'mod', name: SOME_MOD }] });
    return files;
  };
  const listed = (...paths: string[]) => ({ kind: 'listed', files: new Map(paths.map((each) => [each.toLowerCase(), fileIn('/game/Data', each)])) }) as const;

  function checksums(stalls = 'nothing') {
    let rewritten = false;
    let judgedAgain = 0;
    const stalled = deferred();
    const reachedStall = deferred();
    const fileReads: FileReads = {
      checksum: async (path) => {
        if (path === stalls) {
          reachedStall.resolve();
          await stalled.promise;
        }
        return { kind: 'read', value: rewritten ? 0xDEADBEEF : 1 };
      },
      version: () => Promise.resolve({ kind: 'read', value: undefined }), readable: () => Promise.resolve({ kind: 'read', value: false }),
      trusting: (read) => { judgedAgain++; return read(); },
    };
    return { fileReads, rewrite: () => { rewritten = true; }, judgedAgain: () => judgedAgain, reachedStall: reachedStall.promise, release: stalled.resolve };
  }

  async function judged(value: InstanceValue, fileReads: FileReads = checksums().fileReads) {
    const made = scene(value, { fileReads });
    await made.reconciled([held('A.esp')]);
    return made;
  }

  it('judges the last reconcile\'s order again when the instance\'s sorting rule files change', async () => {
    const made = await judged(valueOf(linesOf('A.esp')));

    made.instance.publish(valueOf(linesOf('A.esp'), {
      dataFolderPlugins: { kind: 'listed', names: new Set() }, dataFolderFiles: listed(),
      sortingRuleFiles: userlist('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'),
    }));

    await vi.waitFor(() => { expect(errors()).toEqual(['"A.esp" requires "Missing.esp", which is missing.']); }, { interval: 1 });
  });

  it.each([
    ['a file a rule reads', 'Meshes/X.nif', 1],
    ['a file no rule reads', 'Textures/y.dds', 0],
  ])('judges the last reconcile\'s order again when a mod gains %s, and only then', async (_file, path, times) => {
    const { fileReads, judgedAgain } = checksums();
    const made = await judged(valueOf(linesOf('A.esp'), { sortingRuleFiles: NEEDS_MESH }), fileReads);
    const before = judgedAgain();

    made.instance.publish({ ...made.instance.value, filesByMod: new Map([[SOME_MOD, [fileIn('/mods/SomeMod', path)]]]) }, { named: [`/mods/SomeMod/${path}`], disk: false });
    await settle();

    expect(judgedAgain() - before).toBe(times);
  });

  it.each([
    ['a file a rule reads the bytes of', '/mods/SomeMod/Meshes/x.nif', ['m']],
    ['a game file a rule reads the bytes of', '/game/Data/Meshes/z.nif', ['m']],
    ['a file no rule reads', '/mods/SomeMod/Meshes/y.nif', []],
    ['a path a rule reads in another case, the same file on Windows alone', '/mods/SomeMod/MESHES/X.NIF', process.platform === 'win32' ? ['m'] : []],
  ])('judges the last reconcile\'s order again when %s is rewritten in place, and only then', async (_file, path, after) => {
    const { fileReads, rewrite } = checksums();
    const made = await judged(valueOf(linesOf('A.esp'), {
      sortingRuleFiles: userlist("plugins:\n  - name: A.esp\n    msg: [{type: warn, content: m, condition: 'checksum(\"Meshes/x.nif\", DEADBEEF) or checksum(\"Meshes/z.nif\", DEADBEEF)'}]\n"),
      files: meshes('Meshes/x.nif', 'Meshes/y.nif'), dataFolderFiles: listed('Meshes/z.nif'),
    }), fileReads);
    const before = warnings();

    rewrite();
    await made.instance.refresh([path]);
    await settle();

    expect([before, warnings()]).toEqual([[], after]);
  });

  it('judges again when the copy that wins a file the rules read is rewritten, after another mod came to win it', async () => {
    const wonBy = (name: string) => {
      const files = new FileConflictLookup();
      files.set({ relativePath: 'Meshes/x.nif', winner: `/mods/${name}/Meshes/x.nif`, winnerOrigin: { kind: 'mod', name }, providers: [{ kind: 'mod', name }] });
      return files;
    };
    const { fileReads, rewrite } = checksums();
    const made = await judged(valueOf(linesOf('A.esp'), {
      sortingRuleFiles: userlist("plugins:\n  - name: A.esp\n    msg: [{type: warn, content: m, condition: 'checksum(\"Meshes/x.nif\", DEADBEEF)'}]\n"), files: wonBy('ModA'),
    }), fileReads);
    made.instance.publish({ ...made.instance.value, files: wonBy('ModB') }, { named: [], disk: false });
    await settle();
    const before = warnings();

    rewrite();
    await made.instance.refresh(['/mods/ModB/Meshes/x.nif']);
    await settle();

    expect([before, warnings()]).toEqual([[], ['m']]);
  });

  it.each([
    ['a file a rule reads', 'Meshes/x.nif', 1],
    ['a file no rule reads', 'Meshes/other.nif', 0],
  ])('judges the last reconcile\'s order again when the game\'s Data folder gains %s, and only then', async (_file, path, times) => {
    const { fileReads, judgedAgain } = checksums();
    const made = await judged(valueOf(linesOf('A.esp'), {
      sortingRuleFiles: NEEDS_MESH, dataFolderPlugins: { kind: 'listed', names: new Set<string>() }, dataFolderFiles: listed(),
    }), fileReads);
    const before = judgedAgain();

    made.instance.publish({ ...made.instance.value, dataFolderFiles: listed(path) }, { named: [`/game/Data/${path}`], disk: false });
    await settle();

    expect(judgedAgain() - before).toBe(times);
  });

  it('judges again when a file the last judgement to land read is rewritten, while a newer judgement still reads', async () => {
    const rulesReading = (mesh: string) => userlist(`plugins:\n  - name: A.esp\n    msg: [{type: warn, content: m, condition: 'checksum("${mesh}", DEADBEEF)'}]\n`);
    const { fileReads, judgedAgain, reachedStall, release } = checksums('Meshes/y.nif');
    const made = await judged(valueOf(linesOf('A.esp'), { sortingRuleFiles: rulesReading('Meshes/x.nif'), files: meshes('Meshes/x.nif', 'Meshes/y.nif') }), fileReads);
    const before = judgedAgain();

    made.instance.publish({ ...made.instance.value, sortingRuleFiles: rulesReading('Meshes/y.nif') }, { named: [], disk: false });
    await reachedStall;
    await made.instance.refresh(['/mods/SomeMod/Meshes/x.nif']);
    release();
    await settle();

    expect(judgedAgain() - before).toBe(2);
  });

  it('judges the last reconcile\'s order again when only the files present change', async () => {
    const present = (files: [string, OriginFile][]) => valueOf(linesOf('A.esp'), {
      sortingRuleFiles: NEEDS_MESH, dataFolderPlugins: { kind: 'listed', names: new Set<string>() }, dataFolderFiles: { kind: 'listed', files: new Map(files) },
    });
    const made = await judged(present([]));
    const before = errors();

    made.instance.publish(present([['meshes/x.nif', fileIn('/game/Data', 'Meshes/x.nif')]]));

    await vi.waitFor(() => { expect([before, errors()]).toEqual([[MISSING_MESH], []]); }, { interval: 1 });
  });
});

describe('a record filter hides a plugin with no matches', () => {
  async function filtered(value: InstanceValue, facts: PluginMetadata[]) {
    const made = scene(value);
    await made.reconciled(facts);
    await filtersRecords(made, 'a.sql');
    return made;
  }
  const AB = valueOf(linesOf('A.esp', 'B.esp'));
  const A_UNMATCHED = [held('A.esp', { hasMatchingRecords: false }), held('B.esp')];

  it('keeps hidden the row a record filter hid when mEdit becomes unreachable', async () => {
    const made = await filtered(AB, A_UNMATCHED);

    await made.unreachable();

    expect(await made.names()).toEqual(['B.esp']);
  });

  it('keeps a plugin the filter still matches visible and expandable', async () => {
    const made = await filtered(AB, A_UNMATCHED);

    expect((await made.items()).map((item) => [nameOf(item), item.collapsibleState])).toEqual([['B.esp', TreeItemCollapsibleState.Collapsed]]);
  });

  it('hides an implicit master row the record filter matches no records of', async () => {
    const made = await filtered(valueOf([], { noLine: ['Fallout4.esm'] }), [held('Fallout4.esm', { origin: 'Data/', hasMatchingRecords: false })]);

    expect(await made.rows()).toEqual([]);
  });

  const ownCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'Data/', hasMatchingRecords: matches });
  const modCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'ModA', hasMatchingRecords: matches });
  it.each([
    ['hides', 'matches nothing', 'first', [ownCopy(false), modCopy(true)], 0],
    ['hides', 'matches nothing', 'last', [modCopy(true), ownCopy(false)], 0],
    ['shows', 'matches', 'first', [ownCopy(true), modCopy(false)], 1],
    ['shows', 'matches', 'last', [modCopy(false), ownCopy(true)], 1],
  ] as const)('%s a locked row whose own copy %s, with its own copy listed %s', async (_verb, _match, _order, answer, rows) => {
    const made = await filtered(valueOf([{ name: 'Fallout4.esm', line: null, origin: 'ModA', winning: false }], { noLine: ['Fallout4.esm'] }), [...answer]);

    expect(await made.rows()).toHaveLength(rows);
  });

  it('hides no row by the answer for another plugin of its name, when mEdit names none at its origin', async () => {
    const made = await filtered(valueOf([{ name: 'A.esp', origin: 'RenamedMod' }]), [held('A.esp', { origin: 'SomeOtherMod', hasMatchingRecords: false })]);

    expect(await made.rows()).toHaveLength(1);
  });

  it('restores a hidden row in its new position when the underlying order changed while it was hidden', async () => {
    const made = await filtered(AB, A_UNMATCHED);
    const hidden = await made.names();

    made.instance.publish(valueOf(linesOf('B.esp', 'A.esp')));
    await made.changed([held('A.esp'), held('B.esp')]);

    expect([hidden, await made.names()]).toEqual([['B.esp'], ['B.esp', 'A.esp']]);
  });

  describe('when the fact re-read fails', () => {
    const REFUSED = { failed: 'refused', refusal: 'No load order has been received.' } as const;
    const hiddenByA = async () => {
      const made = await filtered(AB, A_UNMATCHED);
      made.client.setQueryFailure('getPlugins', REFUSED);
      return made;
    };

    it('keeps a row hidden by the filter still in force', async () => {
      const made = await hiddenByA();

      await made.changed(REFUSED);

      expect(await made.names()).toEqual(['B.esp']);
    });

    it('shows the row again when the filter was cleared', async () => {
      const made = await hiddenByA();
      made.client.setQueryAnswer('clearFilter', null);
      made.client.setQueryAnswer('getActiveFilter', null);

      await host.run('modbench.record.clearFilter');
      await settle();

      expect(await made.names()).toEqual(['A.esp', 'B.esp']);
    });

    it('shows the row again when another filter replaced the one that hid it', async () => {
      const made = await hiddenByA();

      await filtersRecords(made, 'b.sql');

      expect(await made.names()).toEqual(['A.esp', 'B.esp']);
    });
  });
});

describe('a row expands into the record browser children', () => {
  it('reads the row\'s own plugin of a shared filename, and every row beneath it carries that plugin', async () => {
    const client = browserClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummaryFixture({ plugin: 'Shared.esp', formKey: '000001:Shared.esp', origin: 'ModB' })], total: 1 },
    });
    const made = scene(valueOf([{ name: 'Shared.esp', line: 0, origin: 'ModA', winning: false }, { name: 'Shared.esp', line: 0, origin: 'ModB' }]), { client });
    await made.reconciled([held('Shared.esp', { origin: 'ModA' }), held('Shared.esp', { origin: 'ModB' })]);
    client.calls.length = 0;

    const [group] = await made.rows(present((await made.rows())[0], 'the first row'));
    const [record] = await made.items(group);

    expect(client.calls.filter(({ method }) => method === 'getRecordTypes' || method === 'getRecords').map(({ args }) => args))
      .toEqual([[{ name: 'Shared.esp', origin: 'ModB' }], [{ name: 'Shared.esp', origin: 'ModB' }, 'weap', 0, expect.any(Number)]]);
    expect(record?.command?.arguments?.[0]).toEqual({ argument: { kind: 'record', formKey: '000001:Shared.esp', plugin: { name: 'Shared.esp', origin: 'ModB' } } });
  });

  it('forwards the load order own change events', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    const redrawn = made.redraws();

    made.instance.publish({ ...made.instance.value, plugins: [...made.instance.value.plugins] });

    expect(redrawn).toEqual([undefined]);
  });

  it('draws no row again when only the files present change', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.rows();
    const redrawn = made.redraws();

    made.instance.publish({ ...made.instance.value, files: new FileConflictLookup(), dataFolderFiles: { kind: 'unresolved' } });
    await settle();

    expect(redrawn).toEqual([]);
  });
});

describe('a record row is identified by its kind, its plugin and its FormKey', () => {
  const SHARED = '000801:Fallout4.esm';
  const everyKindOfRecord = () => listsForThePluginAsked(browserClient({
    recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }, { type: 'wrld', count: 1, displayName: 'Worldspace' }, { type: 'cell', count: 1, displayName: 'Cell' }],
    records: { items: [recordSummaryFixture({ formKey: SHARED })], total: 1 },
    worldspaces: [{ workingTreeState: 'None', formKey: SHARED, editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
    worldspaceBlocks: { topCells: [{ workingTreeState: 'None', formKey: '000802:Fallout4.esm', isPersistentWorldspaceCell: true, hasChildren: true, hasParseFailure: false }], blocks: [] },
    cellChildRecords: { persistent: [{ workingTreeState: 'None', formKey: '000803:Fallout4.esm', editorId: 'DoorRef', recordType: 'refr', hasParseFailure: false }], temporary: [] },
    interiorCells: [{
      number: 0, hasParseFailure: false,
      subBlocks: [{ number: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: '000804:Fallout4.esm', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }],
    }],
  }));
  const RECORD_KINDS = new Set(['record', 'worldspace', 'cell', 'placed']);
  const isRecord = (item: vscode.TreeItem) => RECORD_KINDS.has(kindOf(item) ?? '');

  async function everyItem(made: Scene, under?: unknown): Promise<vscode.TreeItem[]> {
    const below = await Promise.all((await made.rows(under)).map(async (row) => {
      const item = await made.item(row);
      return [item, ...(item.collapsibleState ? await everyItem(made, row) : [])];
    }));
    return below.flat();
  }
  const recordIds = async (made: Scene) => (await everyItem(made)).filter(isRecord).map(({ id }) => id);

  async function heldOver(value: InstanceValue) {
    const made = scene(value, { client: everyKindOfRecord() });
    await made.reconciled(value.plugins.map(({ name, origin }) => held(name, { origin })));
    return made;
  }

  it('gives every record, worldspace, cell and placed reference row an identity, and no two rows one', async () => {
    const made = await heldOver(valueOf(linesOf('A.esp', 'B.esp')));

    const items = await everyItem(made);
    const ids = items.flatMap(({ id }) => (id === undefined ? [] : [id]));

    expect(items.filter(isRecord).map(kindOf).sort()).toEqual(['cell', 'cell', 'cell', 'cell', 'placed', 'placed', 'record', 'record', 'worldspace', 'worldspace']);
    expect(items.filter(isRecord).every(({ id }) => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds every row, at every level, collapsed', async () => {
    const made = await heldOver(valueOf([{ name: 'A.esp' }, { name: 'Off.esp', enabled: false }]));

    const items = await everyItem(made);

    expect([...new Set(items.map(kindOf))].sort()).toEqual(['block', 'cell', 'placed', 'placedGroup-persistent', 'plugin', 'record', 'recordType', 'subBlock', 'worldspace']);
    expect(items.map(({ collapsibleState }) => collapsibleState)).not.toContain(TreeItemCollapsibleState.Expanded);
  });

  it('keeps a record row\'s identity when its plugin\'s rows are asked for again', async () => {
    const made = await heldOver(valueOf(linesOf('A.esp')));

    const first = await recordIds(made);

    expect(await recordIds(made)).toEqual(first);
  });

  it('gives a record under the plugin of the same name from another origin another identity', async () => {
    const made = await heldOver(valueOf([{ name: 'A.esp', origin: 'ModA' }]));
    const fromModA = await recordIds(made);

    made.instance.publish(valueOf([{ name: 'A.esp', origin: 'ModB' }]));
    await made.reconciled([held('A.esp', { origin: 'ModB' })]);
    const fromModB = await recordIds(made);

    expect([fromModB.length, fromModB.filter((id) => fromModA.includes(id))]).toEqual([fromModA.length, []]);
  });
});

describe('a row walks up to its plugin row, as VS Code reveals it', () => {
  const NPC = '000900:A.esp';

  async function aboveThe(client: InMemoryMEditClient, kinds: readonly string[]) {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp')), { client });
    await made.reconciled([held('A.esp'), held('B.esp')]);
    const provider = made.view().treeDataProvider;
    let row: unknown = await made.rowNamed('A.esp');
    for (const kind of kinds) {
      const children = await made.rows(row);
      const items = await Promise.all(children.map(made.item));
      row = children[items.findIndex((item) => kindOf(item) === kind)];
    }
    const above: string[] = [];
    for (let parent = await provider.getParent?.(row); parent !== undefined && parent !== null; parent = await provider.getParent?.(parent)) {
      above.push(String(labelOf(await made.item(parent))));
    }
    return above;
  }

  it.each([
    ['a record\'s row through its group', browserClient({
      recordTypes: [{ type: 'npc_', count: 1, displayName: 'Non-Player Character' }], records: { items: [recordSummaryFixture({ formKey: NPC })], total: 1 },
    }), ['recordType', 'record'], ['Non-Player Character', '0 A.esp']],
    ['a worldspace\'s row through the Worldspace group', browserClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ formKey: NPC, hasParseFailure: false, workingTreeState: 'None', hasChildren: true }],
    }), ['recordType', 'worldspace'], ['Worldspace', '0 A.esp']],
    ['an interior cell\'s row through the Cell group\'s block and sub-block', browserClient({
      recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }],
      interiorCells: [{ number: 1, hasParseFailure: false, subBlocks: [{ number: 9, hasParseFailure: false, cells: [
        { workingTreeState: 'None', formKey: NPC, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false },
      ] }] }],
    }), ['recordType', 'block', 'subBlock', 'cell'], ['Sub-Block 9', 'Block 1', 'Cell', '0 A.esp']],
  ])('walks up from %s to its plugin row, and no further', async (_row, client, kinds, above) => {
    expect(await aboveThe(client, kinds)).toEqual(above);
  });
});

describe('the row states its conditions', () => {
  const flags = async (made: Scene) => (await made.items())[0]?.contextValue?.split(' ');

  it('states an editable plugin in a source mod', async () => {
    const made = scene(valueOf(linesOf('A.esp'), { listedSourceMods: new Set([SOME_MOD]) }));
    await made.reconciled([held('A.esp', { isCompiledPlugin: true })]);

    expect(await flags(made)).toEqual(['plugin', 'enabled', 'inSourceMod', 'compiledPlugin', 'editable']);
  });

  it('states a disabled line', async () => {
    const made = scene(valueOf([{ name: 'A.esp', enabled: false }]));
    await made.reconciled([held('A.esp')]);

    expect(await flags(made)).toEqual(['plugin', 'disabled', 'inNonSourceMod', 'nonCompiledPlugin']);
  });
});

describe('sorting-error decoration', () => {
  it('never touches collapsibleState, and the leading line stays the checkbox alone', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.reconciled([held('A.esp', { masters: ['Ghost.esm'] })]);

    const [item] = await made.items();

    expect([item?.collapsibleState, item?.checkboxState]).toEqual([TreeItemCollapsibleState.Collapsed, TreeItemCheckboxState.Checked]);
  });

  const baseThenA = (enabled: boolean) => valueOf([{ name: 'Base.esm', enabled }, { name: 'A.esp' }]);
  const needsBase = held('A.esp', { masters: ['Base.esm'] });
  it.each<[string, InstanceValue, PluginMetadata[], PluginLoadFailure[], string | undefined]>([
    ['an enabled master mEdit failed to read as present, for the game loads what mEdit cannot read', baseThenA(true),
      [needsBase], [{ name: 'Base.esm', origin: SOME_MOD, reason: 'Malformed record' }], undefined],
    ['a master that is listed but disabled as missing', baseThenA(false), [held('Base.esm', { isMaster: true }), needsBase], [], '1 error'],
    ['a master the game loads with no line as active', valueOf(linesOf('A.esp'), { noLine: ['Base.esm'] }),
      [held('Base.esm', { origin: 'Data/', isMaster: true }), needsBase], [], undefined],
  ])('reads %s', async (_case, value, read, failures, description) => {
    const made = scene(value);

    await made.reconciled(read, { failures });

    expect((await made.items())[1]?.description).toBe(description);
  });

  it('flags a master that loads after its dependant', async () => {
    const made = scene(valueOf(linesOf('B.esp', 'A.esp')));

    await made.reconciled([held('B.esp', { masters: ['A.esp'] }), held('A.esp')]);

    expect((await made.items()).map((item) => [nameOf(item), item.contextValue?.split(' ').includes('suggestedMove')])).toEqual([['B.esp', false], ['A.esp', true]]);
  });

  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.reconciled([held('A.esp', { masters: ['Ghost.esm'] })]);
    const before = (await made.items())[0]?.tooltip;

    await made.reconciled([held('A.esp', { isCompiledPlugin: true })]);

    const [item] = await made.items();
    expect(before).toContain('is missing or not active');
    expect([item?.tooltip, item?.iconPath, item?.description]).toEqual(['A.esp\nSomeMod', new ThemeIcon('blank'), undefined]);
  });
});

describe('the facts are pulled once and held', () => {
  const asked = (client: InMemoryMEditClient, method: string) => client.calls.filter((call) => call.method === method).length;

  it('re-renders without rebuilding the rows', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    await made.reconciled([held('A.esp')]);
    const before = await made.rows();
    const redrawn = made.redraws();

    await made.changed([held('A.esp')]);

    expect([redrawn.length > 0, (await made.rows())[0] === before[0]]).toEqual([true, true]);
  });

  it.each([
    ['the plugin rows', () => undefined, ['0 A.esp', '1 B.esp', '2 C.esp']],
    ['the rows beneath a plugin', (made: Scene) => made.rowNamed('A.esp'), ['Weapon']],
  ])('reads neither the plugin list nor the malformed-plugin scan while drawing %s', async (_rows, parent, labels) => {
    const made = scene(valueOf(linesOf('A.esp', 'B.esp', 'C.esp')), { client: browserClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] }) });
    await made.reconciled([held('A.esp'), held('B.esp'), held('C.esp')]);
    const reads = () => [asked(made.client, 'getPlugins'), asked(made.client, 'getDiagnoses')];
    const before = reads();

    const drawn = await made.labels(await parent(made));

    expect([drawn, reads()]).toEqual([labels, before]);
  });
});

describe('the label leads with the line (plugins.md, A row)', () => {
  it('zero-pads each line to the width of the last, so the numbers align', async () => {
    expect(await scene(valueOf([{ name: 'A.esp', line: 3 }, { name: 'B.esp', line: 10 }])).labels()).toEqual(['03 A.esp', '10 B.esp']);
  });

  it('leaves a plugin the game loads with no line to its file name', async () => {
    expect(await scene(valueOf(linesOf('A.esp'), { noLine: ['Base.esm'] })).labels()).toEqual(['Base.esm', '0 A.esp']);
  });
});

describe('the highlight (plugins.md, The highlight)', () => {
  const highlightsOf = async (made: Scene) => (await made.items()).map(({ label }) => (typeof label === 'object' ? label.highlights : undefined));
  const highlights = (made: Scene, ...plugins: PluginAddress[]) => { made.shown.drawsHighlight.highlight({ plugins, origins: [] }); };
  const BEE = { name: 'Bee.esp', origin: SOME_MOD };

  it('marks the whole label of each plugin it is handed, and no other', async () => {
    const made = scene(valueOf(linesOf('A.esp', 'Bee.esp')));

    highlights(made, BEE);

    expect(await highlightsOf(made)).toEqual([undefined, [[0, 9]]]);
  });

  it('matches by name and origin, so a plugin of the same name from another origin stays unmarked', async () => {
    const made = scene(valueOf([{ name: 'A.esp', origin: 'One' }]));

    highlights(made, { name: 'A.esp', origin: 'Other' });

    expect(await highlightsOf(made)).toEqual([undefined]);
  });

  it('clears the mark when handed none', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    highlights(made, { name: 'A.esp', origin: SOME_MOD });

    highlights(made);

    expect(await highlightsOf(made)).toEqual([undefined]);
  });

  it('keeps the row in place, with its id', async () => {
    const made = scene(valueOf(linesOf('A.esp')));
    const idsOf = async () => (await made.items()).map(({ id }) => id);
    const before = await idsOf();

    highlights(made, { name: 'A.esp', origin: SOME_MOD });

    expect(await idsOf()).toEqual(before);
  });

  it('tells the tree which rows changed, and only those', async () => {
    const made = scene(valueOf(linesOf('A.esp', 'Bee.esp')));
    await made.rows();
    const redrawn = made.redraws();

    highlights(made, BEE);

    expect(redrawn.map(nameOf)).toEqual(['Bee.esp']);
  });
});
