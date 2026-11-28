import { afterEach, describe, it, expect, vi, onTestFinished } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { everyChainedPromiseSettled, modsViewOn } from './modsViewOn';
import { answers, changeSetting, seen, vscodeModule, type FakeWebviewPanel } from './modsVscode';
import { file, indexedValueOf, mod } from './indexedValue';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../../instanceLoader/instance';
import { CONFLICT_TABLE_READY, CONFLICT_TABLE_SHOWN, parseConflictTableShown, type ConflictRow, type ConflictTable } from '../../wire/conflictTable';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { instanceOver } from '../../test/instanceOver';
import { Uri } from '../../test/vscodeMock';
import { present } from '../../ports/present';
import { settled } from '../../test/eventually';

const CELL_VALUE_SETTING = 'modbench.mods.conflictTable.cellValue';
const READY = { type: CONFLICT_TABLE_READY };
const SECOND_NS = 1_000_000_000n;

type Held = { readonly size: bigint; readonly modifiedNs: bigint; readonly hash: string } | string;

const stamped = (size: bigint, modifiedSeconds = 0n): Held => ({ size, modifiedNs: modifiedSeconds * SECOND_NS, hash: `${size}/${modifiedSeconds}` });

const copiesOf = (relativePath: string, copies: Record<string, number | string>): Record<string, Held> => Object.fromEntries(
  Object.entries(copies).map(([name, held]) => [`/instance/${name}/${relativePath}`, typeof held === 'number' ? { size: 1n, modifiedNs: 0n, hash: `${held}` } : held]));

function copiesAnswering(value: InstanceValue, held: Readonly<Record<string, Held>> = {}): InstanceAnswers {
  const paths = [...value.filesByMod.values(), value.overwriteFiles].flat().map(({ path }) => path);
  const copies = new Map<string, Held>([...paths.map((path): [string, Held] => [path, { size: 1n, modifiedNs: 0n, hash: path }]), ...Object.entries(held)]);
  const read = [...copies].flatMap(([path, copy]) => (typeof copy === 'string' ? [] : [[path, copy] as const]));
  return {
    stamps: new Map(read.map(([path, { size, modifiedNs }]) => [path, { size, modifiedNs }])),
    hashes: new Map(read.map(([path, { size, hash }]) => [path, { size: Number(size), hash }])),
    unreadableStamps: new Map([...copies].flatMap(([path, copy]) => (typeof copy === 'string' ? [[path, copy] as const] : []))),
  };
}

function shut(): { readonly gate: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

const column = (name: string) => ({ webviewSection: 'conflictColumn', mod: name, preventDefaultContextMenuItems: true });

type Shown = ReturnType<typeof modsViewOn>;

async function openedOn(shown: Shown, name: string): Promise<FakeWebviewPanel> {
  await shown.run('modbench.mod.openConflicts', column(name));
  return present(seen.panels.at(-1), 'the conflict table\'s tab');
}

async function tableOf(value: InstanceValue, name: string, held: Record<string, Held> = {}, cellValue?: string): Promise<ConflictTable> {
  const shown = modsViewOn({ value, adapter: fakeInstanceAdapter(readingFixture(), copiesAnswering(value, held)) });
  answers.settings.set(CELL_VALUE_SETTING, cellValue);
  const panel = await openedOn(shown, name);
  panel.receive(READY);
  await settled(() => { expect(tablesOf(panel)).not.toEqual([]); });
  return present(tablesOf(panel).at(-1), 'the table shown');
}

const shownOn = (panel: FakeWebviewPanel) => panel.posted.flatMap((message) => parseConflictTableShown(message) ?? []);
const tablesOf = (panel: FakeWebviewPanel) => shownOn(panel).map(({ table }) => table);

const shape = (rows: readonly ConflictRow[]): unknown[] => rows.map((row) =>
  (row.kind === 'folder' ? { folder: row.path, rows: shape(row.rows) } : { file: row.path, cells: row.cells.map((cell) => cell !== null) }));

const firstRowCells = (table: ConflictTable | undefined) => {
  const row = table?.kind === 'table' ? table.rows[0] : undefined;
  return row?.kind === 'file' ? row.cells : [];
};

const winningCells = (table: ConflictTable, path: string) => (table.kind === 'table'
  ? table.rows.flatMap((row) => (row.kind === 'file' && row.path === path ? [row.cells.map((cell) => cell?.winning === true)] : []))
  : []);

const colours = (table: ConflictTable) => {
  if (table.kind !== 'table') throw new Error('no table');
  const cells = (row: ConflictRow): unknown =>
    (row.kind === 'folder' ? { folder: row.path, state: row.state, rows: row.rows.map(cells) }
      : { file: row.path, state: row.state, cells: row.cells.map((cell) => cell && cell.state) });
  return { columns: table.columns.map((each) => each.state), rows: table.rows.map(cells) };
};

const shared = () => indexedValueOf([mod('High'), mod('Low')], { High: { files: [file('High', 'a.dds')] }, Low: { files: [file('Low', 'a.dds')] } });

async function threeMods(held: Record<string, Held>, paths = ['a.dds']) {
  const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], Object.fromEntries(
    ['High', 'Middle', 'Low'].map((name) => [name, { files: paths.map((path) => file(name, path)) }])));
  return colours(await tableOf(value, 'Middle', held));
}

