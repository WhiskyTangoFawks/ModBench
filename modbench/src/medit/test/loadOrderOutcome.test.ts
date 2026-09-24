import { describe, it, expect, vi } from 'vitest';
import { reportPutOutcome, settleReconciled, syncActiveFilter } from '../loadOrderOutcome';
import type { LoadOrderProgress } from '../../client';
import type { components } from '../../wire/generated/api';

function plugin(over: Partial<{ enabled: boolean; winning: boolean; slot: number | null }> = {}) {
  return { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true, ...over };
}

const readyStatus: LoadOrderProgress = {
  totalPlugins: 2, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const applied = { outcome: 'applied' as const, status: readyStatus };
type PluginLoadFailure = components['schemas']['PluginLoadFailure'];

const putDeps = () => ({ warn: vi.fn(), error: vi.fn() });

describe('reportPutOutcome', () => {
  it('shows a failed send\'s ready-to-show message verbatim, and nothing else', () => {
    const deps = putDeps();

    reportPutOutcome([plugin()], { outcome: 'failed', message: 'mEdit: Failed to send the load order — bad dir' }, deps);

    expect(deps.error).toHaveBeenCalledWith('mEdit: Failed to send the load order — bad dir');
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('says nothing for an abandoned send — a superseded or closed send owns no view', () => {
    const deps = putDeps();

    reportPutOutcome([], { outcome: 'abandoned' }, deps);

    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns when the active profile has zero enabled plugins', () => {
    const deps = putDeps();

    reportPutOutcome([], applied, deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  // ADR-0013: every copy is sent, so a non-empty snapshot does not mean the profile has anything
  // enabled — participation is enabled AND winning AND listed, derived.
  it('warns when plugins were sent but none of them participate', () => {
    const deps = putDeps();

    reportPutOutcome([plugin({ enabled: false })], applied, deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn when at least one plugin participates', () => {
    const deps = putDeps();

    reportPutOutcome([plugin({ enabled: false }), plugin()], applied, deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('does not warn over a terminal refusal, which is the index status\'s to say', () => {
    const deps = putDeps();
    const heldElsewhere = { outcome: 'applied' as const, status: { ...readyStatus, conflictsComputed: false, refusalMessage: 'another window' } };

    reportPutOutcome([], heldElsewhere, deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });
});

// ADR-0013: a reconcile that reached Ready, whoever started it, is reported and then applied.
describe('settleReconciled', () => {
  const settleDeps = () => ({
    log: vi.fn(), warn: vi.fn(), setStatusText: vi.fn(), refreshTree: vi.fn(), notifyConflictsComputed: vi.fn(),
    syncFilterState: vi.fn().mockResolvedValue(undefined),
    applyReconciled: vi.fn().mockResolvedValue(undefined),
  });

  it('writes the ready status text with the backend\'s own count of copies', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (2 plugin copies)');
  });

  // The record browser's page/interior/reference caches must re-read, or rows show stale records.
  it('refreshes the record browser and announces that conflicts are computed', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin, never silently (ADR-0019)', async () => {
    const deps = settleDeps();
    const failures: PluginLoadFailure[] = [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }];

    await settleReconciled({ ...readyStatus, failures }, deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
  });

  it('does not warn about skipped plugins when there are none', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('syncs the filter state, then hands the tree the status\'s own failures and count', async () => {
    const deps = settleDeps();
    const order: string[] = [];
    deps.syncFilterState.mockImplementation(() => { order.push('syncFilterState'); return Promise.resolve(); });
    deps.applyReconciled.mockImplementation(() => { order.push('applyReconciled'); return Promise.resolve(); });
    const failures: PluginLoadFailure[] = [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }];

    await settleReconciled({ ...readyStatus, totalPlugins: 42, failures }, deps);

    expect(order).toEqual(['syncFilterState', 'applyReconciled']);
    expect(deps.applyReconciled).toHaveBeenCalledWith(failures, 42);
  });
});

// applyFilterSyncResult is not exported: syncActiveFilter is its one caller, and every result
// shape it can be handed — a sql string, null, or the refused object a caught read builds — is
// reachable by what getActiveFilter resolves or rejects with below.
describe('syncActiveFilter', () => {
  function makeSyncDeps() {
    return { log: vi.fn(), warn: vi.fn(), setFilterActive: vi.fn() };
  }

  it('sets the filter active with what the read returned', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.resolve('SELECT form_key FROM "npc_"'), deps);

    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', undefined);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('sets the filter inactive when nothing is active', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.resolve(null), deps);

    expect(deps.setFilterActive).toHaveBeenCalledWith(false, undefined, undefined);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  // ADR-0019: an unsurfaced read failure is a notify-and-log tier — both the toast and the
  // channel line, never one without the other.
  it('logs and warns a read failure, and sets the filter inactive', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.reject(new Error('boom')), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(deps.warn).toHaveBeenCalledWith('mEdit: Could not read the active filter — treating the filter as inactive. boom');
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
  });
});
