import { describe, it, expect, vi } from 'vitest';
import {
  reportLoadOrderResult, syncActiveFilter, applyLoadOrderOutcome,
} from '../loadOrderOutcome';
import type { components } from '../../wire/generated/api';

function makeDeps() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), setStatusText: vi.fn(), refreshTree: vi.fn(), notifyConflictsComputed: vi.fn() };
}

function plugin(over: Partial<{ enabled: boolean; winning: boolean; slot: number | null }> = {}) {
  return { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true, ...over };
}

const readyStatus = { totalPlugins: 0, version: 1, indexedPlugins: [], conflictsComputed: true, failures: [] };
const applied = { outcome: 'applied' as const, status: readyStatus };
type PluginLoadFailure = components['schemas']['PluginLoadFailure'];

describe('reportLoadOrderResult — applied', () => {
  it('writes the ready status text with the sent plugin count', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin(), plugin()], applied, [], deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (2 plugin copies)');
  });

  // B1: main's controller called refreshTree() unconditionally on every reconciled load — the
  // record browser's page/interior/reference caches must re-read, or rows show stale records.
  it('refreshes the tree', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], applied, [], deps);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('announces that conflicts are computed', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], applied, [], deps);

    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin, never silently (ADR-0019)', () => {
    const deps = makeDeps();
    const failures: PluginLoadFailure[] = [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }];

    reportLoadOrderResult([plugin()], applied, failures, deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
  });

  it('does not warn about skipped plugins when there are none', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], applied, [], deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns when the active profile has zero enabled plugins', () => {
    const deps = makeDeps();

    reportLoadOrderResult([], applied, [], deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  // ADR-0013: every copy is sent, so a non-empty snapshot does not mean the profile has anything
  // enabled — participation is enabled AND winning AND listed, derived.
  it('warns when plugins were sent but none of them participate', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin({ enabled: false })], applied, [], deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn about participation when at least one plugin participates', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin({ enabled: false }), plugin()], applied, [], deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  // The rival: statusText/refreshTree/notifyConflictsComputed firing even when nothing was
  // actually sent would announce a reconcile that never happened.
  it('still writes the ready text, refreshes and announces conflicts even when nothing participates', () => {
    const deps = makeDeps();

    reportLoadOrderResult([], applied, [], deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (0 plugin copies)');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });
});

// A held-elsewhere or failed terminal status still answers applied at the wire (ADR-0013): the
// status bar carries the refusal, and nothing here claims Ready over it.
describe('reportLoadOrderResult — applied with a terminal refusal', () => {
  const heldElsewhere = {
    outcome: 'applied' as const,
    status: { totalPlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: false, failures: [], refusalMessage: 'another Modbench window holds this instance' },
  };

  it('writes the refusal to the status bar, never the ready text', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], heldElsewhere, [], deps);

    expect(deps.setStatusText).toHaveBeenCalledWith(expect.stringContaining('another Modbench window holds this instance'));
    expect(deps.setStatusText).not.toHaveBeenCalledWith(expect.stringContaining('Ready'));
  });

  it('never refreshes the tree or announces conflicts computed', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], heldElsewhere, [], deps);

    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
  });
});

describe('reportLoadOrderResult — failed', () => {
  it('shows the ready-to-show message verbatim', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'failed', message: 'mEdit: Failed to send the load order — bad dir' }, [], deps);

    expect(deps.error).toHaveBeenCalledWith('mEdit: Failed to send the load order — bad dir');
  });

  it('touches nothing else — a failed PUT tore nothing down (ADR-0013)', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'failed', message: 'boom' }, [], deps);

    expect(deps.setStatusText).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });
});

describe('reportLoadOrderResult — abandoned', () => {
  it('reports nothing — a superseded or closed reconcile owns no view to update', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'abandoned' }, [], deps);

    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps.setStatusText).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
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

// ADR-0013: a settled PUT is reported first, then applied. A repair offer is the question-open
// coordinator's own affair (externalChangeCoordinator.test.ts), never this outcome's.
describe('applyLoadOrderOutcome', () => {
  const makeApplyDeps = () => ({
    ...makeDeps(),
    syncFilterState: vi.fn().mockResolvedValue(undefined),
    applyReconciled: vi.fn().mockResolvedValue(undefined),
  });

  it('syncs the filter state, then hands the tree the failures and the backend\'s own count', async () => {
    const deps = makeApplyDeps();
    const order: string[] = [];
    deps.syncFilterState.mockImplementation(() => { order.push('syncFilterState'); return Promise.resolve(); });
    deps.applyReconciled.mockImplementation(() => { order.push('applyReconciled'); return Promise.resolve(); });

    await applyLoadOrderOutcome([plugin()], applied, [], 42, deps);

    expect(order).toEqual(['syncFilterState', 'applyReconciled']);
    expect(deps.applyReconciled).toHaveBeenCalledWith([], 42);
  });

  it('reports the applied load order as well as applying it', async () => {
    const deps = makeApplyDeps();

    await applyLoadOrderOutcome([plugin()], applied, [], 1, deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (1 plugin copies)');
  });

  it('passes the caller\'s own failures through to applyReconciled, never a copy of its own', async () => {
    const deps = makeApplyDeps();
    const failures: PluginLoadFailure[] = [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }];

    await applyLoadOrderOutcome([plugin()], applied, failures, 1, deps);

    expect(deps.applyReconciled).toHaveBeenCalledWith(failures, 1);
  });

  it('applies nothing when the send failed, and surfaces the failure', async () => {
    const deps = makeApplyDeps();

    await applyLoadOrderOutcome([plugin()], { outcome: 'failed', message: 'no backend' }, [], 1, deps);

    expect(deps.error).toHaveBeenCalledWith('no backend');
    expect(deps.syncFilterState).not.toHaveBeenCalled();
    expect(deps.applyReconciled).not.toHaveBeenCalled();
  });

  it('applies nothing and says nothing when the send was abandoned', async () => {
    const deps = makeApplyDeps();

    await applyLoadOrderOutcome([plugin()], { outcome: 'abandoned' }, [], 1, deps);

    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.setStatusText).not.toHaveBeenCalled();
    expect(deps.syncFilterState).not.toHaveBeenCalled();
    expect(deps.applyReconciled).not.toHaveBeenCalled();
  });

  // The rival this pins: syncing the filter or handing the tree a reconcile that never happened,
  // because the PUT itself still answered applied over a held-elsewhere or failed terminal tick.
  it('applies nothing when the terminal status is a refusal, though the PUT answered applied', async () => {
    const deps = makeApplyDeps();
    const heldElsewhere = {
      outcome: 'applied' as const,
      status: { totalPlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: false, failures: [], refusalMessage: 'another window' },
    };

    await applyLoadOrderOutcome([plugin()], heldElsewhere, [], 1, deps);

    expect(deps.syncFilterState).not.toHaveBeenCalled();
    expect(deps.applyReconciled).not.toHaveBeenCalled();
  });
});
