import { describe, it, expect, vi } from 'vitest';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';

const { createQuickPick } = vi.hoisted(() => ({ createQuickPick: vi.fn() }));
vi.mock('vscode', () => ({ window: { createQuickPick } }));

import { pickEnumValue } from '../enumPicker';

const choices = [{ value: 'A', label: 'Alpha' }, { value: 'B', label: 'Beta' }];

function open(current: string) {
  const fake = fakeQuickPick<{ label: string; value: string }>();
  createQuickPick.mockReturnValue(fake.qp);
  return { ...fake, result: pickEnumValue(choices, current) };
}

describe('the enum pick', () => {
  it('lists the names and opens on the current one', async () => {
    const { qp, escape, result } = open('B');
    escape();
    await result;

    expect(qp.items.map(i => i.label)).toEqual(['Alpha', 'Beta']);
    expect(qp.activeItems.map(i => i.label)).toEqual(['Beta']);
  });

  it('yields the chosen name\'s value', async () => {
    const { accept, result } = open('A');
    accept({ label: 'Beta', value: 'B' });

    expect(await result).toBe('B');
  });

  it('yields null on Esc', async () => {
    const { escape, result } = open('A');
    escape();

    expect(await result).toBeNull();
  });
});
