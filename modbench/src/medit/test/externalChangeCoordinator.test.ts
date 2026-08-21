import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startExternalChangePolling, runRebase, rebaseOfferMessage, REBASE_NOW_BUTTON, REBASE_LATER_BUTTON,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { ABSORB_BUTTON, KEEP_BUTTON } from '../externalChangeDialog';
import type { PendingExternalChange } from '../ApiClient';

function pending(overrides: Partial<PendingExternalChange> = {}): PendingExternalChange {
  return { plugin: 'Fixture.esp', origin: 'ModA', metaChanged: false, oldVersion: null, newVersion: null, ...overrides };
}

function makeDeps(overrides: Partial<ExternalChangeCoordinatorDeps> = {}): ExternalChangeCoordinatorDeps {
  return {
    repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([]) } as any,
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

describe('rebaseOfferMessage', () => {
  it('names the edit branch and the origin', () => {
    expect(rebaseOfferMessage('ModA')).toBe('main moved ahead of "edit" in ModA.');
  });
});

describe('startExternalChangePolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls, and does nothing when the queue is empty', async () => {
    const deps = makeDeps();
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.repository.getExternalChangeStatus).toHaveBeenCalled();
    expect(deps.showDialog).not.toHaveBeenCalled();
    stop();
  });

  it('runs the dialog and dispatches Keep as My Edit', async () => {
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([pending()]) } as any,
      showDialog: vi.fn().mockResolvedValue(KEEP_BUTTON),
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.controller.keepAsMyEdit).toHaveBeenCalledWith('Fixture.esp', 'ModA');
    expect(deps.controller.absorbUpstreamUpdate).not.toHaveBeenCalled();
    stop();
  });

  it('dispatches Absorb, then offers the rebase — Later does not rebase', async () => {
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([pending()]) } as any,
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_LATER_BUTTON),
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.controller.absorbUpstreamUpdate).toHaveBeenCalledWith('Fixture.esp', 'ModA');
    expect(deps.showRebaseOffer).toHaveBeenCalledWith(rebaseOfferMessage('ModA'), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
    expect(deps.controller.rebaseOntoMain).not.toHaveBeenCalled();
    stop();
  });

  it('Rebase Now runs the rebase', async () => {
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([pending()]) } as any,
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      showRebaseOffer: vi.fn().mockResolvedValue(REBASE_NOW_BUTTON),
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.controller.rebaseOntoMain).toHaveBeenCalledWith('ModA');
    stop();
  });

  it('a deferred (Esc) answer calls neither absorb nor keep', async () => {
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([pending()]) } as any,
      showDialog: vi.fn().mockResolvedValue(undefined),
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.controller.keepAsMyEdit).not.toHaveBeenCalled();
    expect(deps.controller.absorbUpstreamUpdate).not.toHaveBeenCalled();
    stop();
  });

  it('a failed Absorb never offers the rebase', async () => {
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([pending()]) } as any,
      showDialog: vi.fn().mockResolvedValue(ABSORB_BUTTON),
      controller: {
        keepAsMyEdit: vi.fn(),
        absorbUpstreamUpdate: vi.fn().mockResolvedValue(null), // transport failure
        rebaseOntoMain: vi.fn(),
      } as any,
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);

    expect(deps.showRebaseOffer).not.toHaveBeenCalled();
    stop();
  });

  it('a poll failure logs and keeps polling rather than throwing', async () => {
    const log = vi.fn();
    const deps = makeDeps({
      repository: { getExternalChangeStatus: vi.fn().mockRejectedValue(new Error('backend down')) } as any,
      log,
    });
    const stop = startExternalChangePolling(deps, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));

    (deps.repository.getExternalChangeStatus as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.repository.getExternalChangeStatus).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops polling once stopped', async () => {
    const deps = makeDeps();
    const stop = startExternalChangePolling(deps, 100);
    stop();

    await vi.advanceTimersByTimeAsync(1000);

    expect(deps.repository.getExternalChangeStatus).not.toHaveBeenCalled();
  });
});

describe('runRebase', () => {
  it('opens the native merge editor on every conflicted path', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['A.source/x.json', 'A.source/y.json'] }) } as any;
    const openMergeEditor = vi.fn().mockResolvedValue(undefined);

    const result = await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(openMergeEditor).toHaveBeenCalledTimes(2);
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'A.source/x.json');
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'A.source/y.json');
  });

  it('opens nothing on a clean rebase', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }) } as any;
    const openMergeEditor = vi.fn();

    await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(openMergeEditor).not.toHaveBeenCalled();
  });
});
