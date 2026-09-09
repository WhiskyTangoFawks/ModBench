import { describe, it, expect, vi } from 'vitest';
import { exitEditing, clearTreeWhenBackendDies, refreshMatchingPlugins, say } from '../editingTeardown';

// The three writers that clear loadOrderSync's record-filter match map — exitEditing, the
// backend-death listener, and refreshMatchingPlugins' failure path — have no other unit seam:
// dropping any of the writes leaves the integration suite green.

function makeSession(facts: { name: string; hasMatchingRecords: boolean }[] = []) {
  return {
    loadOrderSync: { abandon: vi.fn(), setMatches: vi.fn() },
    pluginsTree: { clear: vi.fn(), refreshFacts: vi.fn().mockResolvedValue(facts) },
    pluginsTreeView: { message: 'loading…' as string | undefined },
    pluginsNameFilter: { refresh: vi.fn() },
    backendManager: { isHealthy: false, on: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
    setFilterActive: vi.fn(),
    loadDiagnostics: { clear: vi.fn() },
    notificationSubscriber: { stop: vi.fn() },
  };
}

describe('exitEditing', () => {
  // The tree's own `clear()` is what takes the chevrons, every badge, and the record rows'
  // immutable and tracked sets; this asserts the writers only this module owns.
  it('clears every statement about the departing backend: match map, tree, message, filter UI', () => {
    const session = makeSession();

    exitEditing(session);

    expect(session.loadOrderSync.abandon).toHaveBeenCalled();
    expect(session.pluginsTree.clear).toHaveBeenCalled();
    expect(session.pluginsTreeView.message).toBeUndefined();
    expect(session.setFilterActive).toHaveBeenCalledWith(false);
    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
    expect(session.backendManager.stop).toHaveBeenCalled();
    expect(session.loadDiagnostics.clear).toHaveBeenCalled();
  });

  it('tolerates a session whose fields were never built', () => {
    expect(() => exitEditing({})).not.toThrow();
  });
});

describe('clearTreeWhenBackendDies', () => {
  function wire(isHealthy: boolean) {
    const session = makeSession();
    session.backendManager.isHealthy = isHealthy;
    const tree = { clear: vi.fn() };
    clearTreeWhenBackendDies(session, tree);
    const statusListener = session.backendManager.on.mock.calls[0][1] as () => void;
    return { session, tree, statusListener };
  }

  it('an unhealthy status clears the tree, the match map and the diagnoses together', () => {
    const { session, tree, statusListener } = wire(false);

    statusListener();

    expect(tree.clear).toHaveBeenCalled();
    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
    expect(session.loadDiagnostics.clear).toHaveBeenCalled();
    expect(session.notificationSubscriber.stop).toHaveBeenCalled();
  });

  it('a healthy status clears nothing', () => {
    const { session, tree, statusListener } = wire(true);

    statusListener();

    expect(tree.clear).not.toHaveBeenCalled();
    expect(session.loadOrderSync.setMatches).not.toHaveBeenCalled();
    expect(session.notificationSubscriber.stop).not.toHaveBeenCalled();
  });
});

describe('refreshMatchingPlugins', () => {
  const channel = () => ({ error: vi.fn() });

  it('re-derives the match map, lowercased, from the tree own re-read', async () => {
    const session = makeSession([
      { name: 'Alpha.esp', hasMatchingRecords: true },
      { name: 'Beta.esp', hasMatchingRecords: false },
    ]);
    const ch = channel();

    await refreshMatchingPlugins(session, ch);

    expect(session.pluginsTree.refreshFacts).toHaveBeenCalled();
    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(
      new Map([['alpha.esp', true], ['beta.esp', false]]),
    );
    expect(ch.error).not.toHaveBeenCalled();
  });

  it('a failed read degrades to "no data" — matches everywhere — rather than freezing stale matches', async () => {
    const session = makeSession();
    session.pluginsTree.refreshFacts.mockResolvedValue(undefined);
    const ch = channel();

    await refreshMatchingPlugins(session, ch);

    expect(session.loadOrderSync.setMatches).toHaveBeenCalledWith(undefined);
    // ADR-0026: the read failed, so it reads as an error, not as a routine info line.
    expect(ch.error).toHaveBeenCalledTimes(1);
  });

  it('a workspace with no tree is not a failure, and reports none', async () => {
    const ch = channel();

    await refreshMatchingPlugins({}, ch);

    expect(ch.error).not.toHaveBeenCalled();
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
