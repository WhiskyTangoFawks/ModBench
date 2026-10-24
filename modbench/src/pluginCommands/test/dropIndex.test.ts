import { describe, it, expect } from 'vitest';
import { dropIndexIn, type Drop } from '../dropIndex';

describe('dropIndexIn — a drop in a tree\'s terms → the record index a splice writes at, counted among the entries that remain once the block leaves the order', () => {
  const ORDER = ['A', 'B', 'C', 'D', 'E'];

  it.each<[string, readonly string[], readonly string[], Drop, number]>([
    ['the losing end is index 0, whatever else the list holds', ORDER, ['D'], { kind: 'losingEnd' }, 0],
    ['the losing end of a block that heads the list is index 0', ORDER, ['A', 'B'], { kind: 'losingEnd' }, 0],
    ['the losing end of an empty list is index 0', [], [], { kind: 'losingEnd' }, 0],
    ['the winning end is past the last row that survives the move', ORDER, ['B'], { kind: 'winningEnd' }, 4],
    ['the winning end counts out every moved row', ORDER, ['A', 'B'], { kind: 'winningEnd' }, 3],
    ['before a row below the moved one is that row\'s own post-removal index', ORDER, ['A'], { kind: 'before', name: 'D' }, 2],
    ['before a row above the moved one is that row\'s own index', ORDER, ['E'], { kind: 'before', name: 'B' }, 1],
    ['before the first row is index 0', ORDER, ['C'], { kind: 'before', name: 'A' }, 0],
    ['a contiguous selection before a row counts every moved row above it', ORDER, ['B', 'C', 'D'], { kind: 'before', name: 'A' }, 0],
    ['a non-contiguous selection before a row counts only the moved rows above it', ORDER, ['A', 'C', 'E'], { kind: 'before', name: 'D' }, 1],
    ['a drop on one of the block\'s own rows is the block\'s own index', ORDER, ['B', 'C', 'D'], { kind: 'before', name: 'C' }, 1],
    ['after a row below the moved one is one past before it, so a tree running losing-at-top lands no drop a row off', ORDER, ['A'], { kind: 'after', name: 'D' }, 3],
    ['after a row above the moved one is one past before it', ORDER, ['E'], { kind: 'after', name: 'B' }, 2],
    ['the target and the moved rows match the order ignoring case, as the game compares a plugin\'s filename', ORDER, ['a'], { kind: 'before', name: 'd' }, 2],
  ])('%s', (_case, order, moved, drop, index) => {
    expect(dropIndexIn(order, moved, drop)).toBe(index);
  });
});
