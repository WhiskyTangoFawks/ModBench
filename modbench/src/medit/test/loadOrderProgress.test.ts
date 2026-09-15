import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler, reportIndexRefusal } from '../loadOrderProgress';
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

// ADR-0009 point 5; ADR-0019: the put's own outcome answers applied regardless of what the Index
// found, so a tick carrying either refusal is the only place it ever reaches the extension.
describe('reportIndexRefusal', () => {
  const status = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress =>
    ({ totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  it('shows the ready-to-show message on the status bar, held-elsewhere', () => {
    const setStatusText = vi.fn();

    const refused = reportIndexRefusal(
      status({ refusalMessage: 'This instance\'s index is open in another Modbench window.' }),
      { setStatusText },
    );

    expect(setStatusText).toHaveBeenCalledWith(
      '$(error) mEdit: This instance\'s index is open in another Modbench window.',
    );
    expect(refused).toBe(true);
  });

  it('shows the ready-to-show message on the status bar, an unknown failure', () => {
    const setStatusText = vi.fn();

    reportIndexRefusal(status({ refusalMessage: 'the reconcile threw something unexpected' }), { setStatusText });

    expect(setStatusText).toHaveBeenCalledWith('$(error) mEdit: the reconcile threw something unexpected');
  });

  // The rival: showing it on every ordinary tick, not only the one carrying a refusal.
  it('shows nothing, and answers false, for a tick with no refusal message', () => {
    const setStatusText = vi.fn();

    const refused = reportIndexRefusal(status({ indexedPlugins: ['A.esp'] }), { setStatusText });

    expect(setStatusText).not.toHaveBeenCalled();
    expect(refused).toBe(false);
  });
});
