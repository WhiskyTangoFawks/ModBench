import { describe, it, expect, vi } from 'vitest';
import {
  subscribeExternalChangePending, runRebase, rebaseOfferMessage,
  REBASE_NOW_BUTTON, REBASE_LATER_BUTTON,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { ABSORB_BUTTON, KEEP_BUTTON } from '../externalChangeDialog';
import type { NotificationEvent } from '../ApiClient';
import { FakeNotificationSubscriber } from '../NotificationSubscriber';

function pendingEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'external-change-pending', plugin: 'Fixture.esp', origin: 'ModA', keys: [], sequence: 0,
    externalChangeMetaChanged: false, externalChangeOldVersion: null, externalChangeNewVersion: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExternalChangeCoordinatorDeps> = {}): ExternalChangeCoordinatorDeps {
  return {
    controller: {
      keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }),
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }),
      rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }),
    } as any,
    showDialog: vi.fn().mockResolvedValue(KEEP_BUTTON),
    showRebaseOffer: vi.fn().mockResolvedValue(REBASE_LATER_BUTTON),
    openMergeEditor: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Flushes the microtask queue: the subscriber's listener dispatches `handleUnanswered`
// fire-and-forget, so a test awaits one tick past `emit` before asserting its effects.
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('rebaseOfferMessage', () => {
  it('names the edit branch and the origin', () => {
    expect(rebaseOfferMessage('ModA')).toBe('main moved ahead of "edit" in ModA.');
  });
});

describe('subscribeExternalChangePending', () => {
  it('does nothing until a notification arrives', () => {
    const deps = makeDeps();
    subscribeExternalChangePending(deps, new FakeNotificationSubscriber());

    expect(deps.showDialog).not.toHaveBeenCalled();
  });

  it('runs the dialog and dispatches Keep as My Edit', async () => {
    const deps = makeDeps({ showDialog: vi.fn().mockResolvedValue(KEEP_BUTTON) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.controller.keepAsMyEdit).toHaveBeenCalledWith('Fixture.esp', 'ModA');
    expect(deps.controller.absorbUpstreamUpdate).not.toHaveBeenCalled();
  });

  it('dispatches Absorb, then offers the rebase — Later does not rebase', async () => {
    const deps = makeDeps({
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_LATER_BUTTON),
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.controller.absorbUpstreamUpdate).toHaveBeenCalledWith('Fixture.esp', 'ModA');
    expect(deps.showRebaseOffer).toHaveBeenCalledWith(rebaseOfferMessage('ModA'), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
    expect(deps.controller.rebaseOntoMain).not.toHaveBeenCalled();
  });

  it('Rebase Now runs the rebase', async () => {
    const deps = makeDeps({
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_NOW_BUTTON),
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.controller.rebaseOntoMain).toHaveBeenCalledWith('ModA');
  });

  it('a deferred (Esc) answer calls neither absorb nor keep', async () => {
    const deps = makeDeps({ showDialog: vi.fn().mockResolvedValue(undefined) });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.controller.keepAsMyEdit).not.toHaveBeenCalled();
    expect(deps.controller.absorbUpstreamUpdate).not.toHaveBeenCalled();
  });

  it('a failed Absorb never offers the rebase', async () => {
    const deps = makeDeps({
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      controller: {
        keepAsMyEdit: vi.fn(),
        absorbUpstreamUpdate: vi.fn().mockResolvedValue(null), // transport failure
        rebaseOntoMain: vi.fn(),
      } as any,
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.showRebaseOffer).not.toHaveBeenCalled();
  });

  it('a rejected dispatch logs rather than throwing', async () => {
    const log = vi.fn();
    const deps = makeDeps({
      log,
      controller: { keepAsMyEdit: vi.fn().mockRejectedValue(new Error('backend down')) } as any,
    });
    const notificationSubscriber = new FakeNotificationSubscriber();
    subscribeExternalChangePending(deps, notificationSubscriber);

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));
  });

  it('reports nothing further once unsubscribed', async () => {
    const deps = makeDeps();
    const notificationSubscriber = new FakeNotificationSubscriber();
    const unsubscribe = subscribeExternalChangePending(deps, notificationSubscriber);
    unsubscribe();

    notificationSubscriber.emit(pendingEvent());
    await flush();

    expect(deps.showDialog).not.toHaveBeenCalled();
  });
});

describe('runRebase', () => {
  it('opens the native merge editor on every conflicted path', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/A.esp/x.json', 'source/A.esp/y.json'] }) } as any;
    const openMergeEditor = vi.fn().mockResolvedValue(undefined);

    const result = await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(openMergeEditor).toHaveBeenCalledTimes(2);
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/x.json');
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/y.json');
  });

  it('opens nothing on a clean rebase', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }) } as any;
    const openMergeEditor = vi.fn();

    await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(openMergeEditor).not.toHaveBeenCalled();
  });
});
