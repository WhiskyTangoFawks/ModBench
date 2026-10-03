import { describe, it, expect } from 'vitest';
import { dropIndexIn } from '../dropIndex';

describe('dropIndexIn — a drop in a tree\'s terms → the index a splice writes at, counted among the entries that remain once the block leaves the order', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];

  it('the losing end is index 0, whatever else the list holds', () => {
    expect(dropIndexIn(order, ['D'], { kind: 'losingEnd' })).toBe(0);
    expect(dropIndexIn(order, ['A', 'B'], { kind: 'losingEnd' })).toBe(0);
    expect(dropIndexIn([], [], { kind: 'losingEnd' })).toBe(0);
  });

  it('the winning end is past the last row that survives the move', () => {
    expect(dropIndexIn(order, ['B'], { kind: 'winningEnd' })).toBe(4);
    expect(dropIndexIn(order, ['A', 'B'], { kind: 'winningEnd' })).toBe(3);
  });

  it('before a row is that row\'s own post-removal index', () => {
    expect(dropIndexIn(order, ['A'], { kind: 'before', name: 'D' })).toBe(2);
    expect(dropIndexIn(order, ['E'], { kind: 'before', name: 'B' })).toBe(1);
    expect(dropIndexIn(order, ['C'], { kind: 'before', name: 'A' })).toBe(0);
  });

  it('a contiguous selection before a row counts every moved row above it', () => {
    expect(dropIndexIn(order, ['B', 'C', 'D'], { kind: 'before', name: 'A' })).toBe(0);
  });

  it('a non-contiguous selection before a row counts only the moved rows above it', () => {
    expect(dropIndexIn(order, ['A', 'C', 'E'], { kind: 'before', name: 'D' })).toBe(1);
  });

  it('a drop on one of the block\'s own rows is the block\'s own index', () => {
    expect(dropIndexIn(order, ['B', 'C', 'D'], { kind: 'before', name: 'C' })).toBe(1);
  });

  it('after a row is one past before it, so a tree running losing-at-top lands no drop a row off from where the user let go', () => {
    expect(dropIndexIn(order, ['A'], { kind: 'after', name: 'D' })).toBe(3);
    expect(dropIndexIn(order, ['E'], { kind: 'after', name: 'B' })).toBe(2);
  });

  it('matches the target and the moved rows to the order ignoring case, as the game compares a plugin\'s filename', () => {
    expect(dropIndexIn(order, ['a'], { kind: 'before', name: 'd' })).toBe(2);
  });

  it('refuses a target that is not in the order, on either side, naming it, since a block has no place beside a row that has gone', () => {
    expect(() => dropIndexIn(order, ['A'], { kind: 'before', name: 'Nope' })).toThrow('Plugin not found in plugins.txt: Nope');
    expect(() => dropIndexIn(order, ['A'], { kind: 'after', name: 'Nope' })).toThrow('Plugin not found in plugins.txt: Nope');
  });
});
