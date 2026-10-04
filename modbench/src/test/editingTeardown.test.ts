import { describe, it, expect, vi } from 'vitest';
import { exitEditing, refreshMatchingPlugins, say } from '../editingTeardown';

function makeSession(facts: { name: string; hasMatchingRecords: boolean }[] = []) {
  return {
    loadOrderSender: { abandon: vi.fn() },
    plugins: {
      tree: { refreshFacts: vi.fn().mockResolvedValue(facts) },
      view: { message: 'loading…' as string | undefined },
      nameFilter: { refresh: vi.fn() },
    },
  };
}

const makeClient = () => ({ stop: vi.fn().mockResolvedValue(undefined) });

describe('exitEditing', () => {
  it('abandons the reconcile before stopping the backend it was talking to', () => {
    const session = makeSession();
    const client = makeClient();

    exitEditing(session, client);

    expect(session.loadOrderSender.abandon).toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
  });

  it('takes nothing away from the views', () => {
    const session = makeSession();

    exitEditing(session, makeClient());

    expect(session.plugins.view.message).toBe('loading…');
    expect(session.plugins.nameFilter.refresh).not.toHaveBeenCalled();
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

    expect(session.plugins.tree.refreshFacts).toHaveBeenCalled();
  });

  it('a workspace with no tree reads nothing', async () => {
    await expect(refreshMatchingPlugins({})).resolves.toBeUndefined();
  });
});

describe('say', () => {
  it('a cleared message hands the readout back to the name filter', () => {
    const session = makeSession();
    say(session, undefined);
    expect(session.plugins.view.message).toBeUndefined();
    expect(session.plugins.nameFilter.refresh).toHaveBeenCalled();
  });

  it('a live message takes the readout without poking the filter', () => {
    const session = makeSession();
    say(session, 'Indexing 3/100…');
    expect(session.plugins.view.message).toBe('Indexing 3/100…');
    expect(session.plugins.nameFilter.refresh).not.toHaveBeenCalled();
  });
});
