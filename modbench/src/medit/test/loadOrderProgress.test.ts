import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler } from '../loadOrderProgress';
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
