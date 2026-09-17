import { describe, it, expect, vi } from 'vitest';
import {
  buttonsInDefaultOrder, messageFor, runExternalChangeDialogs, BASELINE_BUTTON, APPLY_BUTTON,
} from '../externalChangeDialog';
import type { UnansweredExternalChange } from '../../client';
import type { AskQuestion } from '../../ports/dialog';
import { present } from '../../ports/present';

function unanswered(overrides: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
  return {
    origin: 'ModA', plugins: ['Fixture.esp'], trackedFiles: [], metaChanged: false, oldVersion: null, newVersion: null,
    ...overrides,
  };
}

describe('buttonsInDefaultOrder', () => {
  it('leads with baseline when the tell fired', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: true }))).toEqual([BASELINE_BUTTON, APPLY_BUTTON]);
  });

  it('leads with apply when the tell did not fire', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: false }))).toEqual([APPLY_BUTTON, BASELINE_BUTTON]);
  });

  it('leads with apply when there is no meta trailer at all (also metaChanged: false on the wire)', () => {
    expect(buttonsInDefaultOrder(unanswered({ metaChanged: false, oldVersion: null }))).toEqual([APPLY_BUTTON, BASELINE_BUTTON]);
  });

  it('both buttons are always present, in either order', () => {
    for (const metaChanged of [true, false]) {
      const buttons = buttonsInDefaultOrder(unanswered({ metaChanged }));
      expect(buttons).toContain(BASELINE_BUTTON);
      expect(buttons).toContain(APPLY_BUTTON);
    }
  });
});

describe('messageFor', () => {
  it('message is always the mod name alone', () => {
    const { message } = messageFor(unanswered({ origin: 'ModA', plugins: ['Fixture.esp', 'Other.esp'] }));
    expect(message).toBe('ModA');
  });

  it('detail names the changed plugin when only a plugin changed (plugin-only)', () => {
    const { detail } = messageFor(unanswered({ plugins: ['Fixture.esp'], trackedFiles: [] }));

    expect(detail).toContain('Fixture.esp');
    expect(detail).not.toContain('tracked file');
  });

  it('detail names every changed plugin when more than one changed', () => {
    const { detail } = messageFor(unanswered({ plugins: ['A.esp', 'B.esp'], trackedFiles: [] }));
    expect(detail).toContain('A.esp, B.esp');
  });

  it('detail names the changed tracked files by count and name when only assets changed (asset-only)', () => {
    const { detail } = messageFor(unanswered({ plugins: [], trackedFiles: ['texture.dds', 'mesh.nif'] }));

    expect(detail).toContain('2');
    expect(detail).toContain('texture.dds');
    expect(detail).toContain('mesh.nif');
    expect(detail).not.toContain('Plugin(s)');
  });

  it('detail names both the plugins and the tracked files when both changed', () => {
    const { detail } = messageFor(unanswered({ plugins: ['Fixture.esp'], trackedFiles: ['texture.dds'] }));

    expect(detail).toContain('Fixture.esp');
    expect(detail).toContain('1');
    expect(detail).toContain('texture.dds');
  });

  it('detail states the version movement when the tell fired', () => {
    const { detail } = messageFor(unanswered({ metaChanged: true, oldVersion: '1.0', newVersion: '2.0' }));
    expect(detail).toContain('1.0');
    expect(detail).toContain('2.0');
  });

  it('detail says no version change was observed when the tell did not fire', () => {
    const { detail } = messageFor(unanswered({ metaChanged: false }));
    expect(detail).toContain('No version change was observed.');
  });
});

describe('runExternalChangeDialogs', () => {
  it('shows exactly one modal per notification, named for the mod', async () => {
    const items = [unanswered({ plugins: ['A.esp', 'B.esp'], origin: 'ModA', metaChanged: true })];
    const show = vi.fn<AskQuestion>().mockResolvedValue(BASELINE_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
    const [message, options, ...buttons] = present(show.mock.calls[0], 'the first show() call');
    expect(message).toBe('ModA');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('A.esp, B.esp');
    expect(buttons).toEqual([BASELINE_BUTTON, APPLY_BUTTON]);
    expect(outcomes).toEqual([{ change: items[0], answer: 'absorb' }]);
  });

  it('shows one modal per distinct notification, in default-order buttons, mapping each answer independently', async () => {
    const items = [
      unanswered({ plugins: ['A.esp'], origin: 'ModA', metaChanged: true }),
      unanswered({ plugins: ['X.esp'], origin: 'ModB', metaChanged: false }),
    ];
    const show = vi.fn<AskQuestion>()
      .mockResolvedValueOnce(BASELINE_BUTTON)
      .mockResolvedValueOnce(APPLY_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { change: items[0], answer: 'absorb' },
      { change: items[1], answer: 'keep' },
    ]);
    const [firstMessage, firstOptions, ...firstButtons] = present(show.mock.calls[0], 'the first show() call');
    expect(firstMessage).toBe('ModA');
    expect(firstOptions.modal).toBe(true);
    expect(firstOptions.detail).toContain('moved from');
    expect(firstButtons).toEqual([BASELINE_BUTTON, APPLY_BUTTON]);

    const [secondMessage, secondOptions, ...secondButtons] = present(show.mock.calls[1], 'the second show() call');
    expect(secondMessage).toBe('ModB');
    expect(secondOptions.modal).toBe(true);
    expect(typeof secondOptions.detail).toBe('string');
    expect(secondButtons).toEqual([APPLY_BUTTON, BASELINE_BUTTON]);
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
        return Promise.resolve(APPLY_BUTTON);
      });

    const items = [unanswered({ origin: 'ModA' }), unanswered({ origin: 'ModB' })];
    const run = runExternalChangeDialogs(items, show);

    await Promise.resolve(); // let the first show() call happen
    expect(order).toEqual(['show-1']); // second must not have been requested yet

    resolveFirst(BASELINE_BUTTON);
    await run;

    expect(order).toEqual(['show-1', 'show-2']);
  });

  it('never queues a mega-dialog: exactly one showWarningMessage call per notification, regardless of how many plugins changed inside it', async () => {
    const items = [unanswered({ plugins: ['A.esp', 'B.esp', 'C.esp'], origin: 'ModA' })];
    const show = vi.fn().mockResolvedValue(APPLY_BUTTON);

    await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
  });
});
