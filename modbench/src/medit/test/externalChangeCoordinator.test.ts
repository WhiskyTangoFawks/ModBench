import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startExternalChangePolling, runRebase, rebaseOfferMessage, gateExternalChangePolling,
  REBASE_NOW_BUTTON, REBASE_LATER_BUTTON,
  type ExternalChangeCoordinatorDeps, type ExternalChangePollerGateDeps,
} from '../externalChangeCoordinator';
import { ABSORB_BUTTON, KEEP_BUTTON } from '../externalChangeDialog';
import type { UnansweredExternalChange } from '../ApiClient';

function unanswered(overrides: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
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
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([unanswered()]) } as any,
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
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([unanswered()]) } as any,
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
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([unanswered()]) } as any,
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
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([unanswered()]) } as any,
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
      repository: { getExternalChangeStatus: vi.fn().mockResolvedValue([unanswered()]) } as any,
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

// #432: the poller has no reason to exist before a backend does — these prove the gate reacts to
// the backend's health signal alone (never a timer, never session state, which this fixture has no
// concept of at all).
describe('gateExternalChangePolling', () => {
  function makeGateDeps() {
    let statusCb: (() => void) | undefined;
    let healthy = false;
    const stopFns: Array<ReturnType<typeof vi.fn>> = [];
    const deps: ExternalChangePollerGateDeps = {
      onBackendStatusChange: vi.fn((cb: () => void) => { statusCb = cb; }),
      isBackendHealthy: () => healthy,
      startPolling: vi.fn(() => {
        const stop = vi.fn();
        stopFns.push(stop);
        return stop;
      }),
    };
    return {
      deps,
      stopFns,
      setHealthy: (value: boolean) => { healthy = value; statusCb?.(); },
    };
  }

  it('never starts polling before the backend has ever been healthy', () => {
    const { deps } = makeGateDeps();
    gateExternalChangePolling(deps);
    expect(deps.startPolling).not.toHaveBeenCalled();
  });

  it('starts polling once the backend becomes healthy', () => {
    const { deps, setHealthy } = makeGateDeps();
    gateExternalChangePolling(deps);
    setHealthy(true);
    expect(deps.startPolling).toHaveBeenCalledTimes(1);
  });

  it('does not double-start on a repeated healthy signal (e.g. a crash-restart\'s own second "attached")', () => {
    const { deps, setHealthy } = makeGateDeps();
    gateExternalChangePolling(deps);
    setHealthy(true);
    setHealthy(true);
    expect(deps.startPolling).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the backend becomes unhealthy', () => {
    const { deps, setHealthy, stopFns } = makeGateDeps();
    gateExternalChangePolling(deps);
    setHealthy(true);
    setHealthy(false);
    expect(stopFns[0]).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh poll on the next healthy transition after stopping — a relaunch restarts it', () => {
    const { deps, setHealthy } = makeGateDeps();
    gateExternalChangePolling(deps);
    setHealthy(true);
    setHealthy(false);
    setHealthy(true);
    expect(deps.startPolling).toHaveBeenCalledTimes(2);
  });
});