describe('open conflicts', () => {
  const conflictTableUri = (name: string) => Uri.from({ scheme: 'modbench-conflicts', path: `/${name}.modbench-conflicts` });
  const opened = () => seen.executed.filter(([command]) => command === 'vscode.openWith');
  const listing = () => modsViewOn({ value: instanceValueFixture({ mods: [{ kind: 'separator', name: 'Group', enabled: true }, mod('Textures'), mod('Meshes')] }) });

  it('opens the right-clicked mod\'s table as a preview editor', async () => {
    const { run, row } = listing();

    await run('modbench.mod.openConflicts', await row('Textures'));

    expect(opened()).toEqual([['vscode.openWith', conflictTableUri('Textures'), 'modbench.conflicts', { preview: true }]]);
  });

  it('opens a column header\'s mod\'s table', async () => {
    const { run } = listing();

    await run('modbench.mod.openConflicts', column('Meshes'));

    expect(opened().map(([, uri]) => uri)).toEqual([conflictTableUri('Meshes')]);
  });

  it('from the palette, opens the table of the one mod selected in Mods', async () => {
    const { run, row, view } = listing();
    view.selectRows([await row('Textures')]);

    await run('modbench.mod.openConflicts');

    expect(opened().map(([, uri]) => uri)).toEqual([conflictTableUri('Textures')]);
  });

  it('opens nothing on a row that is not a mod, or with no mod selected', async () => {
    const { run, row, view } = listing();
    view.selectRows([await row('Textures'), await row('Meshes')]);

    await run('modbench.mod.openConflicts', await row('Group'));
    await run('modbench.mod.openConflicts');
    await run('modbench.mod.openConflicts', { webviewSection: 'recordHeader', plugin: 'A.esp', origin: 'A' });

    expect(opened()).toEqual([]);
  });

  it('reports a table VS Code could not open, naming the mod', async () => {
    const { run, row, reporter } = listing();
    vi.spyOn(vscodeModule.commands, 'executeCommand').mockRejectedValueOnce(new Error('no editor'));

    await run('modbench.mod.openConflicts', await row('Textures'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to open the conflicts of "Textures".', detail: 'no editor' }]);
  });
});

describe('the conflict table\'s columns, over a mod order listed winning-first', () => {
  it('has one column per enabled mod with a copy of a row\'s file, losing on the left, and outlines the opened mod\'s', async () => {
    const value = await indexedValueOf([mod('High'), mod('Off', false), mod('Middle'), mod('Low'), mod('Apart')], {
      High: { files: [file('High', 'a.dds')] },
      Off: { files: [file('Off', 'a.dds')] },
      Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'b.dds')] },
      Low: { files: [file('Low', 'b.dds')] },
      Apart: { files: [file('Apart', 'c.dds')] },
    });

    const table = await tableOf(value, 'Middle');

    expect(table.kind === 'table' && table.columns).toMatchObject([
      { name: 'Low', origin: { kind: 'mod', name: 'Low' }, opened: false },
      { name: 'Middle', origin: { kind: 'mod', name: 'Middle' }, opened: true },
      { name: 'High', origin: { kind: 'mod', name: 'High' }, opened: false },
    ]);
  });
});

describe('the conflict table over archived copies', () => {
  const archiveOf = (name: string, ...files: string[]) => ({ origin: modOrigin(name), archive: `/instance/${name}/${name}.ba2`, files });

  it('keeps the columns in mod order and marks the winning copy where the game stacks it: a loose copy over an archived one', async () => {
    const value = await indexedValueOf([mod('Archived'), mod('Loose')], {
      Archived: { files: [file('Archived', 'Archived.ba2')] },
      Loose: { files: [file('Loose', 'a.dds')] },
    }, undefined, [archiveOf('Archived', 'a.dds')]);

    const table = await tableOf(value, 'Archived');

    expect([table.kind === 'table' && table.columns.map(({ name }) => name), winningCells(table, 'a.dds')]).toEqual([['Loose', 'Archived'], [[true, false]]]);
  });

  it('has a row for a file the mod holds only in an archive the game loads', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: [file('Other', 'a.dds')] },
      Opened: { files: [file('Opened', 'Opened.ba2')] },
    }, undefined, [archiveOf('Opened', 'a.dds')]);

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && shape(table.rows)).toEqual([{ file: 'a.dds', cells: [true, true] }]);
  });
});

