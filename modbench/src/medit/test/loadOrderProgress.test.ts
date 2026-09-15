import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler, reportIndexHeldElsewhere } from '../loadOrderProgress';
import type { LoadOrderProgress } from '../client';

// Applying a tick re-renders the whole tree, and PluginTreeProvider.getPluginChildren is
// uncached, so re-applying an unchanged tick every 500ms would re-fetch record types for every
// expanded row — a request storm for no visible change.
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

  // A failure can arrive without the indexed set growing — a plugin that failed to index is never
  // added to it, so counting only plugins would leave that row undecorated until the load ended.
  it('applies a tick that landed a failure even though no new plugin was indexed', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: ['A.esp'] }));
    onProgress(status({ indexedPlugins: ['A.esp'], failures: [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }] }));

    expect(applyLoadOrder).toHaveBeenCalledTimes(2);
    expect(applyLoadOrder).toHaveBeenLastCalledWith(['A.esp'], [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }]);
  });
});

// ADR-0009 point 5: the put's own outcome reports applied regardless of what the Index found, so
// a tick carrying the refusal is the only place "another window has this instance open" is seen.
describe('reportIndexHeldElsewhere', () => {
  const status = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress =>
    ({ totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  it('shows the ready-to-show message verbatim, prefixed exactly as a failed send is', () => {
    const error = vi.fn();

    reportIndexHeldElsewhere(
      status({ heldElsewhereMessage: 'This instance\'s index is open in another Modbench window.' }),
      { error },
    );

    expect(error).toHaveBeenCalledWith(
      'mEdit: Failed to send the load order — This instance\'s index is open in another Modbench window.',
    );
  });

  // The rival: showing it on every ordinary tick, not only the one carrying the refusal.
  it('shows nothing for a tick with no held-elsewhere message', () => {
    const error = vi.fn();

    reportIndexHeldElsewhere(status({ indexedPlugins: ['A.esp'] }), { error });

    expect(error).not.toHaveBeenCalled();
  });
});
