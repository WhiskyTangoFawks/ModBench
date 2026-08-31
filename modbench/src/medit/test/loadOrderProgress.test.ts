import { describe, it, expect, vi } from 'vitest';
import { loadOrderProgressMessage, makeReconcileProgressHandler, recordPanelIncompleteMessage } from '../loadOrderProgress';

// ADR-0035. The trap: an absent conflict badge is indistinguishable from "no
// conflict", so while the winner sweep is outstanding the view has to *say* so in as many words.
// It is gated on `conflictsComputed` alone — never on whether a load happens to be running —
// because the sweep is whole-set, and ADR-0035's live mutations will leave a finished load order
// with stale winners that nothing has re-swept.
describe('loadOrderProgressMessage', () => {
  const status = (over: Partial<Parameters<typeof loadOrderProgressMessage>[0]> = {}) =>
    ({ totalPlugins: 200, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  it('says conflict information is not yet computed while the sweep is outstanding', () => {
    const message = loadOrderProgressMessage(status({ conflictsComputed: false }));

    expect(message).toMatch(/conflict information is not yet computed/i);
  });

  it('clears once the sweep completes, so the statement disappears with no user action', () => {
    const message = loadOrderProgressMessage(status({ conflictsComputed: true }));

    expect(message).toBeUndefined();
  });

  it('names how many of how many plugins have been indexed so far', () => {
    const message = loadOrderProgressMessage(status({
      totalPlugins: 200,
      indexedPlugins: Array.from({ length: 12 }, (_, i) => `P${i}.esp`),
    }));

    expect(message).toContain('12 of 200');
  });

  // totalPlugins is known (unlike the omitted-count case below) but nothing has landed yet
  // — IndexProgressively opens and indexes one plugin at a time, and a large first master can hold
  // the count at zero for a real while. A bare "0 of 200" is indistinguishable from a stalled
  // load, so this phase has to say work is under way rather than leave a static count to imply
  // otherwise — and it must keep stating the total, which "0 of 200" already gave the user and a
  // vaguer phase message must not take back.
  it('says work is under way on the first plugin(s), not just "0 of N", while nothing has landed yet', () => {
    const message = loadOrderProgressMessage(status({ totalPlugins: 200, indexedPlugins: [] }));

    expect(message).toMatch(/opening and indexing the first/i);
    expect(message).toContain('0 of 200');
  });

  // Before the backend publishes the load order at all, `GET /load-order/status` answers
  // LoadOrderStatus.None — no plugins, and no count yet (LoadOrderManager.cs). "0 of 0 plugins
  // indexed" is a number the user would read as a stalled load rather than as one still opening
  // the load order, so the count is omitted until there is one.
  it('omits the count entirely before the load knows how many plugins there are', () => {
    const message = loadOrderProgressMessage(status({ totalPlugins: 0, indexedPlugins: [] }));

    expect(message).not.toContain('0');
    expect(message).toMatch(/conflict information is not yet computed/i);
  });
});

// ADR-0035: the record panel's own statement — same trap as loadOrderProgressMessage above
// (an absent conflict badge is indistinguishable from "no conflict"), but this surface *does*
// render conflict colouring today, so the statement has to name both facts: the comparison itself
// is incomplete, and the colouring it renders is not final because of that. Gated on
// `conflictsComputed` alone, same reasoning as loadOrderProgressMessage.
describe('recordPanelIncompleteMessage', () => {
  it('states both that the comparison is incomplete and that colouring is not final while the sweep is outstanding', () => {
    const message = recordPanelIncompleteMessage(false);

    expect(message).toMatch(/comparison.*not.*complete/i);
    expect(message).toMatch(/colouring.*not final/i);
  });

  // An exact-string test, not just a substring/vocabulary check, so a future
  // reword is a deliberate, reviewed choice rather than a silent drift.
  it('is exactly the reviewed wording', () => {
    expect(recordPanelIncompleteMessage(false)).toBe(
      'This record\'s comparison is not yet complete: conflict information has not been computed '
      + 'for every plugin, so the colouring here is not final.',
    );
  });

  it('clears once the sweep completes, so the statement disappears with no user action', () => {
    expect(recordPanelIncompleteMessage(true)).toBeUndefined();
  });

  // Never Mod Management's vocabulary ("mod") as a common noun — this surface's own boundary
  // (medit-record-editor.md: the Editing context operates on records, FormKeys and plugins).
  it('never uses "mod" as a common noun', () => {
    expect(recordPanelIncompleteMessage(false)).not.toMatch(/\bmod\b/i);
  });
});

// One poll tick, translated into what the tree and the view should do about it. The guard
// this pins is not cosmetic: applying a tick re-renders the whole tree, and
// PluginTreeProvider.getPluginChildren is uncached, so re-applying an unchanged tick every 500ms
// would re-fetch record types for every expanded row — a request storm on a deep tree, for no
// visible change.
describe('makeReconcileProgressHandler', () => {
  const status = (over: Partial<Parameters<typeof loadOrderProgressMessage>[0]> = {}) =>
    ({ totalPlugins: 3, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  const handler = () => {
    const applyLoadOrder = vi.fn();
    const say = vi.fn();
    return { applyLoadOrder, say, onProgress: makeReconcileProgressHandler({ say, applyLoadOrder }) };
  };

  it('applies a tick that landed a new plugin', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: ['A.esp'] }));

    expect(applyLoadOrder).toHaveBeenCalledWith(['A.esp'], []);
  });

  it('does not re-apply a tick that landed nothing new', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: ['A.esp'] }));
    onProgress(status({ indexedPlugins: ['A.esp'] }));
    onProgress(status({ indexedPlugins: ['A.esp'] }));

    expect(applyLoadOrder).toHaveBeenCalledTimes(1);
  });

  // A failure can arrive without the indexed set growing at all — a plugin that failed to
  // index is never added to it. Counting only plugins would leave that row undecorated until the
  // next plugin happened to land, or until the load finished.
  it('applies a tick that landed a failure even though no new plugin was indexed', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: ['A.esp'] }));
    onProgress(status({ indexedPlugins: ['A.esp'], failures: [{ name: 'B.esp', reason: 'RACE parse' }] }));

    expect(applyLoadOrder).toHaveBeenCalledTimes(2);
    expect(applyLoadOrder).toHaveBeenLastCalledWith(['A.esp'], [{ name: 'B.esp', reason: 'RACE parse' }]);
  });

  // The statement is not behind the guard: its plugin count moves on ticks that land nothing
  // worth a re-render, and a stale count reads as a stalled load.
  it('refreshes the view\'s statement on every tick, including ones it does not apply', () => {
    const { say, onProgress } = handler();

    onProgress(status({ indexedPlugins: ['A.esp'] }));
    onProgress(status({ indexedPlugins: ['A.esp'] }));

    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith(expect.stringContaining('not yet computed'));
  });
});
