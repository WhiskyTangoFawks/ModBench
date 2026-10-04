import { describe, it, expect } from 'vitest';
import { conflictTable } from '../conflictTable';
import { file, indexedValueOf, mod } from './indexedValue';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { ConflictRow, ConflictTable } from '../../wire/conflictTable';
import type { Copy, FileCopies } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const read = (value: InstanceValue) => ({ value, sequence: 1 });

const shape = (rows: readonly ConflictRow[]): unknown[] => rows.map((row) =>
  (row.kind === 'folder' ? { folder: row.path, rows: shape(row.rows) } : { file: row.path, cells: row.cells.map((cell) => cell !== null) }));

describe('the conflict table\'s columns, over a mod order listed winning-first', () => {
  it('has one column per enabled mod with a copy of a row\'s file, losing on the left, and outlines the opened mod\'s', async () => {
    const value = await indexedValueOf([mod('High'), mod('Off', false), mod('Middle'), mod('Low'), mod('Apart')], {
      High: { files: [file('High', 'a.dds')] },
      Off: { files: [file('Off', 'a.dds')] },
      Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'b.dds')] },
      Low: { files: [file('Low', 'b.dds')] },
      Apart: { files: [file('Apart', 'c.dds')] },
    });

    const table = conflictTable(read(value), 'Middle', []);

    expect(table.kind === 'table' && table.columns).toMatchObject([
      { name: 'Low', origin: { kind: 'mod', name: 'Low' }, opened: false },
      { name: 'Middle', origin: { kind: 'mod', name: 'Middle' }, opened: true },
      { name: 'High', origin: { kind: 'mod', name: 'High' }, opened: false },
    ]);
  });
});