describe('the conflict table\'s rows', () => {
  it('has a row for each file the mod shares, as a folder tree, folders first and then files, each by name', async () => {
    const sharedPaths = ['textures/b/x.dds', 'textures/a.dds', 'meshes/m.nif', 'z.esp', 'b.ini'];
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: sharedPaths.map((path) => file('Other', path)) },
      Opened: { files: [...sharedPaths, 'textures/alone.dds', 'alone.txt'].map((path) => file('Opened', path)) },
    });

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && shape(table.rows)).toEqual([
      { folder: 'meshes', rows: [{ file: 'meshes/m.nif', cells: [true, true] }] },
      { folder: 'textures', rows: [
        { folder: 'textures/b', rows: [{ file: 'textures/b/x.dds', cells: [true, true] }] },
        { file: 'textures/a.dds', cells: [true, true] },
      ] },
      { file: 'b.ini', cells: [true, true] },
      { file: 'z.esp', cells: [true, true] },
    ]);
  });

  it('gives a mod no cell in a row whose file it lacks', async () => {
    const value = await indexedValueOf([mod('High'), mod('Opened'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] },
      Opened: { files: [file('Opened', 'a.dds'), file('Opened', 'b.dds')] },
      Low: { files: [file('Low', 'b.dds')] },
    });

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && shape(table.rows)).toEqual([
      { file: 'a.dds', cells: [false, true, true] },
      { file: 'b.dds', cells: [true, true, false] },
    ]);
  });

  it('takes no part from a file a mod excluded: no row when the opened mod excluded it, no cell when another did', async () => {
    const value = await indexedValueOf([mod('Excluder'), mod('Opened'), mod('Low')], {
      Excluder: { files: [file('Excluder', 'a.dds', true), file('Excluder', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds'), file('Opened', 'b.dds', true), file('Opened', 'c.dds')] },
      Low: { files: [file('Low', 'a.dds'), file('Low', 'b.dds'), file('Low', 'c.dds')] },
    });

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && [table.columns.map((each) => each.name), shape(table.rows)]).toEqual([
      ['Low', 'Opened'],
      [{ file: 'a.dds', cells: [true, true] }, { file: 'c.dds', cells: [true, true] }],
    ]);
  });

  it('has a row for a file the mod shares with Overwrite alone, and Overwrite\'s column rightmost', async () => {
    const value = await indexedValueOf([mod('High'), mod('Opened')], {
      High: { files: [file('High', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds'), file('Opened', 'b.dds')] },
    }, { files: [file('overwrite', 'a.dds')] });

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && table.columns).toMatchObject([
      { name: 'Opened', origin: { kind: 'mod', name: 'Opened' }, opened: true },
      { name: 'High', origin: { kind: 'mod', name: 'High' }, opened: false },
      { name: 'Overwrite', origin: { kind: 'runtimeOutput' }, opened: false },
    ]);
    expect(table.kind === 'table' && shape(table.rows)).toEqual([
      { file: 'a.dds', cells: [true, false, true] },
      { file: 'b.dds', cells: [true, true, false] },
    ]);
  });
});

describe('the conflict table\'s Overwrite column', () => {
  const overwriteCopies = { '/instance/overwrite/a.dds': stamped(2_048n, 1_600_000_000n), '/instance/Opened/a.dds': stamped(512n) };
  const sharedWithOverwrite = () => indexedValueOf([mod('Opened')], { Opened: { files: [file('Opened', 'a.dds')] } }, { files: [file('overwrite', 'a.dds')] });

  it('keeps Overwrite\'s column apart from the column of a mod named Overwrite, which loses to it', async () => {
    const value = await indexedValueOf([mod('Overwrite'), mod('Opened')], {
      Overwrite: { files: [file('mods/Overwrite', 'a.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    }, { files: [file('overwrite', 'a.dds')] });

    const table = await tableOf(value, 'Opened');

    expect(table.kind === 'table' && table.columns).toMatchObject([
      { name: 'Opened', origin: { kind: 'mod', name: 'Opened' } },
      { name: 'Overwrite', origin: { kind: 'mod', name: 'Overwrite' } },
      { name: 'Overwrite', origin: { kind: 'runtimeOutput' } },
    ]);
    expect(table.kind === 'table' && shape(table.rows)).toEqual([{ file: 'a.dds', cells: [true, true, true] }]);
  });

  it('colours Overwrite\'s copy, which wins, an Override over the master, and its column and row with it', async () => {
    const table = colours(await tableOf(await sharedWithOverwrite(), 'Opened', overwriteCopies));

    expect(table).toEqual({ columns: ['Master', 'Override'], rows: [{ file: 'a.dds', state: 'Override', cells: ['Master', 'Override'] }] });
  });

  it('shows Overwrite\'s value and carries its size and date for the tooltip', async () => {
    const table = await tableOf(await sharedWithOverwrite(), 'Opened', overwriteCopies);

    expect(firstRowCells(table)[1]).toMatchObject({ value: '2 KB', size: 2_048, modified: 1_600_000_000_000 });
  });
});

describe('the conflict table\'s states', () => {
  it('says a mod with no file order conflict has none', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: [file('Other', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(await tableOf(value, 'Opened')).toEqual({ kind: 'message', text: 'No file order conflicts.' });
  });

  it('says a disabled mod\'s files take no part, though another mod has its files', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened', false)], {
      Other: { files: [file('Other', 'a.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(await tableOf(value, 'Opened')).toEqual({ kind: 'message', text: 'Disabled: its files take part in no conflict.' });
  });

  it('says a mod gone from the mod list is gone, naming it', async () => {
    const value = await indexedValueOf([mod('Other')], { Other: { files: [file('Other', 'a.dds')] } });

    expect(await tableOf(value, 'Opened')).toEqual({ kind: 'message', text: '"Opened" is gone from the mod list.' });
  });
});

describe('the conflict table\'s colours, the record panel\'s read for a file', () => {
  it.each([
    ['no colour when every copy is the same: the master, and copies identical to it', { High: 0, Middle: 0, Low: 0 }, 'NoConflict', ['Master', 'IdenticalToMaster', 'IdenticalToMaster']],
    ['an Override when every copy that differs from the master is the winning copy\'s', { High: 1, Middle: 1, Low: 0 }, 'Override', ['Master', 'Override', 'Override']],
    ['a Conflict when a copy differs from both the master and the winner: the winner wins, that copy loses', { High: 2, Middle: 1, Low: 0 }, 'Conflict', ['Master', 'ConflictLoses', 'ConflictWins']],
  ])('makes a row %s', async (_case, copies, state, cells) => {
    expect(await threeMods(copiesOf('a.dds', copies))).toEqual({ columns: cells, rows: [{ file: 'a.dds', state, cells }] });
  });

  it('gives every copy the same as the winner ConflictWins, and a copy the same as the master IdenticalToMaster, in a Conflict row', async () => {
    const value = await indexedValueOf([mod('A'), mod('B'), mod('C'), mod('D'), mod('E')], Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E'].map((name) => [name, { files: [file(name, 'a.dds')] }])));

    const table = colours(await tableOf(value, 'A', copiesOf('a.dds', { A: 1, B: 2, C: 1, D: 0, E: 0 })));

    expect(table.rows).toEqual([
      { file: 'a.dds', state: 'Conflict', cells: ['Master', 'IdenticalToMaster', 'ConflictWins', 'ConflictLoses', 'ConflictWins'] },
    ]);
  });

  it('gives a mod with no copy no cell, and colours the rest by the copies there are', async () => {
    const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] },
      Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'b.dds')] },
      Low: { files: [file('Low', 'b.dds')] },
    });

    const table = colours(await tableOf(value, 'Middle', { ...copiesOf('a.dds', { High: 1, Middle: 0 }), ...copiesOf('b.dds', { Middle: 0, Low: 0 }) }));

    expect(table.rows).toEqual([
      { file: 'a.dds', state: 'Override', cells: [null, 'Master', 'Override'] },
      { file: 'b.dds', state: 'NoConflict', cells: ['Master', 'IdenticalToMaster', null] },
    ]);
  });

  it('colours each column\'s header with its worst cell, and a folder with the worst row beneath it', async () => {
    const table = await threeMods({
      ...copiesOf('f/a.dds', { High: 1, Middle: 1, Low: 0 }),
      ...copiesOf('f/b.dds', { High: 2, Middle: 1, Low: 0 }),
      ...copiesOf('c.dds', { High: 0, Middle: 0, Low: 0 }),
    }, ['f/a.dds', 'f/b.dds', 'c.dds']);

    expect(table.columns).toEqual(['Master', 'ConflictLoses', 'ConflictWins']);
    expect(table.rows).toMatchObject([{ folder: 'f', state: 'Conflict' }, { file: 'c.dds', state: 'NoConflict' }]);
  });

  it('ranks Master above IdenticalToMaster for a header, as xEdit\'s rollup does', async () => {
    const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
      High: { files: [file('High', 'a.dds'), file('High', 'b.dds')] },
      Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'b.dds')] },
      Low: { files: [file('Low', 'b.dds')] },
    });

    const table = colours(await tableOf(value, 'Middle', { ...copiesOf('a.dds', { High: 0, Middle: 0 }), ...copiesOf('b.dds', { High: 0, Middle: 0, Low: 0 }) }));

    expect(table.columns).toEqual(['Master', 'Master', 'IdenticalToMaster']);
  });

  it('shows an unreadable copy no state and says why, and its row no colour', async () => {
    const value = await indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] }, Low: { files: [file('Low', 'a.dds')] },
    });

    const table = await tableOf(value, 'High', copiesOf('a.dds', { High: 'in use', Low: 0 }));

    expect(table).toMatchObject({
      columns: [{ state: null }, { state: null }],
      rows: [{ path: 'a.dds', state: null, cells: [{ state: null }, { state: null, unreadable: 'in use' }] }],
    });
  });

  it('marks the winning copy\'s cell, Overwrite\'s when it wins, and no other', async () => {
    const value = await indexedValueOf([mod('High'), mod('Low'), mod('Other')], {
      High: { files: [file('High', 'a.dds'), file('High', 'b.dds')] },
      Low: { files: [file('Low', 'a.dds'), file('Low', 'b.dds')] },
      Other: { files: [file('Other', 'b.dds')] },
    }, { files: [file('overwrite', 'b.dds')] });

    const table = await tableOf(value, 'High');

    expect([winningCells(table, 'a.dds'), winningCells(table, 'b.dds')]).toEqual([[[false, false, true, false]], [[false, false, false, true]]]);
  });
});

