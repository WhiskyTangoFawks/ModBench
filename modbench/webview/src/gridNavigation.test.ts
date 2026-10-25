import { describe, it, expect } from 'vitest';
import { navigate, type NavRow } from './gridNavigation';
import { columnKey } from '../../src/wire/columnKey';
import type { ColumnKey } from './types';

const A = columnKey({ name: 'A.esp', origin: 'Data/' });
const B = columnKey({ name: 'B.esp', origin: 'Data/' });

const rows: NavRow[] = [
  { key: 'Head', parent: null, expandable: true, expanded: true },
  { key: 'Head.Id', parent: 'Head', expandable: false, expanded: false },
  { key: 'Bounds', parent: null, expandable: true, expanded: true },
  { key: 'Bounds.X', parent: 'Bounds', expandable: false, expanded: false },
  { key: 'Shut', parent: null, expandable: true, expanded: false },
  { key: 'Name', parent: null, expandable: false, expanded: false },
];

const focus = (rowKey: string, plugin: ColumnKey | null) => ({ focus: { rowKey, plugin } });

describe('a key in the grid moves the focus or folds a row, as a tree\'s keys do', () => {
  it.each<[string, string, string, ColumnKey | null, number, ReturnType<typeof navigate>]>([
    ['Down moves one row and keeps the column', 'ArrowDown', 'Head', A, 3, focus('Head.Id', A)],
    ['Up moves one row and keeps the column', 'ArrowUp', 'Bounds', null, 3, focus('Head.Id', null)],
    ['Up on the first row stays put', 'ArrowUp', 'Head', A, 3, focus('Head', A)],
    ['Down on the last row stays put', 'ArrowDown', 'Name', A, 3, focus('Name', A)],
    ['Home goes to the first row', 'Home', 'Bounds', B, 3, focus('Head', B)],
    ['End goes to the last row', 'End', 'Bounds', B, 3, focus('Name', B)],
    ['Page Down moves a page', 'PageDown', 'Head', A, 2, focus('Bounds', A)],
    ['Page Down stops at the last row', 'PageDown', 'Bounds.X', A, 9, focus('Name', A)],
    ['Page Up moves a page', 'PageUp', 'Bounds.X', A, 2, focus('Head.Id', A)],
    ['Page Up stops at the first row', 'PageUp', 'Head.Id', A, 9, focus('Head', A)],
    ['Right on a collapsed row of the label column expands it', 'ArrowRight', 'Shut', null, 3, { toggle: 'Shut' }],
    ['Right on an expanded row steps into its first child', 'ArrowRight', 'Bounds', null, 3, focus('Bounds.X', null)],
    ['Right on a leaf of the label column does nothing', 'ArrowRight', 'Name', null, 3, null],
    ['Left on an expanded row of the label column collapses it', 'ArrowLeft', 'Bounds', null, 3, { toggle: 'Bounds' }],
    ['Left on a leaf steps out to its parent', 'ArrowLeft', 'Bounds.X', null, 3, focus('Bounds', null)],
    ['Left on a top-level collapsed row does nothing', 'ArrowLeft', 'Shut', null, 3, null],
    ['Right on a value column moves a column and never expands', 'ArrowRight', 'Shut', A, 3, focus('Shut', B)],
    ['Left on a value column moves a column and never collapses', 'ArrowLeft', 'Bounds', B, 3, focus('Bounds', A)],
    ['Left on the first value column moves to the label column', 'ArrowLeft', 'Bounds', A, 3, focus('Bounds', null)],
    ['Right on the last column does nothing', 'ArrowRight', 'Bounds', B, 3, null],
    ['another key does nothing', 'a', 'Bounds', A, 3, null],
  ])('%s', (_case, key, rowKey, plugin, page, outcome) => {
    expect(navigate(key, rows, [A, B], { rowKey, plugin }, page)).toEqual(outcome);
  });

  it.each([
    ['moves from it', 'ArrowDown', A, focus('Shut', A)],
    ['folds it', 'ArrowLeft', null, { toggle: 'Bounds' }],
  ])('acts from the nearest visible ancestor when the focused row has left the grid: a key %s', (_case, key, plugin, outcome) => {
    const collapsed = rows.filter(r => r.key !== 'Bounds.X');
    expect(navigate(key, collapsed, [A, B], { rowKey: 'Bounds.X', plugin }, 3)).toEqual(outcome);
  });
});
