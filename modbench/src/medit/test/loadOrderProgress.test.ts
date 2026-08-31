import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler, recordPanelIncompleteMessage } from '../loadOrderProgress';
import type { LoadOrderProgress } from '../EditingController';

// ADR-0035: the record panel's own statement — an absent conflict badge is
// indistinguishable from "no conflict", and this surface *does* render conflict colouring today,
// so the statement has to name both facts: the comparison itself is incomplete, and the colouring
// it renders is not final because of that. Gated on `conflictsComputed` alone — the sweep is
// whole-set, so a reconcile that changes anything (ADR-0044) leaves a *Ready* load order with
// stale winners until it re-runs.
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

// One poll tick, translated into what the tree should do about it. The guard
// this pins is not cosmetic: applying a tick re-renders the whole tree, and
// PluginTreeProvider.getPluginChildren is uncached, so re-applying an unchanged tick every 500ms
// would re-fetch record types for every expanded row — a request storm on a deep tree, for no
// visible change.
describe('makeReconcileProgressHandler', () => {
  const status = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress =>
    ({ totalPlugins: 3, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  const handler = () => {
    const applyLoadOrder = vi.fn();
    return { applyLoadOrder, onProgress: makeReconcileProgressHandler({ applyLoadOrder }) };
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
});
