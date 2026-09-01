import { describe, it, expect, vi } from 'vitest';
import { exitToLoadout, clearTreeWhenBackendDies, refreshMatchingPlugins, say } from '../loadoutTeardown';

// #650 (folded into #628): the three writers that clear loadOrderSync's record-filter match
// map — exitToLoadout, the backend-death listener, and refreshMatchingPlugins' error path —
// previously lived inline in extension.ts with no unit seam: dropping any of the writes left
// the integration suite green. These tests are that seam.

function makeSession() {
  return {
    loadOrderSync: { abandon: vi.fn(), setMatches: vi.fn() },
    pluginsTree: { setLoadOrder: vi.fn(), refreshDecorations: vi.fn() },
    pluginsTreeView: { message: 'loading…' as string | undefined },
    pluginsNameFilter: { refresh: vi.fn() },
    recordBrowserProvider: { setImmutablePlugins: vi.fn() },
    backendManager: { isHealthy: false, on: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
    setFilterActive: vi.fn(),
  };
}

describe('exitToLoadout', () => {
  it('clears every statement about the departing backend: match map, chevrons, message, filter UI, immutable set', () => {
    const session = makeSession();

    exitToLoadout(session);

    expect(session.loadOrderSync.abandon).toHaveBeenCalled();
    expect(session.pluginsTree.setLoadOrder).toHaveBeenCalledWith(undefined);
    expect(session.pluginsTreeView.message).toBeUndefined();
    expect(session.setFilterActive).toHaveBeenCalledWith(false);
    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
    expect(session.recordBrowserProvider.setImmutablePlugins).toHaveBeenCalledWith([]);
    expect(session.backendManager.stop).toHaveBeenCalled();
  });

  it('tolerates a session whose fields were never built', () => {
    expect(() => exitToLoadout({})).not.toThrow();
  });
});

describe('clearTreeWhenBackendDies', () => {
  function wire(isHealthy: boolean) {
    const session = makeSession();
    session.backendManager.isHealthy = isHealthy;
    const composite = { setLoadOrder: vi.fn() };
    const recordBrowser = { setImmutablePlugins: vi.fn() };
    clearTreeWhenBackendDies(session, composite, recordBrowser);
    const statusListener = session.backendManager.on.mock.calls[0][1] as () => void;
    return { session, composite, recordBrowser, statusListener };
  }

  it('an unhealthy status clears the chevrons, the immutable set, and the match map together', () => {
    const { session, composite, recordBrowser, statusListener } = wire(false);

    statusListener();

    expect(composite.setLoadOrder).toHaveBeenCalledWith(undefined);
    expect(recordBrowser.setImmutablePlugins).toHaveBeenCalledWith([]);
    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
  });

  it('a healthy status clears nothing', () => {
    const { session, composite, recordBrowser, statusListener } = wire(true);

    statusListener();

    expect(composite.setLoadOrder).not.toHaveBeenCalled();
    expect(recordBrowser.setImmutablePlugins).not.toHaveBeenCalled();
    expect(session.loadOrderSync.setMatches).not.toHaveBeenCalled();
  });
});

describe('refreshMatchingPlugins', () => {
  const channel = () => ({ error: vi.fn() });

  it('re-derives the match map (lowercased, load-order copies only) and re-renders', async () => {
    const session = makeSession();
    const repository = {
      getPlugins: vi.fn().mockResolvedValue([
        { name: 'Alpha.esp', inLoadOrder: true, hasMatchingRecords: true },
        { name: 'Shadowed.esp', inLoadOrder: false, hasMatchingRecords: true },
        { name: 'Beta.esp', inLoadOrder: true, hasMatchingRecords: false },
      ]),
    };

    await refreshMatchingPlugins(session, repository, channel());

    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(
      new Map([['alpha.esp', true], ['beta.esp', false]]),
    );
    expect(session.pluginsTree.refreshDecorations).toHaveBeenCalled();
  });

  it('a failed read degrades to "no data" — matches everywhere — rather than freezing stale matches', async () => {
    const session = makeSession();
    const repository = { getPlugins: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const ch = channel();

    await refreshMatchingPlugins(session, repository, ch);

    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
    expect(ch.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(session.pluginsTree.refreshDecorations).toHaveBeenCalled();
  });
});

describe('say', () => {
  it('a cleared message hands the readout back to the name filter', () => {
    const session = makeSession();
    say(session, undefined);
    expect(session.pluginsTreeView.message).toBeUndefined();
    expect(session.pluginsNameFilter.refresh).toHaveBeenCalled();
  });

  it('a live message takes the readout without poking the filter', () => {
    const session = makeSession();
    say(session, 'Indexing 3/100…');
    expect(session.pluginsTreeView.message).toBe('Indexing 3/100…');
    expect(session.pluginsNameFilter.refresh).not.toHaveBeenCalled();
  });
});
