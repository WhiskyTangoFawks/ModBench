import { describe, it, expect } from 'vitest';
import { dropIndexForMove, dropIndexIn } from '../dropIndex';
import { movePluginsInText } from '../pluginsText';

// A drag hands over a pre-removal row index, but movePluginsInText counts among
// the entries left after the moved names are removed.
describe('dropIndexForMove — pre-removal drop target → post-removal toIndex', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];

  it('down-drag: subtracts the moved row above the target (the off-by-one case)', () => {
    // drop A onto D → block must land before D, i.e. post-removal index 2
    expect(dropIndexForMove(order, ['A'], 'D')).toBe(2);
  });

  it('up-drag: no adjustment when nothing moved sits above the target', () => {
    expect(dropIndexForMove(order, ['E'], 'B')).toBe(1);
  });

  it('drop past the last row (undefined target) appends', () => {
    // remove B → 4 survivors; append at index 4
    expect(dropIndexForMove(order, ['B'], undefined)).toBe(4);
  });

  it('drop onto the first row → index 0', () => {
    expect(dropIndexForMove(order, ['C'], 'A')).toBe(0);
  });

  it('contiguous multi-selection subtracts all moved rows above the target', () => {
    // move [B,C,D] onto A → none are above A → 0
    expect(dropIndexForMove(order, ['B', 'C', 'D'], 'A')).toBe(0);
  });

  it('non-contiguous multi-selection counts only the moved rows above the target', () => {
    // move [A,C,E] onto D → A(0) and C(2) are above D(3) → 3 - 2 = 1
    expect(dropIndexForMove(order, ['A', 'C', 'E'], 'D')).toBe(1);
  });

  it('drop onto a selected row is a no-op move', () => {
    // move [B,C,D] onto C → 2 - 1 (B above) = 1; feeding this to the mover is a no-op
    const toIndex = dropIndexForMove(order, ['B', 'C', 'D'], 'C');
    expect(toIndex).toBe(1);
    const text = '*A\r\n*B\r\n*C\r\n*D\r\n*E\r\n';
    expect(movePluginsInText(text, ['B', 'C', 'D'], toIndex)).toBe(text);
  });

  it('an unknown target name appends (defensive fallback)', () => {
    expect(dropIndexForMove(order, ['A'], 'Nope')).toBe(order.length - 1);
  });

  it('round-trips through movePluginsInText for a down-drag', () => {
    const text = '*A\r\n*B\r\n*C\r\n*D\r\n*E\r\n';
    const toIndex = dropIndexForMove(order, ['A'], 'D');
    const out = movePluginsInText(text, ['A'], toIndex);
    expect(out).toBe('*B\r\n*C\r\n*A\r\n*D\r\n*E\r\n');
  });
});

// Which side of the target a tree means is its own view direction's answer; turning that answer
// into the index a splice writes at is this module's.
describe('dropIndexIn — a drop in a tree\'s terms → the index a splice writes at', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];

  it('the winning end is index 0, whatever else the list holds', () => {
    expect(dropIndexIn(order, ['D'], { kind: 'winningEnd' })).toBe(0);
    expect(dropIndexIn(order, ['A', 'B'], { kind: 'winningEnd' })).toBe(0);
    expect(dropIndexIn([], [], { kind: 'winningEnd' })).toBe(0);
  });

  it('the losing end is past the last row that survives the move', () => {
    expect(dropIndexIn(order, ['B'], { kind: 'losingEnd' })).toBe(4);
    expect(dropIndexIn(order, ['A', 'B'], { kind: 'losingEnd' })).toBe(3);
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
