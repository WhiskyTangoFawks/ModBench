import { describe, it, expect, vi } from 'vitest';
import {
  buttonsInDefaultOrder, messageFor, groupByOrigin, runExternalChangeDialogs, ABSORB_BUTTON, KEEP_BUTTON,
} from '../externalChangeDialog';
import type { PendingExternalChange } from '../ApiClient';

function pending(overrides: Partial<PendingExternalChange> = {}): PendingExternalChange {
  return {
    plugin: 'Fixture.esp', origin: 'ModA', metaChanged: false, oldVersion: null, newVersion: null,
    ...overrides,
  };
}

describe('groupByOrigin', () => {
  it('groups plugins sharing one origin into a single repo group', () => {
    const groups = groupByOrigin([pending({ plugin: 'A.esp', origin: 'ModA' }), pending({ plugin: 'B.esp', origin: 'ModA' })]);

    expect(groups).toHaveLength(1);
    expect(groups[0].origin).toBe('ModA');
    expect(groups[0].items.map((i) => i.plugin)).toEqual(['A.esp', 'B.esp']);
  });

  it('keeps two different origins as two groups, in first-seen order', () => {
    const groups = groupByOrigin([
      pending({ plugin: 'A.esp', origin: 'ModA' }),
      pending({ plugin: 'X.esp', origin: 'ModB' }),
      pending({ plugin: 'B.esp', origin: 'ModA' }),
    ]);

    expect(groups.map((g) => g.origin)).toEqual(['ModA', 'ModB']);
    expect(groups[0].items.map((i) => i.plugin)).toEqual(['A.esp', 'B.esp']);
    expect(groups[1].items.map((i) => i.plugin)).toEqual(['X.esp']);
  });
});

