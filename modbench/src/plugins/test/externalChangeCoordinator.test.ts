import { describe, it, expect, vi } from 'vitest';
import {
  subscribeQuestionOpen,
  type ExternalChangeCoordinatorDeps,
} from '../externalChangeCoordinator';
import { BASELINE_BUTTON, APPLY_BUTTON } from '../externalChangeDialog';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

function pendingEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'question-open', plugin: '', origin: 'ModA', keys: ['Fixture.esp'], sequence: 0,
    externalChangeMetaChanged: false, externalChangeOldVersion: null, externalChangeNewVersion: null,
    externalChangeTrackedFiles: [],
    ...overrides,
  };
}

// Every test's own `client` scripts `keepAsMyEdit`/`absorbUpstreamUpdate`
// before this runs; a call the test never scripted rejects loudly (InMemoryMEditClient's own
// contract), so a forgotten script fails the test rather than silently no-oping.
function makeDeps(
  client: InMemoryMEditClient, overrides: Partial<Omit<ExternalChangeCoordinatorDeps, 'client'>> = {},
): ExternalChangeCoordinatorDeps {
  return {
    client,
    showDialog: vi.fn().mockResolvedValue(APPLY_BUTTON),
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

  it('dispatches Absorb, and a landed Absorb is silent', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const reporter = recordingReporter();
    const deps = makeDeps(client, { showDialog: vi.fn().mockResolvedValue(BASELINE_BUTTON), reporter });
    subscribeQuestionOpen(deps, client);

    client.emit(pendingEvent());
    await flush();

    expect(client.calls).toContainEqual({ method: 'absorbUpstreamUpdate', args: ['ModA'] });
    expect(reporter.reports).toEqual([]);
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

// ADR-0003, invariant 3: one dialog asks. A settle can split one release into two questions, and
// a modal cannot be updated, so a dialog is never shown twice at once.
describe('subscribeQuestionOpen — one dialog per mod', () => {
  // Each dialog stays open until the test answers it.
  function heldDialogs() {
    const open: { detail: string; answer: (choice: string | undefined) => void }[] = [];
    const showDialog = vi.fn((_message: string, options: { detail?: string }) =>
      new Promise<string | undefined>((resolve) => { open.push({ detail: options.detail ?? '', answer: resolve }); }));
    const answerOpen = async (index: number, choice: string | undefined) => {
      present(open[index], `dialog ${index}`).answer(choice);
      await flush();
    };
    return { open, showDialog, answerOpen };
  }

  // Either answer covers the whole mod, so a question the backend published before the answer
  // landed is answered by it; mEdit publishes again at the next settle that still finds a change.
  it('carries out the answer over a mod\'s question that arrived mid-dialog, and asks no second dialog', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const { open, showDialog, answerOpen } = heldDialogs();
    subscribeQuestionOpen(makeDeps(client, { showDialog }), client);

    client.emit(pendingEvent({ externalChangeTrackedFiles: ['a.dds'] }));
    client.emit(pendingEvent({ externalChangeTrackedFiles: ['a.dds', 'b.dds'] }));
    await flush();
    await answerOpen(0, APPLY_BUTTON);

    expect(open).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'keepAsMyEdit')).toHaveLength(1);
  });

  it('asks nothing of a question that arrived while its mod\'s answer was being carried out, and asks the next one', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    let land: () => void = () => undefined;
    const keepAsMyEdit = vi.fn(() => new Promise<{ succeeded: true; refusalReason: null }>((resolve) => {
      land = () => { resolve({ succeeded: true, refusalReason: null }); };
    }));
    const { open, showDialog, answerOpen } = heldDialogs();
    const heldClient = {
      keepAsMyEdit, absorbUpstreamUpdate: vi.fn(),
    };
    subscribeQuestionOpen({ ...makeDeps(client, { showDialog }), client: heldClient }, client);

    client.emit(pendingEvent());
    await flush();
    await answerOpen(0, APPLY_BUTTON);
    client.emit(pendingEvent({ externalChangeTrackedFiles: ['b.dds'] }));
    land();
    await flush();
    expect(open).toHaveLength(1);

    client.emit(pendingEvent({ externalChangeTrackedFiles: ['c.dds'] }));
    await flush();
    expect(open).toHaveLength(2);
  });

  it('goes on to the next mod\'s question when one mod\'s dialog throws, and logs the mod that threw', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const log = vi.fn();
    const shownFor: string[] = [];
    const showDialog = vi.fn((message: string) => {
      shownFor.push(message);
      return message === 'ModA' ? Promise.reject(new Error('modal failed')) : Promise.resolve(undefined);
    });
    subscribeQuestionOpen(makeDeps(client, { showDialog, log }), client);

    client.emit(pendingEvent({ origin: 'ModA' }));
    client.emit(pendingEvent({ origin: 'ModB' }));
    await flush();

    expect(shownFor).toEqual(['ModA', 'ModB']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('handling ModA failed'));
  });

  it('asks nothing more of a mod whose open dialog the user dismissed', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const { open, showDialog, answerOpen } = heldDialogs();
    subscribeQuestionOpen(makeDeps(client, { showDialog }), client);

    client.emit(pendingEvent({ externalChangeTrackedFiles: ['a.dds'] }));
    client.emit(pendingEvent({ externalChangeTrackedFiles: ['a.dds', 'b.dds'] }));
    await flush();
    await answerOpen(0, undefined);

    expect(open).toHaveLength(1);
  });

  it('shows another mod\'s question only once the open dialog closes', async () => {
    const client = clientScriptedForKeepAndAbsorb();
    const { open, showDialog, answerOpen } = heldDialogs();
    subscribeQuestionOpen(makeDeps(client, { showDialog }), client);

    client.emit(pendingEvent({ origin: 'ModA' }));
    client.emit(pendingEvent({ origin: 'ModB' }));
    await flush();
    expect(open).toHaveLength(1);

    await answerOpen(0, undefined);
    expect(open).toHaveLength(2);
  });
});