describe('the conflict table\'s rows', () => {
  it('has a row for each file the mod shares, as a folder tree, folders first and then files, each by name', async () => {
    const shared = ['textures/b/x.dds', 'textures/a.dds', 'meshes/m.nif', 'z.esp', 'b.ini'];
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: shared.map((path) => file('Other', path)) },
      Opened: { files: [...shared, 'textures/alone.dds', 'alone.txt'].map((path) => file('Opened', path)) },
    });

    const table = conflictTable(read(value), 'Opened', []);

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

    const table = conflictTable(read(value), 'Opened', []);

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

    const table = conflictTable(read(value), 'Opened', []);

    expect(table.kind === 'table' && table.columns.map((column) => column.name)).toEqual(['Low', 'Opened']);
    expect(table.kind === 'table' && shape(table.rows)).toEqual([
      { file: 'a.dds', cells: [true, true] },
      { file: 'c.dds', cells: [true, true] },
    ]);
  });

  it('has a row for a file the mod shares with Overwrite alone, and Overwrite\'s column rightmost', async () => {
    const value = await indexedValueOf([mod('High'), mod('Opened')], {
      High: { files: [file('High', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds'), file('Opened', 'b.dds')] },
    }, { files: [file('overwrite', 'a.dds')] });

    const table = conflictTable(read(value), 'Opened', []);

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

describe('the conflict table\'s states', () => {
  it('is an empty table before the first read lands', () => {
    expect(conflictTable({ value: instanceValueFixture(), sequence: 0 }, 'Opened', [])).toEqual({ kind: 'table', columns: [], rows: [] });
  });

  it('says a mod with no file order conflict has none', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: [file('Other', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(conflictTable(read(value), 'Opened', [])).toEqual({ kind: 'message', text: 'No file order conflicts.' });
  });

  it('says a disabled mod\'s files take no part, though another mod has its files', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened', false)], {
      Other: { files: [file('Other', 'a.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(conflictTable(read(value), 'Opened', [])).toEqual({ kind: 'message', text: 'Disabled: its files take no part in mod order.' });
  });

  it('says a mod gone from the mod list is gone, naming it', async () => {
    const value = await indexedValueOf([mod('Other')], { Other: { files: [file('Other', 'a.dds')] } });

    expect(conflictTable(read(value), 'Opened', [])).toEqual({ kind: 'message', text: '"Opened" is gone from the mod list.' });
  });
});

// Winning first, as the Instance loader answers: a number is a group of same bytes, a string the reason a copy is unreadable.
const copiesOf = (relativePath: string, copies: Record<string, number | string>): FileCopies => ({
  relativePath,
  copies: Object.entries(copies).map(([name, answer]): Copy => ({
    origin: { kind: 'mod', name },
    ...(typeof answer === 'number' ? { kind: 'read', sameAs: answer } : { kind: 'unreadable', reason: answer }),
  })),
});

const colours = (table: ConflictTable) => {
  if (table.kind !== 'table') throw new Error('no table');
  const cells = (row: ConflictRow): unknown =>
    (row.kind === 'folder' ? { folder: row.path, state: row.state, rows: row.rows.map(cells) }
      : { file: row.path, state: row.state, cells: row.cells.map((cell) => cell && cell.state) });
  return { columns: table.columns.map((column) => column.state), rows: table.rows.map(cells) };
};

async function threeMods(copies: FileCopies[], paths = ['a.dds']) {
  const value = await indexedValueOf([mod('High'), mod('Middle'), mod('Low')], Object.fromEntries(
    ['High', 'Middle', 'Low'].map((name) => [name, { files: paths.map((path) => file(name, path)) }])));
  return colours(conflictTable(read(value), 'Middle', copies));
}

describe('the conflict table\'s colours, the record panel\'s read for a file', () => {
  it('gives a row whose every copy is the same no colour: the master, and copies identical to it', async () => {
    expect(await threeMods([copiesOf('a.dds', { High: 0, Middle: 0, Low: 0 })])).toEqual({
      columns: ['Master', 'IdenticalToMaster', 'IdenticalToMaster'],
      rows: [{ file: 'a.dds', state: 'NoConflict', cells: ['Master', 'IdenticalToMaster', 'IdenticalToMaster'] }],
    });
  });

  it('makes a row an Override when every copy that differs from the master is the winning copy\'s', async () => {
    expect(await threeMods([copiesOf('a.dds', { High: 1, Middle: 1, Low: 0 })])).toEqual({
      columns: ['Master', 'Override', 'Override'],
      rows: [{ file: 'a.dds', state: 'Override', cells: ['Master', 'Override', 'Override'] }],
    });
  });

  it('makes a row a Conflict when a copy differs from both the master and the winner: the winner wins, that copy loses', async () => {
    expect(await threeMods([copiesOf('a.dds', { High: 2, Middle: 1, Low: 0 })])).toEqual({
      columns: ['Master', 'ConflictLoses', 'ConflictWins'],
      rows: [{ file: 'a.dds', state: 'Conflict', cells: ['Master', 'ConflictLoses', 'ConflictWins'] }],
    });
  });

  it('gives every copy the same as the winner ConflictWins, and a copy the same as the master IdenticalToMaster, in a Conflict row', async () => {
    const value = await indexedValueOf([mod('A'), mod('B'), mod('C'), mod('D'), mod('E')], Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E'].map((name) => [name, { files: [file(name, 'a.dds')] }])));

    const table = colours(conflictTable(read(value), 'A', [copiesOf('a.dds', { A: 1, B: 2, C: 1, D: 0, E: 0 })]));

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

    const table = colours(conflictTable(read(value), 'Middle', [copiesOf('a.dds', { High: 1, Middle: 0 }), copiesOf('b.dds', { Middle: 0, Low: 0 })]));

    expect(table.rows).toEqual([
      { file: 'a.dds', state: 'Override', cells: [null, 'Master', 'Override'] },
      { file: 'b.dds', state: 'NoConflict', cells: ['Master', 'IdenticalToMaster', null] },
    ]);
  });

  it('colours each column\'s header with its worst cell, and a folder with the worst row beneath it', async () => {
    const table = await threeMods([
      copiesOf('f/a.dds', { High: 1, Middle: 1, Low: 0 }),
      copiesOf('f/b.dds', { High: 2, Middle: 1, Low: 0 }),
      copiesOf('c.dds', { High: 0, Middle: 0, Low: 0 }),
    ], ['f/a.dds', 'f/b.dds', 'c.dds']);

    expect(table.columns).toEqual(['Master', 'ConflictLoses', 'ConflictWins']);
    expect(table.rows).toMatchObject([{ folder: 'f', state: 'Conflict' }, { file: 'c.dds', state: 'NoConflict' }]);
  });

  it('shows an unreadable copy no state and says why, and its row no colour', async () => {
    const value = await indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'a.dds')] }, Low: { files: [file('Low', 'a.dds')] },
    });

    const table = conflictTable(read(value), 'High', [copiesOf('a.dds', { High: 'in use', Low: 0 })]);

    expect(table).toMatchObject({
      columns: [{ state: null }, { state: null }],
      rows: [{ path: 'a.dds', state: null, cells: [{ state: null }, { state: null, unreadable: 'in use' }] }],
    });
  });

  it('shows no state while the which-copies answer has not landed', async () => {
    expect(await threeMods([])).toEqual({ columns: [null, null, null], rows: [{ file: 'a.dds', state: null, cells: [null, null, null] }] });
  });
});

