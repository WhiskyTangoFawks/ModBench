import { describe, it, expect, vi } from 'vitest';
import {
  subscribeExternalChangePending,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { ABSORB_BUTTON, KEEP_BUTTON } from '../../plugins/externalChangeDialog';
import { rebaseOfferMessage, REBASE_NOW_BUTTON, REBASE_LATER_BUTTON } from '../../plugins/externalChangeGestures';
import type { NotificationEvent } from '../ApiClient';
import { FakeNotificationSubscriber } from '../NotificationSubscriber';
import { InMemoryMEditClient } from '../client';

function pendingEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'external-change-pending', plugin: 'Fixture.esp', origin: 'ModA', keys: [], sequence: 0,
    externalChangeMetaChanged: false, externalChangeOldVersion: null, externalChangeNewVersion: null,
    ...overrides,
  };
}

// Every test's own `client` scripts `keepAsMyEdit`/`absorbUpstreamUpdate`/`rebaseOntoMain`
// before this runs; a call the test never scripted rejects loudly (InMemoryMEditClient's own
// contract), so a forgotten script fails the test rather than silently no-oping.
function makeDeps(
  client: InMemoryMEditClient, overrides: Partial<Omit<ExternalChangeCoordinatorDeps, 'controller'>> = {},
): ExternalChangeCoordinatorDeps {
  return {
    controller: client,
    showDialog: vi.fn().mockResolvedValue(KEEP_BUTTON),
    showRebaseOffer: vi.fn().mockResolvedValue(REBASE_LATER_BUTTON),
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
  client.setCommandResult('absorbUpstreamUpdate', { succeeded: true, refusalReason: null });
  client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] });
  return client;
}

// Flushes the microtask queue: the subscriber's listener dispatches `handleUnanswered`
// fire-and-forget, so a test awaits one tick past `emit` before asserting its effects.
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('subscribeExternalChangePending', () => {
  it('does nothing until a notification arrives', () => {
    const deps = makeDeps(clientScriptedForKeepAndAbsorb());
    subscribeExternalChangePending(deps, new FakeNotificationSubscriber());

    expect(deps.showDialog).not.toHaveBeenCalled();
  });

  it('runs the dialog and dispatches Keep as My Edit', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(KEEP_BUTTON) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'keepAsMyEdit', args: ['Fixture.esp', 'ModA'] });
    expect(client.calls.map((c) => c.method)).not.toContain('absorbUpstreamUpdate');
  });

  it('dispatches Absorb, then offers the rebase — Later does not rebase', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, {
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_LATER_BUTTON),
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'absorbUpstreamUpdate', args: ['Fixture.esp', 'ModA'] });
    expect(deps.showRebaseOffer).toHaveBeenCalledWith(rebaseOfferMessage('ModA'), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
    expect(client.calls.map((c) => c.method)).not.toContain('rebaseOntoMain');
  });

  it('Rebase Now runs the rebase', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, {
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_NOW_BUTTON),
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
  });

  it('a deferred (Esc) answer calls neither absorb nor keep', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(undefined) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(client.calls).toEqual([]);
  });

  it('a failed Absorb never offers the rebase', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', undefined); // transport failure
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.showRebaseOffer).not.toHaveBeenCalled();
  });

  it('a refused Absorb never offers the rebase', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', { succeeded: false, refusalReason: 'Fixture.esp could not be parsed.' });
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    // The controller has already surfaced the reason; nothing landed, so there is no new baseline
    // to rebase onto.
    expect(deps.showRebaseOffer).not.toHaveBeenCalled();
  });

  it('a rejected dispatch logs rather than throwing', async () => {
    const log = vi.fn();
    const client = new InMemoryMEditClient();
    client.setCommandResult('keepAsMyEdit', Promise.reject(new Error('backend down')) as never);
    const deps = makeDeps(client, { log });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));
  });

  it('reports nothing further once unsubscribed', async () => {
    const deps = makeDeps(clientScriptedForKeepAndAbsorb());
    const notificationSubscriber = new FakeNotificationSubscriber();
    const unsubscribe = subscribeExternalChangePending(deps, notificationSubscriber);
    unsubscribe();

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.showDialog).not.toHaveBeenCalled();
  });
});
