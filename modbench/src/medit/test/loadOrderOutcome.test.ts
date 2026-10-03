import { describe, it, expect, vi } from 'vitest';
import { reportPutOutcome, settleReconciled, syncActiveFilter } from '../loadOrderOutcome';
import type { LoadOrderProgress } from '../../client';
import type { components } from '../../wire/generated/api';

const readyStatus: LoadOrderProgress = {
  totalPlugins: 3, activePlugins: 2, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const applied = { outcome: 'applied' as const, status: readyStatus };
type PluginLoadFailure = components['schemas']['PluginLoadFailure'];


describe('reportPutOutcome', () => {
  it('shows a failed send\'s ready-to-show message verbatim', () => {
    const error = vi.fn();

    reportPutOutcome({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }, { error });

    expect(error).toHaveBeenCalledWith('Failed to send the load order — bad dir');
  });

  it('says nothing for an abandoned send — a superseded or closed send owns no view', () => {
    const error = vi.fn();

    reportPutOutcome({ outcome: 'abandoned' }, { error });

    expect(error).not.toHaveBeenCalled();
  });

  it('says nothing for an applied send, whose reconcile is the narrator\'s to show', () => {
    const error = vi.fn();

    reportPutOutcome(applied, { error });

    expect(error).not.toHaveBeenCalled();
  });
});

describe('settleReconciled, a reconcile that reached Ready being reported and then applied whoever started it', () => {
  const settleDeps = () => ({
    log: vi.fn(), warn: vi.fn(), setStatusText: vi.fn(), refreshTree: vi.fn(), notifyConflictsComputed: vi.fn(),
    syncFilterState: vi.fn().mockResolvedValue(undefined),
    applyReconciled: vi.fn().mockResolvedValue(undefined),
  });

  it('writes the ready status text counting the active plugins, not every plugin indexed', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (2 plugins)');
  });

  it('refreshes the record browser, whose page, interior and reference caches would otherwise show stale records, and announces that conflicts are computed', async () => {
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

  it('logs and warns a read failure, and keeps showing the last known filter, since a failed read says nothing about whether mEdit still filters', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.reject(new Error('boom')), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(deps.warn).toHaveBeenCalledWith(
      "Could not read the record filter — the Plugins view shows it as it last was. boom");
    expect(deps.showRecordFilter).not.toHaveBeenCalled();
  });
});
