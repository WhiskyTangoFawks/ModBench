import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri }));

import { dropMove, type DraggedRows } from '../moveDrop';
import { ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import type { SortDirection } from '../../drivingLib/sortDirectionToggle';
import type { Mod } from '../../instanceLoader/instance';

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const modRow = (name: string) => new ModNode(mod(name));
const separatorRow = (name: string, ...modNames: string[]) =>
  new SeparatorNode({ kind: 'separator', name, enabled: true }, modNames.map(mod));

const alpha = modRow('Alpha');
const beta = modRow('Beta');
const gamma = modRow('Gamma');
const delta = modRow('Delta');
const groupA = separatorRow('Group A', 'Alpha');
const groupB = separatorRow('Group B', 'Beta', 'Gamma');

const BOTH: readonly SortDirection[] = ['losingAtTop', 'winningAtTop'];
const endTheViewShowsAtTheTop = { losingAtTop: 'losing', winningAtTop: 'winning' } as const;
const endTheViewShowsAtTheBottom = {losingAtTop: 'winning', winningAtTop: 'losing' } as const;

describe.each(BOTH)('a drop is a move, as shown, with %s', (direction) => {
  it('mods dropped on a mod land directly above it', () => {
    expect(dropMove({ rows: [alpha, delta], focused: delta }, gamma, direction)).toEqual({
      argument: [alpha, delta], target: { place: { kind: 'mod', name: 'Gamma' }, end: endTheViewShowsAtTheTop[direction] },
    });
  });

  it('mods dropped on a separator become its first mods', () => {
    expect(dropMove({ rows: [delta], focused: delta }, groupA, direction)).toEqual({
      argument: [delta], target: { place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] },
    });
  });

  it('a separator dropped on a separator lands directly above it', () => {
    expect(dropMove({ rows: [groupB], focused: groupB }, groupA, direction)).toEqual({
      argument: [groupB], target: { place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] },
    });
  });

  it.each([
    ['mods', beta],
    ['a separator', groupA],
  ])('%s dropped below the last row land at the bottom of the view', (_case, row) => {
    expect(dropMove({ rows: [row], focused: row }, undefined, direction)).toEqual({
      argument: [row], target: { place: { kind: 'modOrder' }, end: endTheViewShowsAtTheBottom[direction] },
    });
  });

  it('a mixed drag moves only the rows of the focused row\'s kind', () => {
    expect(dropMove({ rows: [groupB, delta, alpha], focused: delta }, groupA, direction)).toEqual({
      argument: [delta, alpha], target: { place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] },
    });
    expect(dropMove({ rows: [groupB, delta], focused: groupB }, groupA, direction)).toEqual({
      argument: [groupB], target: { place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] },
    });
  });

  it.each<[string, DraggedRows, ModlistNode]>([
    ['mods on Overwrite', { rows: [delta], focused: delta }, new OverwriteNode([], 'MO2')],
    ['mods on a mod being dragged', { rows: [alpha, delta], focused: delta }, alpha],
    ['separators on a separator being dragged', { rows: [groupA, groupB], focused: groupB }, groupA],
    ['mods on a mod being dragged, as the view rebuilt it since the drag began', { rows: [alpha, delta], focused: delta }, modRow('Alpha')],
    ['mods on a separator being dragged that is not of the focused row\'s kind', { rows: [groupB, delta], focused: delta }, groupB],
    ['mods inside a separator being dragged', { rows: [groupB, delta], focused: delta }, gamma],
    ['a separator on a mod', { rows: [groupA], focused: groupA }, delta],
  ])('a drop of %s is no move', (_case, dragged, target) => {
    expect(dropMove(dragged, target, direction)).toBeUndefined();
  });
});