describe('the conflict table\'s cell values', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const valuesOf = async (held: Record<string, Held>, cellValue: string) => {
    const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], Object.fromEntries(
      ['High', 'Middle', 'Low'].map((name) => [name, { files: [file(name, 'a.dds')] }])));
    return firstRowCells(await tableOf(value, 'Middle', held, cellValue));
  };
  const copies = {
    '/instance/High/a.dds': stamped(1_572_864n, 1_700_000_000n), '/instance/Middle/a.dds': stamped(2_048n, 1_600_000_000n), '/instance/Low/a.dds': stamped(512n),
  };

  it('carries each copy\'s size and date modified in milliseconds, for its tooltip', async () => {
    expect((await valuesOf(copies, 'size')).map((cell) => cell && [cell.size, cell.modified])).toEqual([
      [512, 0], [2_048, 1_600_000_000_000], [1_572_864, 1_700_000_000_000],
    ]);
  });

  it.each([
    ['the size in the unit that keeps it short', 'size', ['512 B', '2 KB', '1.5 MB']],
    ['the date modified as a day', 'dateModified', ['1970-01-01', '2020-09-13', '2023-11-14']],
  ] as const)('shows %s', async (_case, cellValue, values) => {
    expect((await valuesOf(copies, cellValue)).map((cell) => cell?.value)).toEqual(values);
  });

  it('shows the day in the local time, as the tooltip\'s date does', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const evening = { '/instance/High/a.dds': stamped(9n, BigInt(Date.UTC(2023, 10, 15, 3) / 1000)) };

    expect((await valuesOf(evening, 'dateModified')).map((cell) => cell?.value)).toEqual(['1969-12-31', '1969-12-31', '2023-11-14']);
  });

  it('keeps A for the master\'s contents: with the master unreadable the letters start at B, equal letters still equal bytes', async () => {
    expect((await valuesOf(copiesOf('a.dds', { High: 1, Middle: 0, Low: 'locked' }), 'contents')).map((cell) => cell?.value)).toEqual([undefined, 'B', 'C']);
  });

  it('shows a letter for the contents: A for the master\'s, so two cells with one letter hold one file', async () => {
    expect((await valuesOf(copiesOf('a.dds', { High: 1, Middle: 0, Low: 0 }), 'contents')).map((cell) => cell?.value)).toEqual(['A', 'A', 'B']);
  });

  it('shows no value and no size on a copy that could not be read', async () => {
    const [, , high] = await valuesOf(copiesOf('a.dds', { High: 'locked' }), 'size');
    expect(high).toEqual({ state: null, unreadable: 'locked', winning: true });
  });
});

