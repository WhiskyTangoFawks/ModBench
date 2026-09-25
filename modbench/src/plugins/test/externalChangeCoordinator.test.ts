import { describe, it, expect, vi } from 'vitest';
import {
  subscribeQuestionOpen,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { BASELINE_BUTTON, APPLY_BUTTON } from '../externalChangeDialog';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';

function pendingEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'question-open', plugin: '', origin: 'ModA', keys: ['Fixture.esp'], sequence: 0,
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
    reporter: recordingReporter(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
    presentCrashRepair: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function clientScriptedForKeepAndAbsorb(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setCommandResult('keepAsMyEdit', { succeeded: true, refusalReason: null });
  client.setCommandResult('absorbUpstreamUpdate', { landed: [{ name: 'Fixture.esp', origin: 'ModA' }], refused: [], trackedFilesRefusal: null });
  return client;
}

// Flushes the microtask queue: the subscriber's listener dispatches `handleUnanswered`
// fire-and-forget, so a test awaits one tick past `emit` before asserting its effects.
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('subscribeQuestionOpen', () => {
  it('does nothing until a notification arrives', () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    subscribeQuestionOpen(deps, client);

    expect(deps.showDialog).not.toHaveBeenCalled();
  });

  it('runs the dialog and dispatches Apply to working tree', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(APPLY_BUTTON) });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'keepAsMyEdit', args: ['ModA'] });
    expect(client.calls.map((c) => c.method)).not.toContain('absorbUpstreamUpdate');
  });

  it('dispatches Absorb; a landed Absorb is silent, and neither rebases the edit branch nor opens the merge editor', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    client.setCommandResult('rebaseOntoMain', { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Fixture.esp/x.json'] });
    const reporter = recordingReporter();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON), reporter });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'absorbUpstreamUpdate', args: ['ModA'] });
    expect(client.calls.map((c) => c.method)).not.toContain('rebaseOntoMain');
    expect(reporter.reports).toEqual([]);
    expect(deps.openMergeEditor).not.toHaveBeenCalled();
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('a deferred (Esc) answer calls neither absorb nor keep', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(undefined) });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    // `subscribe` itself is the one call `subscribeQuestionOpen` makes up front;
    // a deferred answer dispatches neither Keep nor Absorb on top of it.
    expect(client.calls.filter((c) => c.method !== 'subscribe')).toEqual([]);
  });

  it('a failed Absorb never opens the merge editor', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', { refused: true, message: 'Could not absorb the upstream update for "ModA" — socket hang up' });
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  it('a refused Absorb never opens the merge editor', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('absorbUpstreamUpdate', {
      landed: [], refused: [{ item: { name: 'Fixture.esp', origin: 'ModA' }, reason: "'Update Fixture.esp' could not be committed to main." }],
      trackedFilesRefusal: null,
    });
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON) });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    // The client has already surfaced the reason; nothing landed, so there is no new baseline
    // to rebase onto.
    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  it('a rejected dispatch logs rather than throwing', async () => {
    const log = vi.fn();
    const client = new InMemoryMEditClient();
    client.setCommandFailure('keepAsMyEdit', new Error('backend down'));
    const deps = makeDeps(client, { log });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));
  });

  // The rival: routing every question-open notification to Absorb/Keep regardless of verdict
  // would open the wrong dialog for a repair offer.
  it('a repair-offer verdict presents crash repair, never the Absorb/Keep dialog', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent({ crashRepairReason: 'InterruptedCompile', keys: ['Fixture.esp'] }));
    await flush();

    expect(deps.presentCrashRepair).toHaveBeenCalledWith([
      { plugin: 'Fixture.esp', origin: 'ModA', reason: 'InterruptedCompile' },
    ]);
    expect(deps.showDialog).not.toHaveBeenCalled();
    expect(client.calls.filter((c) => c.method !== 'subscribe')).toEqual([]);
  });

  it('explodes a mod-wide repair offer to one entry per named plugin', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent({ crashRepairReason: 'MissingOrUnreadableBinary', keys: ['A.esp', 'B.esp'] }));
    await flush();

    expect(deps.presentCrashRepair).toHaveBeenCalledWith([
      { plugin: 'A.esp', origin: 'ModA', reason: 'MissingOrUnreadableBinary' },
      { plugin: 'B.esp', origin: 'ModA', reason: 'MissingOrUnreadableBinary' },
    ]);
  });

  it('a rejected presentCrashRepair logs rather than throwing', async () => {
    const log = vi.fn();
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client, { log, presentCrashRepair: vi.fn().mockRejectedValue(new Error('modal failed')) });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent({ crashRepairReason: 'InterruptedCompile' }));
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('modal failed'));
  });

  it('reports nothing further once unsubscribed', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const deps = makeDeps(client);
    const unsubscribe = subscribeQuestionOpen(deps, client);
    unsubscribe();

    client.emit(pendingEvent());
    await flush();

    expect(deps.showDialog).not.toHaveBeenCalled();
  });
});