// #417 orchestrator addition 1 + review fix 1: button ORDER carries the default, one default per
// REPO (not per plugin) — a test asserts the exact button arrays for both classifier outcomes.
describe('buttonsInDefaultOrder', () => {
  it('leads with Absorb Upstream Update when the meta tell fired', () => {
    const group = groupByOrigin([pending({ metaChanged: true })])[0];
    expect(buttonsInDefaultOrder(group)).toEqual([ABSORB_BUTTON, KEEP_BUTTON]);
  });

  it('leads with Keep as My Edit when meta is unchanged', () => {
    const group = groupByOrigin([pending({ metaChanged: false })])[0];
    expect(buttonsInDefaultOrder(group)).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('leads with Keep as My Edit when there is no meta trailer at all (also metaChanged: false on the wire)', () => {
    const group = groupByOrigin([pending({ metaChanged: false, oldVersion: null })])[0];
    expect(buttonsInDefaultOrder(group)).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });

  it('both buttons are always present, in either order', () => {
    for (const metaChanged of [true, false]) {
      const group = groupByOrigin([pending({ metaChanged })])[0];
      const buttons = buttonsInDefaultOrder(group);
      expect(buttons).toContain(ABSORB_BUTTON);
      expect(buttons).toContain(KEEP_BUTTON);
    }
  });

  // Review fix 1: "if per-plugin verdicts could ever disagree on MetaChanged, take Absorb-first
  // only when the meta changed, else Keep-first" — the disjunction across the group, not a
  // first-item read.
  it('leads with Absorb when only one of several plugins in the repo shows the meta tell', () => {
    const group = groupByOrigin([
      pending({ plugin: 'A.esp', metaChanged: false }),
      pending({ plugin: 'B.esp', metaChanged: true }),
    ])[0];
    expect(buttonsInDefaultOrder(group)).toEqual([ABSORB_BUTTON, KEEP_BUTTON]);
  });

  it('leads with Keep only when every plugin in the repo agrees meta is unchanged', () => {
    const group = groupByOrigin([
      pending({ plugin: 'A.esp', metaChanged: false }),
      pending({ plugin: 'B.esp', metaChanged: false }),
    ])[0];
    expect(buttonsInDefaultOrder(group)).toEqual([KEEP_BUTTON, ABSORB_BUTTON]);
  });
});

describe('messageFor', () => {
  it('keeps the pinned single-plugin wording when the repo has exactly one changed plugin', () => {
    const group = groupByOrigin([pending({ plugin: 'Fixture.esp', origin: 'ModA', metaChanged: true, oldVersion: '1.0', newVersion: '2.0' })])[0];

    const { message, detail } = messageFor(group);

    expect(message).toBe('Fixture.esp (in ModA) changed outside Modbench.');
    expect(detail).toContain('meta.ini also changed (version 1.0 → 2.0)');
  });

  it('names the repo and lists every changed plugin when the repo has more than one', () => {
    const group = groupByOrigin([
      pending({ plugin: 'A.esp', origin: 'ModA', metaChanged: false }),
      pending({ plugin: 'B.esp', origin: 'ModA', metaChanged: false }),
    ])[0];

    const { message, detail } = messageFor(group);

    expect(message).toBe('ModA changed outside Modbench.');
    expect(detail).toContain('A.esp, B.esp');
  });
});

describe('runExternalChangeDialogs', () => {
  // Review fix 1: two plugins sharing one origin must produce exactly ONE modal, not two — the
  // repo, not the plugin, is the dialog's unit.
  it('shows exactly one modal for two plugins sharing one origin, and answers both the same way', async () => {
    const items = [pending({ plugin: 'A.esp', origin: 'ModA', metaChanged: true }), pending({ plugin: 'B.esp', origin: 'ModA', metaChanged: true })];
    const show = vi.fn().mockResolvedValue(ABSORB_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      'ModA changed outside Modbench.',
      { modal: true, detail: expect.stringContaining('A.esp, B.esp') },
      ABSORB_BUTTON, KEEP_BUTTON,
    );
    expect(outcomes).toEqual([
      { pending: items[0], answer: 'absorb' },
      { pending: items[1], answer: 'absorb' },
    ]);
  });

  // The converse: two distinct origins still get their own modal each, queued sequentially.
  it('shows one modal per distinct origin, in default-order buttons, mapping each answer independently', async () => {
    const items = [pending({ plugin: 'A.esp', origin: 'ModA', metaChanged: true }), pending({ plugin: 'X.esp', origin: 'ModB', metaChanged: false })];
    const show = vi.fn()
      .mockResolvedValueOnce(ABSORB_BUTTON)
      .mockResolvedValueOnce(KEEP_BUTTON);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { pending: items[0], answer: 'absorb' },
      { pending: items[1], answer: 'keep' },
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

  it('answers defer on Esc/dismiss (an undefined choice), for every plugin in the repo', async () => {
    const items = [pending({ plugin: 'A.esp' }), pending({ plugin: 'B.esp' })];
    const show = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runExternalChangeDialogs(items, show);

    expect(outcomes).toEqual([
      { pending: items[0], answer: 'defer' },
      { pending: items[1], answer: 'defer' },
    ]);
  });

  it('shows dialogs sequentially — the second repo is not requested until the first resolves', async () => {
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

    const items = [pending({ plugin: 'A.esp', origin: 'ModA' }), pending({ plugin: 'X.esp', origin: 'ModB' })];
    const run = runExternalChangeDialogs(items, show);

    await Promise.resolve(); // let the first show() call happen
    expect(order).toEqual(['show-1']); // second must not have been requested yet

    resolveFirst(ABSORB_BUTTON);
    await run;

    expect(order).toEqual(['show-1', 'show-2']);
  });

  it('never queues a mega-dialog: exactly one showWarningMessage call per affected repo, regardless of how many plugins changed inside it', async () => {
    const items = [
      pending({ plugin: 'A.esp', origin: 'ModA' }),
      pending({ plugin: 'B.esp', origin: 'ModA' }),
      pending({ plugin: 'C.esp', origin: 'ModA' }),
    ];
    const show = vi.fn().mockResolvedValue(KEEP_BUTTON);

    await runExternalChangeDialogs(items, show);

    expect(show).toHaveBeenCalledTimes(1);
  });
});