describe('a mod\'s conflict table, open in a tab', () => {
  const firstRowValues = (panel: FakeWebviewPanel) => tablesOf(panel).map((table) => firstRowCells(table).map((cell) => cell?.value));
  const rowCounts = (panel: FakeWebviewPanel) => tablesOf(panel).map((table) => (table.kind === 'table' ? table.rows.length : undefined));
  const stampedHighOverLow = { '/instance/High/a.dds': stamped(2_048n), '/instance/Low/a.dds': stamped(512n) };

  const openOn = async (instance: FakeInstance, held?: Record<string, Held>, more: InstanceAnswers = {}) => {
    const copies = { ...copiesAnswering(instance.value, held), ...more };
    const shown = modsViewOn({ instance, adapter: fakeInstanceAdapter(readingFixture(), copies) });
    return { ...shown, copies, panel: await openedOn(shown, 'High') };
  };
  const askedOn = async (instance: FakeInstance, held?: Record<string, Held>, more?: InstanceAnswers) => {
    const opened = await openOn(instance, held, more);
    opened.panel.receive(READY);
    return opened;
  };
  const readyOn = async (instance: FakeInstance, held?: Record<string, Held>, more?: InstanceAnswers) => {
    const opened = await askedOn(instance, held, more);
    await settled(() => { expect(opened.panel.posted).not.toEqual([]); });
    return opened;
  };
  const publishedTo = async (instance: FakeInstance, value: InstanceValue | Promise<InstanceValue>) => {
    instance.publish(await value);
    await everyChainedPromiseSettled();
  };

  it('reads each copy at the path its mod holds it at, and shows what the adapter stamps', async () => {
    const stamp = (size: bigint) => ({ size, modifiedNs: 0n });
    const adapter = fakeInstanceAdapter(readingFixture(), { stamps: new Map([['/instance/High/a.dds', stamp(2048n)], ['/instance/Low/a.dds', stamp(512n)]]) });
    const panel = await openedOn(modsViewOn({ value: await shared(), adapter }), 'High');

    panel.receive(READY);

    await settled(() => { expect(firstRowValues(panel)).toEqual([['512 B', '2 KB']]); });
  });

  it('is titled with the mod\'s name, and loads the conflict table\'s page', async () => {
    const { panel } = await openOn(new FakeInstance(await shared()));

    expect([panel.title, panel.webview.html]).toEqual(['Conflicts: High', expect.stringContaining('assets/conflicts.js')]);
  });

  it('finds text in the page, and keeps the page while its tab is hidden (common.md, A view, story 12)', () => {
    modsViewOn();

    expect(seen.customEditorOptions.get('modbench.conflicts')).toEqual({ webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } });
  });

  it('shows the table, in the states the which-copies answer for the mod\'s paths gives, once the page is ready to hear it', async () => {
    const { panel, adapter } = await openOn(new FakeInstance(await shared()), stampedHighOverLow);

    panel.receive({ type: 'log' });
    await everyChainedPromiseSettled();
    const beforeReady = [...panel.posted];
    panel.receive(READY);

    await settled(() => { expect([beforeReady, adapter.stamped]).toEqual([[], ['/instance/High/a.dds', '/instance/Low/a.dds']]); });
    expect(shownOn(panel)).toMatchObject([{ type: CONFLICT_TABLE_SHOWN, table: { kind: 'table', rows: [{ state: 'Override' }] } }]);
  });

  describe('the cell value setting', () => {
    it.each([['unset', undefined], ['not a value it offers', 'colour']])('shows the size when the setting is %s', async (_, setting) => {
      const { panel } = await openOn(new FakeInstance(await shared()), stampedHighOverLow);
      answers.settings.set(CELL_VALUE_SETTING, setting);

      panel.receive(READY);

      await settled(() => { expect(firstRowValues(panel)).toEqual([['512 B', '2 KB']]); });
    });

    it('shows the value it names, and shows again when it changes, until the tab closes', async () => {
      const { panel } = await openOn(new FakeInstance(await shared()), stampedHighOverLow);
      answers.settings.set(CELL_VALUE_SETTING, 'contents');
      panel.receive(READY);
      await settled(() => { expect(firstRowValues(panel)).toEqual([['A', 'B']]); });

      changeSetting(CELL_VALUE_SETTING, 'dateModified');
      await settled(() => { expect(firstRowValues(panel)).toHaveLength(2); });
      panel.dispose();
      changeSetting(CELL_VALUE_SETTING, 'size');
      await everyChainedPromiseSettled();

      expect(firstRowValues(panel)).toEqual([['A', 'B'], ['1970-01-01', '1970-01-01']]);
    });

    it('shows again for this setting only, not for another', async () => {
      const { panel } = await readyOn(new FakeInstance(await shared()), stampedHighOverLow);

      changeSetting('modbench.something', 'on');
      changeSetting(CELL_VALUE_SETTING, 'contents');

      await settled(() => { expect(firstRowValues(panel)).toEqual([['512 B', '2 KB'], ['A', 'B']]); });
    });
  });

  it('shows a table while the instance is not read yet, asking for no copies', async () => {
    const { panel, adapter } = await readyOn(new FakeInstance(instanceValueFixture(), 0));

    expect([tablesOf(panel), adapter.stamped]).toEqual([[{ kind: 'table', columns: [], rows: [] }], []]);
  });

  it('follows the disk: each new instance value shows, until the tab closes', async () => {
    const instance = new FakeInstance(await shared());
    const { panel, adapter } = await openOn(instance);

    await publishedTo(instance, indexedValueOf([mod('High')], { High: { files: [file('High', 'a.dds')] } }));
    panel.dispose();
    await publishedTo(instance, shared());

    expect([tablesOf(panel), adapter.stamped]).toEqual([[{ kind: 'message', text: 'No file order conflicts.' }], []]);
  });

  it('shows again once another mod gains a copy of a file its mod holds, though the change names no file it read', async () => {
    const unchangedLow = { files: [file('Low', 'a.dds')] };
    const before = await indexedValueOf([mod('High'), mod('Low')], { High: { files: [file('High', 'own.dds')] }, Low: unchangedLow });
    const instance = new FakeInstance(before);
    const panel = await openedOn(modsViewOn({ instance, adapter: fakeInstanceAdapter(readingFixture(), copiesAnswering(before)) }), 'Low');
    const { files, filesByMod, foldersByMod, stackedCopies } = await indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'own.dds'), file('High', 'a.dds')] }, Low: unchangedLow,
    });

    instance.publish({ ...before, files, filesByMod, foldersByMod, stackedCopies }, { named: [], disk: false });

    await settled(() => { expect(rowCounts(panel)).toEqual([1]); });
  });

  describe('a change named by path', () => {
    const platform = present(Object.getOwnPropertyDescriptor(process, 'platform'), 'the platform');
    afterEach(() => { Object.defineProperty(process, 'platform', platform); });

    const onDisk = async () => {
      const held = (name: string) => ({ origin: { kind: 'mod' as const, name }, name: 'a.dds' });
      const instance = instanceOver(fakeInstanceAdapter(readingFixture({
        mods: [{ kind: 'mod', name: 'High', enabled: true }, { kind: 'mod', name: 'Low', enabled: true }], ...pluginFilesHeld(held('High'), held('Low')),
      })).adapter);
      onTestFinished(() => { instance.dispose(); });
      await instance.refresh();
      const copies = fakeInstanceAdapter(readingFixture(), copiesAnswering(instance.value));
      const panel = await openedOn(modsViewOn({ instance, adapter: copies }), 'High');
      panel.receive(READY);
      await everyChainedPromiseSettled();
      return { instance, copies };
    };
    const twice = ['/instance/mods/High/a.dds', '/instance/mods/Low/a.dds', '/instance/mods/High/a.dds', '/instance/mods/Low/a.dds'];

    it('reads its copies again when a change names one of them, and for no change to another file', async () => {
      const { instance, copies } = await onDisk();

      await instance.refresh(['/instance/mods/Low/b.dds']);
      await instance.refresh(['/instance/mods/Low/a.dds']);

      await settled(() => { expect(copies.stamped).toEqual(twice); });
    });

    it('on Windows, reads its copies again when a change names one in another case, as the watcher spells a path', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { instance, copies } = await onDisk();

      await instance.refresh(['/INSTANCE/mods/Low/A.DDS']);

      await settled(() => { expect(copies.stamped).toEqual(twice); });
    });
  });

  it('shows the answer of the newest value only, though an older one answers last', async () => {
    const instance = new FakeInstance(await shared());
    const older = shut();
    const { panel, copies, adapter } = await askedOn(instance, {}, { stampsHeldUntil: older.gate });
    await settled(() => { expect(adapter.stamped).not.toEqual([]); });
    copies.stampsHeldUntil = undefined;

    await publishedTo(instance, indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'a.dds'), file('High', 'b.dds')] }, Low: { files: [file('Low', 'a.dds'), file('Low', 'b.dds')] },
    }));
    older.open();
    await everyChainedPromiseSettled();

    expect(rowCounts(panel)).toEqual([2]);
  });

  it('shows the value it read the copies of, though the instance moves on to a change to another mod while they are read', async () => {
    const instance = new FakeInstance(await shared());
    const held = shut();
    const { panel, reporter, adapter } = await askedOn(instance, {}, { stampsHeldUntil: held.gate });
    await settled(() => { expect(adapter.stamped).not.toEqual([]); });

    instance.value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] }, Middle: { files: [file('Middle', 'a.dds')] }, Low: { files: [file('Low', 'a.dds')] },
    });
    held.open();
    await everyChainedPromiseSettled();

    expect([reporter.shownFailures, tablesOf(panel).map((table) => (table.kind === 'table' ? table.columns.length : table.kind))]).toEqual([[], [2]]);
  });

  describe('a copy that cannot be read', () => {
    it('is one line in the Output, naming the copy and why, however often the disk changes', async () => {
      const instance = new FakeInstance(await shared());
      const { reporter } = await readyOn(instance, copiesOf('a.dds', { High: 'in use' }));

      await publishedTo(instance, shared());

      await settled(() => {
        expect([reporter.shownFailures, reporter.reports]).toEqual([
          [{ severity: 'warning', message: 'Conflicts: "High"\'s copy of a.dds could not be read.', detail: 'in use' }], [],
        ]);
      });
    });

    it('is said again when it recovers and fails again, and when its reason changes', async () => {
      const instance = new FakeInstance(await shared());
      const { reporter, copies } = await openOn(instance);
      const publishedAs = async (held: Record<string, Held>) => {
        copies.unreadableStamps = copiesAnswering(instance.value, held).unreadableStamps;
        await publishedTo(instance, shared());
      };

      await publishedAs(copiesOf('a.dds', { High: 'in use' }));
      await publishedAs({});
      await publishedAs(copiesOf('a.dds', { High: 'in use' }));
      await publishedAs(copiesOf('a.dds', { High: 'access denied' }));

      await settled(() => { expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['in use', 'in use', 'access denied']); });
    });

    it('is told apart by its origin: a mod named as Overwrite is not Overwrite', async () => {
      const value = await indexedValueOf([mod('Overwrite'), mod('High')], {
        Overwrite: { files: [file('mods/Overwrite', 'a.dds')] }, High: { files: [file('High', 'a.dds')] },
      }, { files: [file('overwrite', 'a.dds')] });
      const instance = new FakeInstance(value);
      const { reporter, copies } = await readyOn(instance, copiesOf('a.dds', { 'mods/Overwrite': 'in use' }));
      copies.unreadableStamps = copiesAnswering(value, copiesOf('a.dds', { 'mods/Overwrite': 'in use', overwrite: 'in use' })).unreadableStamps;

      await publishedTo(instance, value);

      await settled(() => { expect(reporter.shownFailures).toHaveLength(2); });
    });
  });

  describe('a which-copies request that failed', () => {
    it('is, before any table, the error row in place of it and a line in the Output, with no notification', async () => {
      const { panel, reporter } = await readyOn(new FakeInstance(await shared()), {}, { stampFailure: 'disk gone' });

      await settled(() => {
        expect([shownOn(panel), reporter.shownFailures, reporter.reports]).toEqual([
          [{ type: CONFLICT_TABLE_SHOWN, table: { kind: 'error', reason: 'disk gone' } }],
          [{ severity: 'error', message: 'Failed to read the copies of "High"\'s conflicts.', detail: 'disk gone' }],
          [],
        ]);
      });
    });

    it('is, after a table, the rows staying under the message line, which the next good read clears', async () => {
      const instance = new FakeInstance(await shared());
      const { panel, reporter, copies } = await readyOn(instance);

      copies.stampFailure = 'disk gone';
      await publishedTo(instance, shared());
      copies.stampFailure = undefined;
      await publishedTo(instance, shared());

      await settled(() => {
        const [first, failed, recovered] = shownOn(panel);
        expect([failed, recovered, reporter.shownFailures.length, reporter.reports]).toEqual([{ ...first, notice: 'Showing the last good read: disk gone' }, first, 1, []]);
      });
    });

    it('is not reported once a newer value has asked', async () => {
      const instance = new FakeInstance(await shared());
      const older = shut();
      const { panel, reporter, copies, adapter } = await askedOn(instance, {}, { stampsHeldUntil: older.gate, stampFailure: 'old' });
      await settled(() => { expect(adapter.stamped).not.toEqual([]); });
      copies.stampsHeldUntil = undefined;
      copies.stampFailure = undefined;

      await publishedTo(instance, shared());
      older.open();
      await everyChainedPromiseSettled();

      expect([reporter.shownFailures, panel.posted.length]).toEqual([[], 1]);
    });
  });
});
