import { describe, it, expect } from 'vitest';
import { conflictTable } from '../conflictTable';
import { file, indexedValueOf, mod } from './indexedValue';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { ConflictRow } from '../../wire/conflictTable';
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

    const table = conflictTable(read(value), 'Middle');

    expect(table.kind === 'table' && table.columns).toEqual([
      { name: 'Low', isMod: true, opened: false },
      { name: 'Middle', isMod: true, opened: true },
      { name: 'High', isMod: true, opened: false },
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

    const table = conflictTable(read(value), 'Opened');

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

    const table = conflictTable(read(value), 'Opened');

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

    const table = conflictTable(read(value), 'Opened');

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

    const table = conflictTable(read(value), 'Opened');

    expect(table.kind === 'table' && table.columns).toEqual([
      { name: 'Opened', isMod: true, opened: true },
      { name: 'High', isMod: true, opened: false },
      { name: 'Overwrite', isMod: false, opened: false },
    ]);
    expect(table.kind === 'table' && shape(table.rows)).toEqual([
      { file: 'a.dds', cells: [true, false, true] },
      { file: 'b.dds', cells: [true, true, false] },
    ]);
  });
});

describe('the conflict table\'s states', () => {
  it('is an empty table before the first read lands', () => {
    expect(conflictTable({ value: instanceValueFixture(), sequence: 0 }, 'Opened')).toEqual({ kind: 'table', columns: [], rows: [] });
  });

  it('says a mod with no file order conflict has none', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened')], {
      Other: { files: [file('Other', 'b.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(conflictTable(read(value), 'Opened')).toEqual({ kind: 'message', text: 'No file order conflicts.' });
  });

  it('says a disabled mod\'s files take no part, though another mod has its files', async () => {
    const value = await indexedValueOf([mod('Other'), mod('Opened', false)], {
      Other: { files: [file('Other', 'a.dds')] },
      Opened: { files: [file('Opened', 'a.dds')] },
    });

    expect(conflictTable(read(value), 'Opened')).toEqual({ kind: 'message', text: 'Disabled: its files take no part in mod order.' });
  });

  it('says a mod gone from the mod list is gone, naming it', async () => {
    const value = await indexedValueOf([mod('Other')], { Other: { files: [file('Other', 'a.dds')] } });

    expect(conflictTable(read(value), 'Opened')).toEqual({ kind: 'message', text: '"Opened" is gone from the mod list.' });
  });
});
