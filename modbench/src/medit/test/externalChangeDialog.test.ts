import { describe, it, expect, vi } from 'vitest';
import {
  buttonsInDefaultOrder, runExternalChangeDialogs, ABSORB_BUTTON, KEEP_BUTTON,
} from '../externalChangeDialog';
import type { PendingExternalChange } from '../ApiClient';

function pending(overrides: Partial<PendingExternalChange> = {}): PendingExternalChange {
  return {
    plugin: 'Fixture.esp', origin: 'ModA', metaChanged: false, oldVersion: null, newVersion: null,
    ...overrides,
  };
}

// #417 orchestrator addition 1: button ORDER carries the default — a test asserts the exact
// button arrays for both classifier outcomes, not just which one ends up "selected" some other way.
describe('buttonsInDefaultOrder', () => {
  it('leads with Absorb Upstream Update when the meta tell fired', () => {
    expect(buttonsInDefaultOrder(pending({ metaChanged: true }))).toEqual([ABSORB_BUTTON, KEEP_BUTTON]);
  });

  it('leads with Keep as My Edit when meta is unchanged', () => {
    expect(buttonsInDefaultOrder(pending({ metaChanged: false }))).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('leads with Keep as My Edit when there is no meta trailer at all (also metaChanged: false on the wire)', () => {
    expect(buttonsInDefaultOrder(pending({ metaChanged: false, oldVersion: null }))).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('both buttons are always present, in either order', () => {
    for (const metaChanged of [true, false]) {
      const buttons = buttonsInDefaultOrder(pending({ metaChanged }));
      expect(buttons).toContain(ABSORB_BUTTON);
      expect(buttons).toContain(KEEP_BUTTON);
    }
  });
});

describe('runExternalChangeDialogs', () => {
  it('shows one modal per pending item, in default-order buttons, and maps the answer', async () => {
    const items = [pending({ plugin: 'A.esp', metaChanged: true }), pending({ plugin: 'B.esp', metaChanged: false })];
    const show = vi.fn()
      .mockResolvedValueOnce(ABSORB_BUTTON)
      .mockResolvedValueOnce(KEEP_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(outcomes).toEqual([
      { pending: items[0], answer: 'absorb' },
      { pending: items[1], answer: 'keep' },
    ]);
    expect(show).toHaveBeenNthCalledWith(1,
      'A.esp (in ModA) changed outside Modbench.',
      { modal: true, detail: expect.stringContaining('meta.ini also changed') },
      ABSORB_BUTTON, KEEP_BUTTON);
    expect(show).toHaveBeenNthCalledWith(2,
      'B.esp (in ModA) changed outside Modbench.',
      { modal: true, detail: expect.any(String) },
      KEEP_BUTTON, ABSORB_BUTTON);
  });

  it('answers defer on Esc/dismiss (an undefined choice)', async () => {
    const show = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runExternalChangeDialogs([pending()], show);

    expect(outcomes).toEqual([{ pending: pending(), answer: 'defer' }]);
  });

  it('shows dialogs sequentially — the second is not requested until the first resolves', async () => {
    const order: string[] = [];
    let resolveFirst!: (value: string) => void;
    const show = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        order.push('show-1');
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(() => {
        order.push('show-2');
        return Promise.resolve(KEEP_BUTTON);
      });

    const items = [pending({ plugin: 'A.esp' }), pending({ plugin: 'B.esp' })];
    const run = runExternalChangeDialogs(items, show);

    await Promise.resolve(); // let the first show() call happen
    expect(order).toEqual(['show-1']); // second must not have been requested yet

    resolveFirst(ABSORB_BUTTON);
    await run;

    expect(order).toEqual(['show-1', 'show-2']);
  });

  it('never queues a mega-dialog: exactly one showWarningMessage call per pending item', async () => {
    const items = [pending({ plugin: 'A.esp' }), pending({ plugin: 'B.esp' }), pending({ plugin: 'C.esp' })];
    const show = vi.fn().mockResolvedValue(KEEP_BUTTON);

    await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(3);
  });
});
