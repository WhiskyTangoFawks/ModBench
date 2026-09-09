import { describe, it, expect, vi } from 'vitest';
import { exitEditing, clearTreeWhenBackendDies, refreshMatchingPlugins, say } from '../editingTeardown';

function makeSession(facts: { name: string; hasMatchingRecords: boolean }[] = []) {
  return {
    loadOrderSync: { abandon: vi.fn() },
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
  it('clears every statement about the departing backend: tree, message, filter UI', () => {
    const session = makeSession();

    exitEditing(session);

    expect(session.loadOrderSync.abandon).toHaveBeenCalled();
    expect(session.pluginsTree.clear).toHaveBeenCalled();
    expect(session.pluginsTreeView.message).toBeUndefined();
    expect(session.setFilterActive).toHaveBeenCalledWith(false);
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

  it('an unhealthy status clears the tree and the diagnoses together', () => {
    const { session, tree, statusListener } = wire(false);

    statusListener();

    expect(tree.clear).toHaveBeenCalled();
    expect(session.loadDiagnostics.clear).toHaveBeenCalled();
    expect(session.notificationSubscriber.stop).toHaveBeenCalled();
  });

  it('a healthy status clears nothing', () => {
    const { session, tree, statusListener } = wire(true);

    statusListener();

    expect(tree.clear).not.toHaveBeenCalled();
    expect(session.notificationSubscriber.stop).not.toHaveBeenCalled();
  });
});

describe('refreshMatchingPlugins', () => {
  it('re-reads the tree\'s own plugin facts', async () => {
    const session = makeSession([
      { name: 'Alpha.esp', hasMatchingRecords: true },
      { name: 'Beta.esp', hasMatchingRecords: false },
    ]);

    await refreshMatchingPlugins(session);

    expect(session.pluginsTree.refreshFacts).toHaveBeenCalled();
  });

  // A missing tree is no load order to describe, so nothing is read.
  it('a workspace with no tree reads nothing', async () => {
    await expect(refreshMatchingPlugins({})).resolves.toBeUndefined();
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
