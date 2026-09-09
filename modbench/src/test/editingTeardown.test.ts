import { describe, it, expect, vi } from 'vitest';
import { exitEditing, refreshMatchingPlugins, say } from '../editingTeardown';

function makeSession(facts: { name: string; hasMatchingRecords: boolean }[] = []) {
  return {
    loadOrderSync: { abandon: vi.fn() },
    pluginsTree: { refreshFacts: vi.fn().mockResolvedValue(facts) },
    pluginsTreeView: { message: 'loading…' as string | undefined },
    pluginsNameFilter: { refresh: vi.fn() },
  };
}

const makeClient = () => ({ stop: vi.fn().mockResolvedValue(undefined) });

describe('exitEditing', () => {
  it('abandons the reconcile before stopping the backend it was talking to', () => {
    const session = makeSession();
    const client = makeClient();

    exitEditing(session, client);

    expect(session.loadOrderSync.abandon).toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
  });

  // The views keep their shape across a backend that goes: the rows stay and expand into an
  // error node, and the reconcile that replaces the diagnoses does so wholesale.
  it('takes nothing away from the views', () => {
    const session = makeSession();

    exitEditing(session, makeClient());

    expect(session.pluginsTreeView.message).toBe('loading…');
    expect(session.pluginsNameFilter.refresh).not.toHaveBeenCalled();
  });

  it('tolerates a session whose fields were never built', () => {
    expect(() => exitEditing({}, makeClient())).not.toThrow();
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
