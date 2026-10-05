import { describe, it, expect, vi } from 'vitest';
import { fakeQuickPick } from './quickPickDouble';

const { createQuickPick } = vi.hoisted(() => ({ createQuickPick: vi.fn() }));
vi.mock('vscode', () => ({ window: { createQuickPick } }));

import { pickWithMarked } from '../pickWithMarked';

const [a, b, c] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }] as const;
const items = [a, b, c];

function open(marked: { label: string } | undefined) {
  const fake = fakeQuickPick<{ label: string }>();
  createQuickPick.mockReturnValue(fake.qp);
  const result = pickWithMarked(items, marked, 'Pick one');
  return { ...fake, result };
}

describe('pickWithMarked', () => {
  it('opens with the items, the placeholder and the marked item active', async () => {
    const { qp, escape, result } = open(b);
    escape();
    await result;

    expect(qp.items).toEqual(items);
    expect(qp.placeholder).toBe('Pick one');
    expect(qp.activeItems).toEqual([b]);
    expect(qp.show).toHaveBeenCalled();
  });

  it('marks nothing when no item is marked', async () => {
    const { qp, escape, result } = open(undefined);
    escape();
    await result;

    expect(qp.activeItems).toEqual([]);
  });

  it('yields the accepted item and closes the pick', async () => {
    const { qp, accept, result } = open(a);
    accept(c);

    expect(await result).toBe(c);
    expect(qp.dispose).toHaveBeenCalled();
  });

  it('yields undefined on Esc and disposes the pick', async () => {
    const { qp, escape, result } = open(a);
    escape();

    expect(await result).toBeUndefined();
    expect(qp.dispose).toHaveBeenCalled();
  });
});
