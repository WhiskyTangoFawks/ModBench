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
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { holdsLoadOrder, holdsNoLoadOrder, type Holds } from '../../client/test/says';

const statusBarText = (): string => present(h.items.at(-1), 'the status bar item').text;

beforeEach(() => { h.items.length = 0; });

const tell = async (client: InMemoryMEditClient, holds: Holds | undefined): Promise<void> => {
  if (holds) holdsLoadOrder(client, holds); else holdsNoLoadOrder(client);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

function followed() {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  const deps = {
    client,
    facts: {
      indexed: vi.fn(), refused: vi.fn(), unreachable: vi.fn(),
      reconciled: vi.fn().mockResolvedValue({ held: 0, active: 0, rowsGone: [] }), refresh: vi.fn().mockResolvedValue(undefined),
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
    deps.facts.reconciled.mockResolvedValue({ held: 5, active: 2, rowsGone: [] });

    await tell(client, { total: 5 });
    await handedOver();

    expect(deps.facts.reconciled).toHaveBeenCalledOnce();
    expect(statusBarText()).toBe('$(check) mEdit: Ready (2 plugins)');
  });

  it('reports nothing when the hand-off did not land', async () => {
    const { client, deps, handedOver } = followed();
    deps.facts.reconciled.mockResolvedValue(undefined);

    await tell(client, { total: 2 });
    await handedOver();

    expect(deps.log).not.toHaveBeenCalledWith('error', expect.anything());
    expect(deps.reporter.reports).toEqual([]);
  });

  it('gives Ready back to mEdit\'s own state when the record index is dropped', async () => {
    const { client, handedOver } = followed();
    await tell(client, { total: 2 });
    await handedOver();

    await tell(client, undefined);

    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it('keeps an earlier Ready off the status bar when a later reconcile\'s hand-off does not land', async () => {
    const { client, deps, followed: following } = followed();
    deps.facts.reconciled.mockResolvedValue({ held: 2, active: 2, rowsGone: [] });
    await tell(client, { total: 2 });
    await following.narrator.settled(1);
    deps.facts.reconciled.mockResolvedValue(undefined);

    await tell(client, { settled: false, total: 2, version: 2 });
    await tell(client, { total: 2, version: 2 });
    await following.narrator.settled(2);

    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it('hands a refusal to the tree, and gives the status bar back to mEdit\'s own state', async () => {
    const { client, deps, handedOver } = followed();
    await tell(client, { total: 2 });
    await handedOver();

    await tell(client, { settled: false, total: 2, refusal: { kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' }, version: 2 });

    expect(deps.facts.refused).toHaveBeenCalledWith({ kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' });
    expect(statusBarText()).toBe('$(plug) mEdit: Running');
  });

  it.each([
    ['answers every plugin pending', (client: InMemoryMEditClient) => { client.setQueryAnswer('getPluginsIndexing', [{ name: 'A.esp', origin: 'SomeMod', state: 'Pending', changedOutside: false }]); }],
    ['cannot be reached', (client: InMemoryMEditClient) => { client.setQueryFailure('getPluginsIndexing', { failed: 'unreachable' }); }],
  ])('hands a refusal to the tree, and ends the wait on its version, whichever way the read of the index state goes: it %s', async (_how, script) => {
    const { client, deps, followed: following } = followed();
    script(client);

    await tell(client, { settled: false, version: 4, total: 2, refusal: { kind: 'heldElsewhere', message: 'Another window holds it.' } });

    expect(deps.facts.refused).toHaveBeenCalledWith({ kind: 'heldElsewhere', message: 'Another window holds it.' });
    await expect(following.narrator.settled(4)).resolves.toBeUndefined();
  });

  it('runs the view\'s progress while the record index fills, and closes it on Ready', async () => {
    const { client, deps, handedOver } = followed();
    let closed = false;
    deps.progress.while.mockImplementation((work: () => Promise<void>) => work().then(() => { closed = true; }));

    await tell(client, { settled: false, total: 2 });
    expect(deps.progress.while).toHaveBeenCalledOnce();
    expect(closed).toBe(false);

    await tell(client, { total: 2 });
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

  it('hears nothing once disposed', async () => {
    const { client, deps, followed: following } = followed();

    following.dispose();
    await tell(client, { settled: false, total: 2 });
    client.setStatus('disconnected');

    expect(deps.progress.while).not.toHaveBeenCalled();
    expect(deps.facts.unreachable).not.toHaveBeenCalled();
  });
});

describe('a reconcile that reached Ready, reported and then applied whoever started it', () => {
  const badFailure = { name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' };

  it('registers the source mods\' repositories', async () => {
    const { client, deps, handedOver } = followed();

    await tell(client, { total: 2 });
    await handedOver();

    expect(deps.registerRepositories).toHaveBeenCalledOnce();
  });

  it('tells a plugin\'s failed read in the Output, with no notification', async () => {
    const { client, deps, handedOver } = followed();

    await tell(client, { total: 2, failures: [badFailure] });
    await handedOver();

    expect(deps.reporter.shownFailures).toEqual([{ severity: 'error', message: 'Failed to read "Bad.esp" (SomeMod).', detail: 'RACE parse' }]);
    expect(deps.reporter.reports).toEqual([]);
  });

  it('notifies naming each plugin whose rows a failed read took away, and why, as its one line in the Output', async () => {
    const { client, deps, handedOver } = followed();
    deps.facts.reconciled.mockResolvedValue({ held: 1, active: 1, rowsGone: [badFailure] });

    await tell(client, { total: 2, failures: [badFailure] });
    await handedOver();

    expect(deps.reporter.reports).toEqual([{ severity: 'error', message: 'The records of "Bad.esp" (SomeMod) are gone: its read failed.', detail: 'RACE parse' }]);
    expect(deps.reporter.shownFailures).toEqual([]);
  });

  it('tells in the Output each plugin\'s failed read a refused reconcile heard', async () => {
    const { client, deps } = followed();

    await tell(client, { total: 2, failures: [badFailure], refusal: { kind: 'failed', message: 'the reconcile threw' } });

    expect(deps.reporter.shownFailures).toEqual([{ severity: 'error', message: 'Failed to read "Bad.esp" (SomeMod).', detail: 'RACE parse' }]);
  });

  it('tells a failed read once across a refusal that heard none of it', async () => {
    const { client, deps, handedOver, followed: following } = followed();

    await tell(client, { total: 2, failures: [badFailure] });
    await handedOver();
    await tell(client, { version: 2, total: 2, refusal: { kind: 'failed', message: 'the reconcile threw' } });
    await tell(client, { version: 3, total: 2, failures: [badFailure] });
    await following.narrator.settled(3);

    expect(deps.reporter.shownFailures).toHaveLength(1);
  });

  it('tells a refusal\'s failure once, when a hand-off superseded under it answers after it', async () => {
    const { client, deps } = followed();
    let superseded!: (landed: undefined) => void;
    deps.facts.reconciled.mockReturnValue(new Promise((resolve) => { superseded = resolve; }));
    const other = { name: 'Other.esp', origin: 'SomeMod', reason: 'truncated' };
    const refused = { kind: 'failed', message: 'the reconcile threw' } as const;

    await tell(client, { total: 2, failures: [badFailure] });
    await tell(client, { version: 2, total: 2, failures: [other], refusal: refused });
    superseded(undefined);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await tell(client, { version: 3, total: 2, failures: [other], refusal: refused });

    expect(deps.reporter.shownFailures.filter(({ message }) => message.includes('Other.esp'))).toHaveLength(1);
  });

  it('hands the tree the record index\'s own failures and counts the snapshot\'s total in the log', async () => {
    const { client, deps, handedOver } = followed();

    await tell(client, { total: 42, failures: [badFailure] });
    await handedOver();

    expect(deps.facts.reconciled).toHaveBeenCalledWith([badFailure]);
    expect(deps.log).toHaveBeenCalledWith('info', '[loadOrder] applying reconciled load order to tree: 0 in the load order, 1 failed, of 42 plugins');
  });
});
