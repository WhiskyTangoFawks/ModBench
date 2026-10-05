import { describe, it, expect } from 'vitest';
import { navigate, type NavRow } from './gridNavigation';
import { columnKey } from '../../src/wire/columnKey';
import type { ColumnKey } from './types';

const A = columnKey({ name: 'A.esp', origin: 'Data' });
const B = columnKey({ name: 'B.esp', origin: 'Data' });

const rows: NavRow[] = [
  { key: 'Head', parent: null, expandable: true, expanded: true },
  { key: 'Head.Id', parent: 'Head', expandable: false, expanded: false },
  { key: 'Bounds', parent: null, expandable: true, expanded: true },
  { key: 'Bounds.X', parent: 'Bounds', expandable: false, expanded: false },
  { key: 'Shut', parent: null, expandable: true, expanded: false },
  { key: 'Name', parent: null, expandable: false, expanded: false },
];

const press = (key: string, rowKey: string, plugin: ColumnKey | null, page = 3) =>
  navigate(key, rows, [A, B], { rowKey, plugin }, page);

describe('navigate', () => {
  it('Down and Up move one row and keep the column', () => {
    expect(press('ArrowDown', 'Head', A)).toEqual({ focus: { rowKey: 'Head.Id', plugin: A } });
    expect(press('ArrowUp', 'Bounds', null)).toEqual({ focus: { rowKey: 'Head.Id', plugin: null } });
  });

  it('Up on the first row and Down on the last stay put', () => {
    expect(press('ArrowUp', 'Head', A)).toEqual({ focus: { rowKey: 'Head', plugin: A } });
    expect(press('ArrowDown', 'Name', A)).toEqual({ focus: { rowKey: 'Name', plugin: A } });
  });

  it('Home and End go to the first and last row', () => {
    expect(press('Home', 'Bounds', B)).toEqual({ focus: { rowKey: 'Head', plugin: B } });
    expect(press('End', 'Bounds', B)).toEqual({ focus: { rowKey: 'Name', plugin: B } });
  });

  it('Page Down and Page Up move a page and stop at the ends', () => {
    expect(press('PageDown', 'Head', A, 2)).toEqual({ focus: { rowKey: 'Bounds', plugin: A } });
    expect(press('PageDown', 'Bounds.X', A, 9)).toEqual({ focus: { rowKey: 'Name', plugin: A } });
    expect(press('PageUp', 'Bounds.X', A, 2)).toEqual({ focus: { rowKey: 'Head.Id', plugin: A } });
    expect(press('PageUp', 'Head.Id', A, 9)).toEqual({ focus: { rowKey: 'Head', plugin: A } });
  });

  it('Right on a collapsed row of the label column expands it', () => {
    expect(press('ArrowRight', 'Shut', null)).toEqual({ toggle: 'Shut' });
  });

  it('Right on an expanded row steps into its first child', () => {
    expect(press('ArrowRight', 'Bounds', null)).toEqual({ focus: { rowKey: 'Bounds.X', plugin: null } });
  });

  it('Right on a leaf of the label column does nothing', () => {
    expect(press('ArrowRight', 'Name', null)).toBeNull();
  });

  it('Left on an expanded row of the label column collapses it', () => {
    expect(press('ArrowLeft', 'Bounds', null)).toEqual({ toggle: 'Bounds' });
  });

  it('Left on a leaf steps out to its parent', () => {
    expect(press('ArrowLeft', 'Bounds.X', null)).toEqual({ focus: { rowKey: 'Bounds', plugin: null } });
  });

  it('Left on a top-level collapsed row does nothing', () => {
    expect(press('ArrowLeft', 'Shut', null)).toBeNull();
  });

  it('Left and Right on a value column move a column and never expand or collapse', () => {
    expect(press('ArrowRight', 'Shut', A)).toEqual({ focus: { rowKey: 'Shut', plugin: B } });
    expect(press('ArrowLeft', 'Bounds', B)).toEqual({ focus: { rowKey: 'Bounds', plugin: A } });
    expect(press('ArrowLeft', 'Bounds', A)).toEqual({ focus: { rowKey: 'Bounds', plugin: null } });
  });

  it('Right on the last column does nothing', () => {
    expect(press('ArrowRight', 'Bounds', B)).toBeNull();
  });

  it('acts from the nearest visible ancestor when the focused row has left the grid', () => {
    const collapsed = rows.filter(r => r.key !== 'Bounds.X');
    expect(navigate('ArrowDown', collapsed, [A, B], { rowKey: 'Bounds.X', plugin: A }, 3))
      .toEqual({ focus: { rowKey: 'Shut', plugin: A } });
    expect(navigate('ArrowLeft', collapsed, [A, B], { rowKey: 'Bounds.X', plugin: null }, 3))
      .toEqual({ toggle: 'Bounds' });
  });

  it('ignores other keys', () => {
    expect(press('a', 'Bounds', A)).toBeNull();
  });
});
