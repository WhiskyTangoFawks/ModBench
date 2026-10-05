import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ items: [] as { text: string }[] }));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => {
      const item = { text: '', show: () => undefined, dispose: () => undefined };
      h.items.push(item);
      return item;
    },
  },
}));

import { followIndexStatus, settleReconciled, syncActiveFilter, type IndexStatusDeps } from '../indexStatus';
import { createStatusBar } from '../statusBar';
import {
  InMemoryMEditClient, type LoadOrderProgress, type PluginLoadFailure,
} from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const statusBarText = (): string => present(h.items.at(-1), 'the status bar item').text;

beforeEach(() => { h.items.length = 0; });

const readyStatus: LoadOrderProgress = {
  totalPlugins: 3, activePlugins: 2, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};

describe('settleReconciled, a reconcile that reached Ready being reported and then applied whoever started it', () => {
  const settleDeps = () => ({
    log: vi.fn(), warn: vi.fn(), statusBar: createStatusBar(new InMemoryMEditClient()), refreshTree: vi.fn(),
    notifyConflictsComputed: vi.fn(),
    syncFilterState: vi.fn().mockResolvedValue(undefined),
    applyReconciled: vi.fn().mockResolvedValue(undefined),
  });

  it('says Ready on the status bar counting the active plugins, not every plugin indexed', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(statusBarText()).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('refreshes the record browser, whose page, interior and reference caches would otherwise show stale records, and announces that conflicts are computed', async () => {
    const deps = settleDeps();

    await settleReconciled(readyStatus, deps);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.notifyConflictsComputed).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin by name', async () => {
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

type WireStatus = NonNullable<NotificationEvent['loadOrderStatus']>;

const statusEvent = (over: Partial<WireStatus> = {}): NotificationEvent => ({
  kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
  loadOrderStatus: {
    state: 'Ready', totalPlugins: 2, activePlugins: 2, indexedPlugins: [], conflictsComputed: true, failures: [], version: 1,
    ...over,
  },
});

function followed() {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  client.setQueryAnswer('getActiveFilter', null);
  const deps = {
    client,
    tree: {
      applyIndexed: vi.fn(), applyRefused: vi.fn(), applyBackendUnreachable: vi.fn(),
      applyReconciled: vi.fn().mockResolvedValue(0), refreshFacts: vi.fn().mockResolvedValue(undefined),
    },
    recordBrowser: { refresh: vi.fn() },
    progress: { while: vi.fn((work: () => Promise<void>) => work()), say: vi.fn() },
    statusBar: createStatusBar(client),
    showRecordFilter: vi.fn(),
    notifyConflictsComputed: vi.fn(),
    log: vi.fn(),
    reporter: recordingReporter(),
  } satisfies IndexStatusDeps;
  return { client, deps, followed: followIndexStatus(deps) };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the Plugins view following the index status and mEdit\'s own', () => {
  it('says Ready on the status bar once the stream\'s Ready is handed to the tree', async () => {
    const { client, deps } = followed();

    client.emit(statusEvent({ activePlugins: 2 }));
    await flushed();

    expect(deps.tree.applyReconciled).toHaveBeenCalledOnce();
    expect(statusBarText()).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('logs how many plugins the tree holds next to the failures and the snapshot\'s total', async () => {
    const { client, deps } = followed();
    deps.tree.applyReconciled.mockResolvedValue(3);

    client.emit(statusEvent({ activePlugins: 2 }));
    await flushed();

    expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('3 in the load order, 0 failed'));
  });

  it('logs the error and warns that rows will not expand when the tree could not read the plugin list', async () => {
    const { client, deps } = followed();
    deps.tree.applyReconciled.mockResolvedValue(undefined);

    client.emit(statusEvent({ activePlugins: 2 }));
    await flushed();

    expect(deps.log).toHaveBeenCalledWith('error', expect.stringContaining('did not reach the tree'));
    expect(deps.reporter.reports.map((report) => report.severity)).toEqual(['warning']);
    expect(deps.reporter.reports[0]?.message).toContain('plugin list could not be read');
    expect(deps.log).not.toHaveBeenCalledWith('info', expect.stringContaining('in the load order'));
  });

  it.each([
    ['a later reconcile starts', { state: 'Reconciling', conflictsComputed: false, version: 2 }],
    ['the index is dropped', { state: 'None', conflictsComputed: false, totalPlugins: 0, version: 2 }],
  ] as const)('gives Ready back to mEdit\'s own state when %s', async (_when, over) => {
    const { client } = followed();
    client.emit(statusEvent());
    await flushed();

    client.emit(statusEvent(over));
    await flushed();

    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it.each([
    ['HeldElsewhere', 'heldElsewhere', 'This instance\'s index is open in another Modbench window.'],
    ['Failed', 'failed', 'the reconcile threw something unexpected'],
  ] as const)('hands a %s refusal to the tree, and gives the status bar back to mEdit\'s own state', async (state, kind, message) => {
    const { client, deps } = followed();
    client.emit(statusEvent());
    await flushed();

    client.emit(statusEvent({ state, conflictsComputed: false, message, version: 2 }));
    await flushed();

    expect(deps.tree.applyRefused).toHaveBeenCalledWith({ kind, message });
    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it('runs the view\'s progress while the index fills, and closes it on Ready', async () => {
    const { client, deps } = followed();
    let closed = false;
    deps.progress.while.mockImplementation((work: () => Promise<void>) => work().then(() => { closed = true; }));

    client.emit(statusEvent({ state: 'Reconciling', conflictsComputed: false }));
    await flushed();
    expect(deps.progress.while).toHaveBeenCalledOnce();
    expect(closed).toBe(false);

    client.emit(statusEvent());
    await flushed();
    expect(closed).toBe(true);
  });

  it.each([
    ['disconnected', 'mEdit is disconnected.'],
    ['stopped', 'mEdit is stopped.'],
  ] as const)('names the tree unreachable when mEdit is %s, and re-reads its facts', (status, reason) => {
    const { client, deps } = followed();

    client.setStatus(status);

    expect(deps.tree.applyBackendUnreachable).toHaveBeenCalledWith(reason);
    expect(deps.tree.refreshFacts).toHaveBeenCalledOnce();
  });

  it.each(['starting', 'running'] as const)('leaves the tree to the reconcile while mEdit is %s', (status) => {
    const { client, deps } = followed();

    client.setStatus(status);

    expect(deps.tree.applyBackendUnreachable).not.toHaveBeenCalled();
    expect(deps.tree.refreshFacts).not.toHaveBeenCalled();
  });

  it('hears nothing once disposed', async () => {
    const { client, deps, followed: following } = followed();

    following.dispose();
    client.emit(statusEvent());
    client.setStatus('disconnected');
    await flushed();

    expect(deps.tree.applyReconciled).not.toHaveBeenCalled();
    expect(deps.tree.applyBackendUnreachable).not.toHaveBeenCalled();
  });
});
