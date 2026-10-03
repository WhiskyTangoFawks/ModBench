import { describe, it, expect, vi } from 'vitest';
import { makeReconcileProgressHandler, reportIndexRefusal } from '../loadOrderProgress';
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

describe('reportIndexRefusal, where a refusal reaches the extension since the put\'s own outcome answers applied regardless of what the Index found', () => {
  const status = (over: Partial<LoadOrderProgress> = {}): LoadOrderProgress =>
    ({ totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: false, holdsNone: false, failures: [], version: 1, ...over });

  it('shows the ready-to-show message on the status bar, held-elsewhere', () => {
    const setStatusText = vi.fn();

    const refused = reportIndexRefusal(
      status({ refusal: { kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' } }),
      { setStatusText },
    );

    expect(setStatusText).toHaveBeenCalledWith(
      '$(error) mEdit: This instance\'s index is open in another Modbench window.',
    );
    expect(refused).toBe(true);
  });

  it('shows the ready-to-show message on the status bar, an unknown failure', () => {
    const setStatusText = vi.fn();

    reportIndexRefusal(status({ refusal: { kind: 'failed', message: 'the reconcile threw something unexpected' } }), { setStatusText });

    expect(setStatusText).toHaveBeenCalledWith('$(error) mEdit: the reconcile threw something unexpected');
  });

  it('shows nothing, and answers false, for an ordinary tick with no refusal message', () => {
    const setStatusText = vi.fn();

    const refused = reportIndexRefusal(status({ indexedPlugins: [{ name: 'A.esp', origin: 'SomeMod' }] }), { setStatusText });

    expect(setStatusText).not.toHaveBeenCalled();
    expect(refused).toBe(false);
  });
});
