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

import { followIndexStatus } from '../indexStatus';
import { createStatusBar } from '../statusBar';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const statusBarText = (): string => present(h.items.at(-1), 'the status bar item').text;

beforeEach(() => { h.items.length = 0; });

const statusEvent = (over: Parameters<typeof loadOrderStatusEventFixture>[0] = {}) =>
  loadOrderStatusEventFixture({ totalPlugins: 2, activePlugins: 2, ...over });

function followed() {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  const deps = {
    client,
    facts: {
      indexed: vi.fn(), refused: vi.fn(), unreachable: vi.fn(),
      reconciled: vi.fn().mockResolvedValue(0), refresh: vi.fn().mockResolvedValue(undefined),
    },
    progress: { while: vi.fn((work: () => Promise<void>) => work()), say: vi.fn() },
    statusBar: createStatusBar(client, () => recordingReporter()),
    registerRepositories: vi.fn(),
    log: vi.fn(),
    reporter: recordingReporter(),
  } satisfies Parameters<typeof followIndexStatus>[0];
  const following = followIndexStatus(deps);
  return { client, deps, followed: following, handedOver: () => following.narrator.settled(1) };
}

describe('the Plugins view following the record index status and mEdit\'s own', () => {
  it('says Ready on the status bar counting the active plugins, not every plugin indexed, once the stream\'s Ready is handed to the tree', async () => {
    const { client, deps, handedOver } = followed();

    client.emit(statusEvent({ totalPlugins: 5, activePlugins: 2 }));
    await handedOver();

    expect(deps.facts.reconciled).toHaveBeenCalledOnce();
    expect(statusBarText()).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('reports nothing when the hand-off did not land', async () => {
    const { client, deps, handedOver } = followed();
    deps.facts.reconciled.mockResolvedValue(undefined);

    client.emit(statusEvent());
    await handedOver();

    expect(deps.log).not.toHaveBeenCalledWith('error', expect.anything());
    expect(deps.reporter.reports).toEqual([]);
  });

  it.each([
    ['a later reconcile starts', { state: 'Reconciling', conflictsComputed: false, version: 2 }],
    ['the record index is dropped', { state: 'None', conflictsComputed: false, totalPlugins: 0, version: 2 }],
  ] as const)('gives Ready back to mEdit\'s own state when %s', async (_when, over) => {
    const { client, handedOver } = followed();
    client.emit(statusEvent());
    await handedOver();

    client.emit(statusEvent(over));

    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it('hands a refusal to the tree, and gives the status bar back to mEdit\'s own state', async () => {
    const { client, deps, handedOver } = followed();
    client.emit(statusEvent());
    await handedOver();

    client.emit(statusEvent({ state: 'HeldElsewhere', conflictsComputed: false, message: 'This instance\'s index is open in another Modbench window.', version: 2 }));

    expect(deps.facts.refused).toHaveBeenCalledWith({ kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' });
    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it('runs the view\'s progress while the record index fills, and closes it on Ready', async () => {
    const { client, deps, handedOver } = followed();
    let closed = false;
    deps.progress.while.mockImplementation((work: () => Promise<void>) => work().then(() => { closed = true; }));

    client.emit(statusEvent({ state: 'Reconciling', conflictsComputed: false }));
    expect(deps.progress.while).toHaveBeenCalledOnce();
    expect(closed).toBe(false);

    client.emit(statusEvent());
    await handedOver();
    expect(closed).toBe(true);
  });

  it.each([
    ['disconnected', 'mEdit is disconnected.'],
    ['stopped', 'mEdit is stopped.'],
  ] as const)('names the tree unreachable when mEdit is %s, and re-reads its facts', (status, reason) => {
    const { client, deps } = followed();

    client.setStatus(status);

    expect(deps.facts.unreachable).toHaveBeenCalledWith(reason);
    expect(deps.facts.refresh).toHaveBeenCalledOnce();
  });

  it.each(['starting', 'running'] as const)('leaves the tree to the reconcile while mEdit is %s', (status) => {
    const { client, deps } = followed();

    client.setStatus(status);

    expect(deps.facts.unreachable).not.toHaveBeenCalled();
    expect(deps.facts.refresh).not.toHaveBeenCalled();
  });

  it('hears nothing once disposed', () => {
    const { client, deps, followed: following } = followed();

    following.dispose();
    client.emit(statusEvent({ state: 'Reconciling', conflictsComputed: false }));
    client.setStatus('disconnected');

    expect(deps.progress.while).not.toHaveBeenCalled();
    expect(deps.facts.unreachable).not.toHaveBeenCalled();
  });
});

describe('a reconcile that reached Ready, reported and then applied whoever started it', () => {
  const badFailure = { name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' };

  it('registers the source mods\' repositories', async () => {
    const { client, deps, handedOver } = followed();

    client.emit(statusEvent());
    await handedOver();

    expect(deps.registerRepositories).toHaveBeenCalledOnce();
  });

  it('warns and logs a skipped plugin by name', async () => {
    const { client, deps, handedOver } = followed();

    client.emit(statusEvent({ failures: [badFailure] }));
    await handedOver();

    expect(deps.reporter.reports.map((report) => report.severity)).toEqual(['warning']);
    expect(deps.reporter.reports[0]?.message).toContain('Bad.esp');
    expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('Bad.esp'));
  });

  it('hands the tree the status\'s own failures and counts the snapshot\'s total in the log', async () => {
    const { client, deps, handedOver } = followed();

    client.emit(statusEvent({ totalPlugins: 42, failures: [badFailure] }));
    await handedOver();

    expect(deps.facts.reconciled).toHaveBeenCalledWith([badFailure]);
    expect(deps.log).toHaveBeenCalledWith('info', '[loadOrder] applying reconciled load order to tree: 0 in the load order, 1 failed, of 42 plugins');
  });
});
