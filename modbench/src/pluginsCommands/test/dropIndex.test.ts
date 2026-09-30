import { describe, it, expect } from 'vitest';
import { dropIndexIn } from '../dropIndex';

// A drag hands over a pre-removal row index, but a move counts among the entries left
// after the moved names are removed.
describe('a drop before a row — pre-removal drop target → post-removal toIndex', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];

  it('drop onto the first row → index 0', () => {
    expect(dropIndexIn(order, ['C'], { kind: 'before', name: 'A' })).toBe(0);
  });

  it('contiguous multi-selection subtracts all moved rows above the target', () => {
    // move [B,C,D] onto A → none are above A → 0
    expect(dropIndexIn(order, ['B', 'C', 'D'], { kind: 'before', name: 'A' })).toBe(0);
  });

  it('non-contiguous multi-selection counts only the moved rows above the target', () => {
    // move [A,C,E] onto D → A(0) and C(2) are above D(3) → 3 - 2 = 1
    expect(dropIndexIn(order, ['A', 'C', 'E'], { kind: 'before', name: 'D' })).toBe(1);
  });

  it('drop onto a selected row is the block\'s own index', () => {
    // move [B,C,D] onto C → 2 - 1 (B above) = 1, where B already stands
    expect(dropIndexIn(order, ['B', 'C', 'D'], { kind: 'before', name: 'C' })).toBe(1);
  });
});

// Which side of the target a tree means is its own view direction's answer; turning that answer
// into the index a splice writes at is this module's.
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
  });

  // The two sides must differ by exactly one, or a tree running losing-at-top lands every drop
  // one row off from where the user let go.
  it('after a row is one past before it', () => {
    expect(dropIndexIn(order, ['A'], { kind: 'after', name: 'D' })).toBe(3);
    expect(dropIndexIn(order, ['E'], { kind: 'after', name: 'B' })).toBe(2);
  });

  it('an unknown target name lands at the end, on either side', () => {
    expect(dropIndexIn(order, ['A'], { kind: 'before', name: 'Nope' })).toBe(4);
    expect(dropIndexIn(order, ['A'], { kind: 'after', name: 'Nope' })).toBe(5);
  });
});
