import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { clientHoldingNothing, indexedOver, pluginsOf, pluginsOver } from './pluginsOver';
import type { PluginMetadata } from '../../client';
import { EMPTY_SNAPSHOT, pluginMetadataFixture } from '../../client/test/fixtures';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { changeNamesPlugin, holdsLoadOrder, holdsNoLoadOrder, type Holds } from '../../client/test/says';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled } from '../../test/eventually';
import { present } from '../../ports/present';

const A = { name: 'A.esp', origin: 'ModA' };
const B = { name: 'B.esp', origin: 'ModA' };
const BAD = { name: 'Bad.esp', origin: 'ModA', reason: 'RACE parse' };
const OPENS = 'opens on modbench.pluginListTree';
const HELD_ELSEWHERE = { kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' } as const;
const FAILED = (message: string) => ({ kind: 'failed', message }) as const;
const READY = '$(check) mEdit: Ready (2 plugins)';
const RUNNING = '$(plug) mEdit: Running';
const FAILED_TO_LOAD = (message: string) => `Failed to load: ${message}`;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ready = (version = 1): Holds => ({ version, indexed: [A, B] });
const tick = (version = 1, over: Holds = {}): Holds => ({ version, settled: false, total: 2, ...over });

function following() {
  const registered = vi.fn();
  const client = clientHoldingNothing();
  client.setStatus('running');
  client.setQueryAnswer('getPlugins', [A, B].map(pluginMetadataFixture));
  const made = pluginsOver({
    client, value: instanceValueFixture({ plugins: pluginsOf(['A.esp', 'B.esp']) }),
    registerRepositories: () => { registered(); return Promise.resolve(); },
  });
  const lines = (start: string) => made.output.filter((line) => line.startsWith(start));
  let release = (): void => undefined;
  return {
    ...made, registered, reporter: made.reporter('loadOrder'),
    tell: async (holds?: Holds) => { if (holds === undefined) holdsNoLoadOrder(client); else holdsLoadOrder(client, holds); await settle(); },
    handOffs: () => lines('[loadOrder] applying reconciled load order to tree'),
    failures: () => lines('[loadOrder] Indexing failed'),
    statusBar: () => present(host.statusBarItems.at(-1), 'the status bar item').text,
    beneath: async (name: string) => Promise.all((await made.rows((await made.pluginRows())(name))).map(async (row) => (await made.item(row)).label)),
    holdHandOff: () => {
      client.setQueryAnswerOnce('getPlugins', new Promise<PluginMetadata[]>((resolve) => { release = () => { resolve([]); }; }));
      return () => { release(); };
    },
    tellEach: async (heard: readonly Holds[]) => { for (const holds of heard) { holdsLoadOrder(client, holds); await settle(); } },
    put: (version: number) => made.shown.editingInPluginsView.onPut({ sent: true, snapshot: EMPTY_SNAPSHOT, outcome: { outcome: 'applied', version } }),
  };
}

const handedOver = async (made: ReturnType<typeof following>, times: number) => {
  await settled(() => { expect(made.handOffs()).toHaveLength(times); });
};

describe('the Plugins view\'s progress and rows follow the record index status, whoever started the reconcile', () => {
  it('shows a rebuild-started refill: rows reset to still indexing, progress while it runs, closed on Ready', async () => {
    const made = following();
    await made.tell(ready(1));
    await handedOver(made, 1);

    await made.tell(tick(2, { indexed: [A] }));
    expect(await made.beneath('B.esp')).toEqual(['Still indexing…']);
    expect(host.progress).toEqual([OPENS]);

    await made.tell(ready(2));
    await handedOver(made, 2);
    expect(host.progress).toEqual([OPENS, 'closes']);
  });

  it('keeps the progress open from a validation the record index announces until it settles, opening one however many ticks it publishes', async () => {
    const made = following();
    await made.tell(ready(1));
    await handedOver(made, 1);

    await made.tell(tick(1, { indexed: [A, B] }));
    await made.tell(tick(1, { indexed: [A] }));
    expect(host.progress).toEqual([OPENS]);

    await made.tell(ready(1));
    await settled(() => { expect(host.progress).toEqual([OPENS, 'closes']); });
  });

  it('hands over a Ready answering a newer version, with no reconcile seen in progress, and opens no progress', async () => {
    const made = following();
    await made.tell(ready(1));
    await handedOver(made, 1);

    await made.tell(ready(2));

    await handedOver(made, 2);
    expect(host.progress).toEqual([]);
  });

  it.each([
    ['heard twice while its hand-off runs, as a put\'s own answer is heard beside the stream\'s', (made: ReturnType<typeof following>) => made.holdHandOff()],
    ['repeating a version already handed over', () => () => undefined],
  ])('hands over a Ready %s once', async (_case, hold) => {
    const made = following();
    const release = hold(made);
    await made.tell(ready(1));
    await made.tell(ready(1));
    release();
    await made.tell(ready(2));

    await handedOver(made, 2);
    await settle();
    expect(made.handOffs()).toHaveLength(2);
  });

  it('closes the progress on a refusal, handing nothing over, and hands the refusal to the rows and the status bar', async () => {
    const made = following();
    await made.tell(tick(1));

    await made.tell(tick(1, { refusal: HELD_ELSEWHERE }));

    await settled(() => { expect(host.progress).toEqual([OPENS, 'closes']); });
    expect(made.handOffs()).toEqual([]);
    expect(await made.beneath('A.esp')).toEqual([FAILED_TO_LOAD(HELD_ELSEWHERE.message)]);
    expect(made.statusBar()).toBe(RUNNING);
  });

  it.each<[string, Holds[], string[]]>([
    ['once, however often its status is heard again', [tick(1), tick(1, { refusal: FAILED('boom') }), tick(1, { refusal: FAILED('boom') })], ['boom']],
    ['met during a check, though a check leaves the version where it was', [ready(1), tick(1, { refusal: FAILED('boom') })], ['boom']],
    ['again when it recurs after the index recovered', [tick(1, { refusal: FAILED('boom') }), ready(1), tick(1, { refusal: FAILED('boom') })], ['boom', 'boom']],
    ['again when a later reconcile fails with it, nothing heard between', [tick(1, { refusal: FAILED('boom') }), tick(2, { refusal: FAILED('boom') })], ['boom', 'boom']],
    ['that differs at the same version', [tick(1, { refusal: FAILED('first') }), tick(1, { refusal: FAILED('second') })], ['first', 'second']],
    ['again when a reconcile in progress was heard between', [tick(1, { refusal: FAILED('boom') }), tick(1), tick(1, { refusal: FAILED('boom') })], ['boom', 'boom']],
  ])('writes a failed index to the Output %s', async (_case, heard, written) => {
    const made = following();

    await made.tellEach(heard);

    expect(made.failures()).toEqual(written.map((message) => `[loadOrder] Indexing failed: ${message}`));
  });

  it('ends a put\'s wait at once for a version already handed over', async () => {
    const made = following();
    await made.tell(ready(2));
    await handedOver(made, 1);

    await made.put(1);
  });
});

describe('the refill a rebuild starts, which the rebuild\'s 204 answers before it has read anything', () => {
  it('ends the wait at the refill\'s Ready, not before it', async () => {
    const made = following();
    await made.tell(ready(1));
    await handedOver(made, 1);
    let refilled = false;
    const ended = made.shown.nextRefill().ended.then(() => { refilled = true; });

    await made.tell(ready(1));
    await made.tell(tick(2));
    expect(refilled).toBe(false);

    await made.tell(ready(2));
    await ended;
  });

  it('ends the wait at once when the record index held nothing to refill', async () => {
    const made = following();

    await made.shown.nextRefill().ended;
  });

  it('ends the wait when a refusal ends the refill', async () => {
    const made = following();
    await made.tell(ready(1));
    const refilled = made.shown.nextRefill().ended;

    await made.tell(tick(2));
    await made.tell(tick(2, { refusal: HELD_ELSEWHERE }));

    await refilled;
  });

  it('ends a released wait at once', async () => {
    const made = following();
    await made.tell(ready(1));
    const wait = made.shown.nextRefill();

    wait.release();

    await wait.ended;
  });

  it('hands over the next process\'s first Ready, though its version is one already handed over', async () => {
    const made = following();
    await made.tell(ready(5));
    await handedOver(made, 1);

    await made.tell(undefined);
    await made.tell(ready(1));

    await handedOver(made, 2);
  });

  it('closes the progress, ends every wait and gives the status bar back to mEdit\'s own state when the record index is dropped', async () => {
    const made = following();
    await made.tell(ready(1));
    await handedOver(made, 1);
    const refilled = made.shown.nextRefill().ended;
    const put = made.put(9);
    await made.tell(tick(2));

    await made.tell(undefined);

    await Promise.all([refilled, put]);
    expect(host.progress).toEqual([OPENS, 'closes']);
    expect(made.statusBar()).toBe(RUNNING);
  });
});

describe('the Plugins view following mEdit\'s own state', () => {
  it('keeps an earlier Ready off the status bar when a later reconcile\'s hand-off does not land, and reports nothing of its own', async () => {
    const made = following();
    await made.tell(ready(1));
    await settled(() => { expect(made.statusBar()).toBe(READY); });
    made.client.setQueryFailure('getPlugins', { failed: 'unreachable' });

    await made.tell(tick(2));
    await made.tell(ready(2));
    await settle();

    expect(made.statusBar()).toBe(RUNNING);
    expect(made.reporter.reports).toEqual([]);
  });

  it.each([
    ['answers every plugin pending', (client: InMemoryMEditClient) => {
      client.setQueryAnswer('getPluginsIndexing', [{ name: 'A.esp', origin: 'ModA', state: 'Pending', changedOutside: false }]);
    }],
    ['cannot be reached', (client: InMemoryMEditClient) => { client.setQueryFailure('getPluginsIndexing', { failed: 'unreachable' }); }],
  ])('hands a refusal to the rows, and ends a put\'s wait on its version, whichever way the read of the index state goes: it %s', async (_how, script) => {
    const made = following();
    script(made.client);

    made.client.setProgress({ done: 0, total: 2, version: 4, settled: false, refusal: HELD_ELSEWHERE });
    await settle();

    expect(await made.beneath('A.esp')).toEqual([FAILED_TO_LOAD(HELD_ELSEWHERE.message)]);
    await made.put(4);
  });

  it.each([
    ['disconnected', 'mEdit is disconnected.'],
    ['stopped', 'mEdit is stopped.'],
  ] as const)('names a row not held unreachable when mEdit is %s, and reads its facts again', async (status, reason) => {
    const made = following();
    await made.tell(tick(1));
    made.client.calls.length = 0;

    made.client.setStatus(status);
    await settle();

    expect(await made.beneath('A.esp')).toEqual([FAILED_TO_LOAD(reason)]);
    expect(made.client.calls.filter(({ method }) => method === 'getPlugins')).toHaveLength(1);
  });

  it.each(['starting', 'running'] as const)('leaves the rows to the reconcile while mEdit is %s', async (status) => {
    const made = following();

    made.client.setStatus(status);
    await settle();

    expect(await made.beneath('A.esp')).toEqual(['Still indexing…']);
    expect(made.client.calls.filter(({ method }) => method === 'getPlugins')).toEqual([]);
  });

  it('hears nothing once disposed', async () => {
    const made = following();

    made.dispose();
    await made.tell(tick(1));
    made.client.setStatus('disconnected');
    await settle();

    expect(host.progress).toEqual([]);
    expect(made.client.calls.filter(({ method }) => method === 'getPlugins')).toEqual([]);
  });
});

describe('a reconcile that reached Ready, reported and then applied whoever started it', () => {
  it('registers the source mods\' repositories', async () => {
    const made = following();

    await made.tell(ready(1));
    await handedOver(made, 1);

    expect(made.registered).toHaveBeenCalledOnce();
  });

  it('tells a plugin\'s failed read in the Output, with no notification', async () => {
    const made = following();

    await made.tell({ ...ready(1), failures: [BAD] });
    await handedOver(made, 1);

    expect(made.reporter.shownFailures).toEqual([{ severity: 'error', message: 'Failed to read "Bad.esp" (ModA).', detail: 'RACE parse' }]);
    expect(made.reporter.reports).toEqual([]);
  });

  it('notifies naming each plugin whose rows a failed read took away, and why, as its one line in the Output', async () => {
    const made = following();
    made.client.setQueryAnswer('getPlugins', [A, B].map((plugin) => pluginMetadataFixture({ ...plugin, rowsFrom: 'Binary' })));
    await made.tell(ready(1));
    await handedOver(made, 1);
    const failedA = { ...A, reason: 'RACE parse' };
    made.client.setQueryAnswer('getPlugins', [pluginMetadataFixture(B)]);

    await made.tell({ version: 2, indexed: [B], failures: [failedA] });
    await handedOver(made, 2);

    expect(made.reporter.reports).toEqual([{ severity: 'error', message: 'The records of "A.esp" (ModA) do not show: its read failed.', detail: 'RACE parse' }]);
    expect(made.reporter.shownFailures).toEqual([]);
  });

  it('tells in the Output each plugin\'s failed read a refused reconcile heard', async () => {
    const made = following();

    await made.tell(tick(1, { failures: [BAD], refusal: FAILED('the reconcile threw') }));

    expect(made.reporter.shownFailures).toEqual([{ severity: 'error', message: 'Failed to read "Bad.esp" (ModA).', detail: 'RACE parse' }]);
  });

  it('tells a failed read once across a refusal that heard none of it', async () => {
    const made = following();

    await made.tell({ ...ready(1), failures: [BAD] });
    await handedOver(made, 1);
    await made.tell(tick(2, { refusal: FAILED('the reconcile threw') }));
    await made.tell({ ...ready(3), failures: [BAD] });
    await handedOver(made, 2);

    expect(made.reporter.shownFailures).toHaveLength(1);
  });

  it('tells a refusal\'s failure once, when a hand-off superseded under it answers after it', async () => {
    const made = following();
    const release = made.holdHandOff();
    const other = { name: 'Other.esp', origin: 'ModA', reason: 'truncated' };

    await made.tell({ ...ready(1), failures: [BAD] });
    await made.tell(tick(2, { failures: [other], refusal: FAILED('the reconcile threw') }));
    release();
    await settle();
    await made.tell(tick(3, { failures: [other], refusal: FAILED('the reconcile threw') }));

    expect(made.reporter.shownFailures.filter(({ message }) => message.includes('Other.esp'))).toHaveLength(1);
  });

  it('counts what reached the tree against the snapshot\'s total in the Output', async () => {
    const made = following();

    await made.tell({ total: 42, indexed: [A, B], failures: [BAD] });

    await settled(() => { expect(made.handOffs()).toEqual(['[loadOrder] applying reconciled load order to tree: 2 in the load order, 1 failed, of 42 plugins']); });
  });
});

describe('a change that names plugins (ADR-0029, Consequences, bullet 5)', () => {
  it('reads the index state of the plugins it names, and of no other', async () => {
    const { client } = await indexedOver(['A.esp', 'B.esp']);
    client.calls.length = 0;

    changeNamesPlugin(client, A);
    await settle();

    expect(client.calls.filter(({ method }) => method === 'getPluginsIndexing').map(({ args }) => args)).toEqual([[[A]]]);
  });
});
