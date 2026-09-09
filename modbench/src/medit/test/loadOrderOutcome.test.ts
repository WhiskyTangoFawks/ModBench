import { describe, it, expect, vi } from 'vitest';
import { reportLoadOrderResult, applyFilterSyncResult, syncActiveFilter } from '../loadOrderOutcome';
import type { components } from '../generated/api';

function makeDeps() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), setStatusText: vi.fn(), refreshTree: vi.fn(), notifyConflictsComputed: vi.fn() };
}

function plugin(over: Partial<{ enabled: boolean; winning: boolean; slot: number | null }> = {}) {
  return { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true, ...over };
}

function reconciled(failures: components['schemas']['PluginLoadFailure'][] = []) {
  return { outcome: 'reconciled' as const, failures, crashRepairOffers: [] };
}

describe('reportLoadOrderResult — reconciled', () => {
  it('writes the ready status text with the sent plugin count', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin(), plugin()], reconciled(), deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (2 plugin copies)');
  });

  // B1: main's controller called refreshTree() unconditionally on every reconciled load — the
  // record browser's page/interior/reference caches must re-read, or rows show stale records.
  it('refreshes the tree', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], reconciled(), deps);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('announces that conflicts are computed', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], reconciled(), deps);

    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin, never silently (ADR-0026)', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], reconciled([{ name: 'Bad.esp', reason: 'RACE parse' }]), deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Bad.esp'));
  });

  it('does not warn about skipped plugins when there are none', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], reconciled(), deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns when the active profile has zero enabled plugins', () => {
    const deps = makeDeps();

    reportLoadOrderResult([], reconciled(), deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  // ADR-0044: every copy is sent, so a non-empty snapshot does not mean the profile has anything
  // enabled — participation is enabled AND winning AND listed, derived.
  it('warns when plugins were sent but none of them participate', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin({ enabled: false })], reconciled(), deps);

    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no enabled plugins'));
  });

  it('does not warn about participation when at least one plugin participates', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin({ enabled: false }), plugin()], reconciled(), deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  // The rival: statusText/refreshTree/notifyConflictsComputed firing even when nothing was
  // actually sent would announce a reconcile that never happened.
  it('still writes the ready text, refreshes and announces conflicts even when nothing participates', () => {
    const deps = makeDeps();

    reportLoadOrderResult([], reconciled(), deps);

    expect(deps.setStatusText).toHaveBeenCalledWith('$(check) mEdit: Ready (0 plugin copies)');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });
});

describe('reportLoadOrderResult — failed', () => {
  it('shows the ready-to-show message verbatim', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'failed', message: 'mEdit: Failed to send the load order — bad dir' }, deps);

    expect(deps.error).toHaveBeenCalledWith('mEdit: Failed to send the load order — bad dir');
  });

  it('touches nothing else — a failed PUT tore nothing down (ADR-0044)', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'failed', message: 'boom' }, deps);

    expect(deps.setStatusText).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });
});

describe('reportLoadOrderResult — abandoned', () => {
  it('reports nothing — a superseded or closed reconcile owns no view to update', () => {
    const deps = makeDeps();

    reportLoadOrderResult([plugin()], { outcome: 'abandoned' }, deps);

    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps.setStatusText).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
    expect(deps.notifyConflictsComputed).not.toHaveBeenCalled();
  });
});

describe('applyFilterSyncResult', () => {
  function makeFilterDeps() {
    return { warn: vi.fn(), setFilterActive: vi.fn() };
  }

  it('sets the filter active with the sql the read returned', () => {
    const deps = makeFilterDeps();

    applyFilterSyncResult('SELECT form_key FROM "npc_"', deps);

    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', undefined);
  });

  it('sets the filter inactive when nothing is active', () => {
    const deps = makeFilterDeps();

    applyFilterSyncResult(null, deps);

    expect(deps.setFilterActive).toHaveBeenCalledWith(false, undefined, undefined);
  });

  it('shows the ready-to-show message verbatim and sets the filter inactive when the read fails', () => {
    const deps = makeFilterDeps();

    applyFilterSyncResult({ refused: true, message: 'mEdit: Could not read the active filter — treating the filter as inactive. boom' }, deps);

    expect(deps.warn).toHaveBeenCalledWith('mEdit: Could not read the active filter — treating the filter as inactive. boom');
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
  });
});

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

  // ADR-0026: an unsurfaced read failure is a notify-and-log tier — both the toast and the
  // channel line, never one without the other.
  it('logs and warns a read failure, and sets the filter inactive', async () => {
    const deps = makeSyncDeps();

    await syncActiveFilter(() => Promise.reject(new Error('boom')), deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(deps.warn).toHaveBeenCalledWith('mEdit: Could not read the active filter — treating the filter as inactive. boom');
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
  });
});
