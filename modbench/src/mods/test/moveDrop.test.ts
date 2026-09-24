import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor }));

import { dropMove } from '../moveDrop';
import { ModNode, OverwriteNode, SeparatorNode, type SortDirection } from '../ModListProvider';
import type { Mod } from '../../instanceLoader/instance';

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const modRow = (name: string) => new ModNode(mod(name));
const separatorRow = (name: string, ...modNames: string[]) =>
  new SeparatorNode({ kind: 'separator', name, enabled: true }, modNames.map(mod));

// modlist.txt, winning first: Alpha, Group A, Beta, Gamma, Group B, Delta. Group A holds Alpha,
// Group B holds Beta and Gamma, and Delta is ungrouped.
const alpha = modRow('Alpha');
const beta = modRow('Beta');
const gamma = modRow('Gamma');
const delta = modRow('Delta');
const groupA = separatorRow('Group A', 'Alpha');
const groupB = separatorRow('Group B', 'Beta', 'Gamma');

const BOTH: readonly SortDirection[] = ['losingAtTop', 'winningAtTop'];
// "Directly above" and "first", as shown, lie toward the end the view shows at the top; the
// bottom of the view is the other end.
const atTop = { losingAtTop: 'losing', winningAtTop: 'winning' } as const;
const atBottom = { losingAtTop: 'winning', winningAtTop: 'losing' } as const;

describe.each(BOTH)('a drop is a move, as shown, with %s', (direction) => {
  it('mods dropped on a mod land directly above it', () => {
    expect(dropMove({ rows: [alpha, delta], focused: delta }, gamma, direction)).toEqual({
      argument: [alpha, delta], target: { place: { kind: 'mod', name: 'Gamma' }, end: atTop[direction] },
    });
  });

  it('mods dropped on a separator become its first mods', () => {
    expect(dropMove({ rows: [delta], focused: delta }, groupA, direction)).toEqual({
      argument: [delta], target: { place: { kind: 'separator', name: 'Group A' }, end: atTop[direction] },
    });
  });

  it('a separator dropped on a separator lands directly above it', () => {
    expect(dropMove({ rows: [groupB], focused: groupB }, groupA, direction)).toEqual({
      argument: [groupB], target: { place: { kind: 'separator', name: 'Group A' }, end: atTop[direction] },
    });
  });

  it('mods dropped below the last row land at the bottom of the view', () => {
    expect(dropMove({ rows: [beta], focused: beta }, undefined, direction)).toEqual({
      argument: [beta], target: { place: { kind: 'modOrder' }, end: atBottom[direction] },
    });
  });

  it('a separator dropped below the last row lands at the bottom of the view', () => {
    expect(dropMove({ rows: [groupA], focused: groupA }, undefined, direction)).toEqual({
      argument: [groupA], target: { place: { kind: 'modOrder' }, end: atBottom[direction] },
    });
  });

  it('a mixed drag moves only the rows of the focused row\'s kind', () => {
    expect(dropMove({ rows: [groupB, delta, alpha], focused: delta }, groupA, direction)).toEqual({
      argument: [delta, alpha], target: { place: { kind: 'separator', name: 'Group A' }, end: atTop[direction] },
    });
    expect(dropMove({ rows: [groupB, delta], focused: groupB }, groupA, direction)).toEqual({
      argument: [groupB], target: { place: { kind: 'separator', name: 'Group A' }, end: atTop[direction] },
    });
  });

  describe('a drop where what is dragged cannot go is no move', () => {
    it('on Overwrite', () => {
      expect(dropMove({ rows: [delta], focused: delta }, new OverwriteNode(0), direction)).toBeUndefined();
    });

    it('on a row being dragged', () => {
      expect(dropMove({ rows: [alpha, delta], focused: delta }, alpha, direction)).toBeUndefined();
      expect(dropMove({ rows: [groupA, groupB], focused: groupB }, groupA, direction)).toBeUndefined();
    });

    it('on a row being dragged, as the view rebuilt it since the drag began', () => {
      expect(dropMove({ rows: [alpha, delta], focused: delta }, modRow('Alpha'), direction)).toBeUndefined();
    });

    it('on a row being dragged that is not of the focused row\'s kind', () => {
      expect(dropMove({ rows: [groupB, delta], focused: delta }, groupB, direction)).toBeUndefined();
    });

    it('inside a separator being dragged', () => {
      expect(dropMove({ rows: [groupB, delta], focused: delta }, gamma, direction)).toBeUndefined();
    });

    it('a separator on a mod', () => {
      expect(dropMove({ rows: [groupA], focused: groupA }, delta, direction)).toBeUndefined();
    });
  });
});
