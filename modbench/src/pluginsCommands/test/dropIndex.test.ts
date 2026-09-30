import { describe, it, expect } from 'vitest';
import { dropIndexIn } from '../dropIndex';

// A drop names its target before the block leaves the order; the index a splice writes at counts
// among the entries that remain. Which side of the target a tree means is its view direction's.
describe('dropIndexIn — a drop in a tree\'s terms → the index a splice writes at', () => {
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

  // The two sides must differ by exactly one, or a tree running losing-at-top lands every drop
  // one row off from where the user let go.
  it('after a row is one past before it', () => {
    expect(dropIndexIn(order, ['A'], { kind: 'after', name: 'D' })).toBe(3);
    expect(dropIndexIn(order, ['E'], { kind: 'after', name: 'B' })).toBe(2);
  });

  // ADR-0012: a plugin's filename compares as the game compares it.
  it('matches the target and the moved rows to the order ignoring case', () => {
    expect(dropIndexIn(order, ['a'], { kind: 'before', name: 'd' })).toBe(2);
  });

  // Never silently wrong: a block has no place beside a row that has gone.
  it('refuses a target that is not in the order, on either side, naming it', () => {
    expect(() => dropIndexIn(order, ['A'], { kind: 'before', name: 'Nope' })).toThrow('Plugin not found in plugins.txt: Nope');
    expect(() => dropIndexIn(order, ['A'], { kind: 'after', name: 'Nope' })).toThrow('Plugin not found in plugins.txt: Nope');
  });
});
