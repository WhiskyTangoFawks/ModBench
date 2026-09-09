import { describe, it, expect, vi } from 'vitest';
import {
  buttonsInDefaultOrder, messageFor, runExternalChangeDialogs, ABSORB_BUTTON, KEEP_BUTTON,
} from '../externalChangeDialog';
import type { UnansweredExternalChange } from '../../medit/client';

function unanswered(overrides: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
  return {
    origin: 'ModA', plugins: ['Fixture.esp'], trackedFiles: [], metaChanged: false, oldVersion: null, newVersion: null,
    ...overrides,
  };
}

describe('buttonsInDefaultOrder', () => {
  it('leads with Absorb Upstream Update when the meta tell fired', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: true }))).toEqual([ABSORB_BUTTON, KEEP_BUTTON]);
  });

  it('leads with Keep as My Edit when meta is unchanged', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: false }))).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('leads with Keep as My Edit when there is no meta trailer at all (also metaChanged: false on the wire)', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: false, oldVersion: null }))).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('both buttons are always present, in either order', () => {
    for (const metaChanged of [true, false]) {
      const buttons = buttonsInDefaultOrder(unanswered({ metaChanged }));
      expect(buttons).toContain(ABSORB_BUTTON);
      expect(buttons).toContain(KEEP_BUTTON);
    }
  });
});

describe('messageFor', () => {
  it('keeps the pinned single-plugin wording when the mod has exactly one changed plugin and no tracked file', () => {
    const { message, detail } = messageFor(
      unanswered({ plugins: ['Fixture.esp'], origin: 'ModA', metaChanged: true, oldVersion: '1.0', newVersion: '2.0' }));

    expect(message).toBe('Fixture.esp (in ModA) changed outside Modbench.');
    expect(detail).toContain('meta.ini also changed (version 1.0 → 2.0)');
  });

  it('names the mod and lists every changed plugin when more than one changed', () => {
    const { message, detail } = messageFor(unanswered({ plugins: ['A.esp', 'B.esp'], origin: 'ModA', metaChanged: false }));

    expect(message).toBe('ModA changed outside Modbench.');
    expect(detail).toContain('A.esp, B.esp');
  });

  it('names the changed tracked file when no plugin changed', () => {
    const { message, detail } = messageFor(unanswered({ plugins: [], trackedFiles: ['texture.dds'], origin: 'ModA' }));

    expect(message).toBe('ModA changed outside Modbench.');
    expect(detail).toContain('texture.dds');
  });

  it('lists both plugins and tracked files when both changed', () => {
    const { detail } = messageFor(
      unanswered({ plugins: ['Fixture.esp'], trackedFiles: ['texture.dds'], origin: 'ModA' }));

    expect(detail).toContain('Fixture.esp');
    expect(detail).toContain('texture.dds');
  });
});

describe('runExternalChangeDialogs', () => {
  it('shows exactly one modal per notification', async () => {
    const items = [unanswered({ plugins: ['A.esp', 'B.esp'], origin: 'ModA', metaChanged: true })];
    const show = vi.fn().mockResolvedValue(ABSORB_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      'ModA changed outside Modbench.',
      { modal: true, detail: expect.stringContaining('A.esp, B.esp') },
      ABSORB_BUTTON, KEEP_BUTTON,
    );
    expect(outcomes).toEqual([{ change: items[0], answer: 'absorb' }]);
  });

  it('shows one modal per distinct notification, in default-order buttons, mapping each answer independently', async () => {
    const items = [
      unanswered({ plugins: ['A.esp'], origin: 'ModA', metaChanged: true }),
      unanswered({ plugins: ['X.esp'], origin: 'ModB', metaChanged: false }),
    ];
    const show = vi.fn()
      .mockResolvedValueOnce(ABSORB_BUTTON)
      .mockResolvedValueOnce(KEEP_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { change: items[0], answer: 'absorb' },
      { change: items[1], answer: 'keep' },
    ]);
    expect(show).toHaveBeenNthCalledWith(1,
      'A.esp (in ModA) changed outside Modbench.',
      { modal: true, detail: expect.stringContaining('meta.ini also changed') },
      ABSORB_BUTTON, KEEP_BUTTON);
    expect(show).toHaveBeenNthCalledWith(2,
      'X.esp (in ModB) changed outside Modbench.',
      { modal: true, detail: expect.any(String) },
      KEEP_BUTTON, ABSORB_BUTTON);
  });

  it('answers defer on Esc/dismiss (an undefined choice)', async () => {
    const items = [unanswered({ origin: 'ModA' }), unanswered({ origin: 'ModB' })];
    const show = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(outcomes).toEqual([
      { change: items[0], answer: 'defer' },
      { change: items[1], answer: 'defer' },
    ]);
  });

  it('shows dialogs sequentially — the second mod is not requested until the first resolves', async () => {
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

    const items = [unanswered({ origin: 'ModA' }), unanswered({ origin: 'ModB' })];
    const run = runExternalChangeDialogs(items, show);

    await Promise.resolve(); // let the first show() call happen
    expect(order).toEqual(['show-1']); // second must not have been requested yet

    resolveFirst(ABSORB_BUTTON);
    await run;

    expect(order).toEqual(['show-1', 'show-2']);
  });

  it('never queues a mega-dialog: exactly one showWarningMessage call per notification, regardless of how many plugins changed inside it', async () => {
    const items = [unanswered({ plugins: ['A.esp', 'B.esp', 'C.esp'], origin: 'ModA' })];
    const show = vi.fn().mockResolvedValue(KEEP_BUTTON);

    await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
  });
});
