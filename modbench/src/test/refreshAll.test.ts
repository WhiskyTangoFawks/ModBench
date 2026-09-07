import { describe, it, expect, vi } from 'vitest';
import { makeRefreshAll, type RefreshAllDeps } from '../refreshAll';

function makeDeps(over: Partial<RefreshAllDeps> = {}): RefreshAllDeps {
  return {
    rebuildIndex: vi.fn().mockResolvedValue(true),
    sendLoadOrder: vi.fn().mockResolvedValue(undefined),
    invalidateMods: vi.fn(),
    invalidatePlugins: vi.fn(),
    invalidateDownloads: vi.fn(),
    updateProfileDescription: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// ADR-0046: Refresh rebuilds the Index before it resends the load order, and re-reads mods,
// plugins and downloads after — the ordinary cold load, run again.
describe('makeRefreshAll', () => {
  it('calls rebuildIndex, then sendLoadOrder, then re-reads all three trees, in that order', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      rebuildIndex: vi.fn().mockImplementation(() => { calls.push('rebuildIndex'); return Promise.resolve(true); }),
      sendLoadOrder: vi.fn().mockImplementation(() => { calls.push('sendLoadOrder'); return Promise.resolve(undefined); }),
      invalidateMods: vi.fn().mockImplementation(() => { calls.push('invalidateMods'); }),
      invalidatePlugins: vi.fn().mockImplementation(() => { calls.push('invalidatePlugins'); }),
      invalidateDownloads: vi.fn().mockImplementation(() => { calls.push('invalidateDownloads'); }),
      updateProfileDescription: vi.fn().mockImplementation(() => { calls.push('updateProfileDescription'); return Promise.resolve(undefined); }),
    });

    await makeRefreshAll(deps)();

    expect(calls).toEqual([
      'rebuildIndex', 'sendLoadOrder', 'invalidateMods', 'invalidatePlugins', 'invalidateDownloads',
      'updateProfileDescription',
    ]);
  });

  it('sends no load order and re-reads nothing when the rebuild fails — the failure is already reported', async () => {
    const deps = makeDeps({ rebuildIndex: vi.fn().mockResolvedValue(false) });

    await makeRefreshAll(deps)();

    expect(deps.sendLoadOrder).not.toHaveBeenCalled();
    expect(deps.invalidateMods).not.toHaveBeenCalled();
    expect(deps.invalidatePlugins).not.toHaveBeenCalled();
    expect(deps.invalidateDownloads).not.toHaveBeenCalled();
    expect(deps.updateProfileDescription).not.toHaveBeenCalled();
  });
});
