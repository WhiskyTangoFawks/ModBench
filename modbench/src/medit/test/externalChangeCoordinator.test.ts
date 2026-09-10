import { describe, it, expect, vi } from 'vitest';
import {
  subscribeExternalChangePending,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { BASELINE_BUTTON, APPLY_BUTTON } from '../../plugins/externalChangeDialog';
import { InMemoryMEditClient, type NotificationEvent } from '../client';

function pendingEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'external-change-pending', plugin: '', origin: 'ModA', keys: ['Fixture.esp'], sequence: 0,
    externalChangeMetaChanged: false, externalChangeOldVersion: null, externalChangeNewVersion: null,
    externalChangeTrackedFiles: [],
    ...overrides,
  };
}

// Every test's own `client` scripts `keepAsMyEdit`/`absorbUpstreamUpdate`/`rebaseOntoMain`
// before this runs; a call the test never scripted rejects loudly (InMemoryMEditClient's own
// contract), so a forgotten script fails the test rather than silently no-oping.
function makeDeps(
  client: InMemoryMEditClient, overrides: Partial<Omit<ExternalChangeCoordinatorDeps, 'client'>> = {},
): ExternalChangeCoordinatorDeps {
  return {
    client,
    showDialog: vi.fn().mockResolvedValue(APPLY_BUTTON),
    openMergeEditor: vi.fn().mockResolvedValue(undefined),
    showError: vi.fn(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
    ...overrides,
  };
}

function clientScriptedForKeepAndAbsorb(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setCommandResult('keepAsMyEdit', { succeeded: true, refusalReason: null });
  client.setCommandResult('absorbUpstreamUpdate', {
    succeeded: true, refusalReason: null, rebase: { outcome: 'Clean', refusalReason: null, conflictedPaths: [] },
  });
  return client;
}

// Flushes the microtask queue: the subscriber's listener dispatches `handleUnanswered`
// fire-and-forget, so a test awaits one tick past `emit` before asserting its effects.
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('subscribeExternalChangePending', () => {
  it('does nothing until a notification arrives', () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    subscribeExternalChangePending(deps, client);

    expect(deps.showDialog).not.toHaveBeenCalled();
  });

  it('runs the dialog and dispatches Apply to working tree', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(APPLY_BUTTON) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'keepAsMyEdit', args: ['ModA'] });
    expect(client.calls.map((c) => c.method)).not.toContain('absorbUpstreamUpdate');
  });

  it('dispatches Absorb; a clean rebase is silent', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'absorbUpstreamUpdate', args: ['ModA'] });
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  // Absorb's own rebase runs server-side; a conflict is the extension's cue to open the native
  // merge editor, same as the manual rebase command.
  it('dispatches Absorb; a conflicted rebase opens the merge editor on every path', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('keepAsMyEdit', { succeeded: true, refusalReason: null });
    client.setCommandResult('absorbUpstreamUpdate', {
      succeeded: true, refusalReason: null,
      rebase: { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Fixture.esp/x.json'] },
    });
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/Fixture.esp/x.json');
  });

  it('a deferred (Esc) answer calls neither absorb nor keep', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(undefined) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    // `subscribe` itself is the one call `subscribeExternalChangePending` makes up front;
    // a deferred answer dispatches neither Keep nor Absorb on top of it.
    expect(client.calls.filter((c) => c.method !== 'subscribe')).toEqual([]);
  });

  it('a failed Absorb never opens the merge editor', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', undefined); // transport failure
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  it('a refused Absorb never opens the merge editor', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', { succeeded: false, refusalReason: 'Fixture.esp could not be parsed.' });
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    // The client has already surfaced the reason; nothing landed, so there is no new baseline
    // to rebase onto.
    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  it('a rejected dispatch logs rather than throwing', async () => {
    const log = vi.fn();
    const client = new InMemoryMEditClient();
    client.setCommandResult('keepAsMyEdit', Promise.reject(new Error('backend down')) as never);
    const deps = makeDeps(client, { log });
    subscribeExternalChangePending(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));
  });

  it('reports nothing further once unsubscribed', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    const unsubscribe = subscribeExternalChangePending(deps, client);
    unsubscribe();

    client.emit(pendingEvent());
    await flush();

    expect(deps.showDialog).not.toHaveBeenCalled();
  });
});
