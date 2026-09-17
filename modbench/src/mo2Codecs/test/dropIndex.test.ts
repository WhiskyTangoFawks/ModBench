import { describe, it, expect } from 'vitest';
import { dropIndexForMove } from '../dropIndex';
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
