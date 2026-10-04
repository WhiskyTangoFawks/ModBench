import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler } from '../loadOrderProgress';
import type { LoadOrderProgress } from '../../client';

describe('makeReconcileProgressHandler, applying a tick only when it landed something new, since applying re-renders the whole tree and re-fetches record types for an expanded row', () => {
  const status = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress =>
    ({ totalPlugins: 3, activePlugins: 3, indexedPlugins: [], conflictsComputed: false, holdsNone: false, failures: [], version: 1, ...over });

  const handler = () => {
    const applyLoadOrder = vi.fn();
    return { applyLoadOrder, onProgress: makeReconcileProgressHandler({ applyLoadOrder }) };
  };

  it('applies a tick that landed a new plugin', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }));

    expect(applyLoadOrder).toHaveBeenCalledWith([{ name: 'A.esp', origin: 'SomeMod' }], []);
  });

  it('does not re-apply a tick that landed nothing new', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }));
    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }));
    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }));

    expect(applyLoadOrder).toHaveBeenCalledTimes(1);
  });

  it('applies a tick that landed a failure even though no new plugin was indexed, since a plugin that failed to index is never added to the indexed set', () => {
    const { applyLoadOrder, onProgress } = handler();

    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }));
    onProgress(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }], failures: [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }] }));

    expect(applyLoadOrder).toHaveBeenCalledTimes(2);
    expect(applyLoadOrder).toHaveBeenLastCalledWith([{ name: 'A.esp', origin: 'SomeMod' }], [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }]);
  });
});
