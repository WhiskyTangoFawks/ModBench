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

describe('syncActiveFilter', () => {
  function makeSyncDeps() {
    return { log: vi.fn(), warn: vi.fn(), showRecordFilter: vi.fn() };
  }

  it('shows the filter mEdit holds, with its source', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.resolve({ sql: 'SELECT form_key FROM "npc_"', source: 'npcs.sql' }), deps);

    expect(deps.showRecordFilter).toHaveBeenCalledWith({ sql: 'SELECT form_key FROM "npc_"', source: 'npcs.sql' });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('shows no filter when mEdit holds none', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.resolve(null), deps);

    expect(deps.showRecordFilter).toHaveBeenCalledWith(null);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  // plugins.md, Order and view state, story 5: the filter clears only on purpose, so a read that
  // failed says nothing about whether mEdit still filters.
  it('logs and warns a read failure, and keeps showing the last known filter', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.reject(new Error('boom')), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(deps.warn).toHaveBeenCalledWith(
      "mEdit: Could not read the record filter — the Plugins view shows it as it last was. boom");
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
  });
});
