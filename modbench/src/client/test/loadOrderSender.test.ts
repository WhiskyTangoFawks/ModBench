import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LaunchOutcome, LoadOrderOutcome, LoadOrderSnapshot } from '..';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import { settled } from '../../test/eventually';
import { answered } from './healthAnswer';
import { backendProcesses, fakeMEdit, jsonResponse, noContent } from './fakeMEdit';

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };
const SIGNAL_WAIT_CAP_MS = 10_000;

function snapshot(name: string): LoadOrderSnapshot {
  return {
    plugins: [{ name, path: `/game/Data/${name}`, origin: DATA_DIRECTORY_ORIGIN, provider: { kind: 'Game' }, line: null, lineNamesIt: false, archives: [], stringsFiles: [] }],
    active: [{ name, origin: DATA_DIRECTORY_ORIGIN }],
    loadedWithNoLine: [],
    archives: [], listedArchives: [],
    stringsFiles: [],
    places: [],
    dataFolder: '/game/Data',
    instanceRoot: '/instance',
    gameRelease: 'Fallout4',
    stringsLanguage: 'English',
  };
}

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settledYet = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { setImmediate(() => { resolve(false); }); })]);

const outcomeOf = (sent: LoadOrderOutcome): string => sent.outcome;

type PutAnswer = () => Promise<Response>;
type Child = ReturnType<ReturnType<typeof backendProcesses>['spawn']>;

interface LoadOrderOptions {
  health?: () => Promise<boolean>;
  startThrows?: string;
  stopThrows?: string;
  freePort?: () => Promise<number>;
  pollTimeoutMs?: number;
}

function throwingOnError(child: Child, message: string): Child {
  const on = child.on.bind(child);
  child.on = (...args: Parameters<Child['on']>) => {
    if (args[0] === 'error') throw new Error(message);
    return on(...args);
  };
  return child;
}

function loadOrderMEdit({ health = () => Promise.resolve(true), startThrows, stopThrows, freePort, pollTimeoutMs }: LoadOrderOptions = {}) {
  const history: string[] = [];
  const puts: unknown[] = [];
  const signals: unknown[] = [];
  let version = 0;
  let status = { state: 'None', totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0, validating: false };
  const applies: PutAnswer = () => {
    version += 1;
    status = { ...status, state: 'Ready', conflictsComputed: true, version };
    return Promise.resolve(jsonResponse(200, { applied: true, version }));
  };
  let answers: PutAnswer[] = [applies];
  let answerSignal: () => Promise<Response> = noContent;
  const processes = backendProcesses();
  const spawn = (executable: string, args: string[]) => {
    history.push('start');
    const child = processes.spawn(executable, args);
    child.stdin.on('finish', () => { history.push('stop'); });
    if (stopThrows !== undefined) child.stdin.end = () => { throw new Error(stopThrows); };
    return startThrows === undefined ? child : throwingOnError(child, startThrows);
  };
  const mEdit = fakeMEdit({
    processes,
    backend: { spawn, checkHealth: async () => answered(await health()), ...(freePort && { freePort }), ...(pollTimeoutMs !== undefined && { pollTimeoutMs }) },
    routes: [
      ['/load-order/status', () => Promise.resolve(jsonResponse(200, status))],
      ['/load-order', async (request) => {
        history.push('put');
        puts.push(JSON.parse(await request.text()));
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        const aborted = new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => { reject(new DOMException('This operation was aborted', 'AbortError')); });
        });
        return Promise.race([answer?.() ?? applies(), aborted]);
      }],
      ['/signal-change', async (request) => {
        history.push('signalChange');
        signals.push(JSON.parse(await request.text()));
        return answerSignal();
      }],
    ],
  });
  return {
    ...mEdit, history, puts, signals, applies,
    /** Each PUT takes the next answer, and the last answers every PUT after it. */
    answerPuts: (...next: PutAnswer[]) => { answers = next; },
    answerSignals: (answer: () => Promise<Response>) => { answerSignal = answer; },
    holdPuts: () => {
      const held = pending<undefined>();
      answers = [() => held.promise.then(() => jsonResponse(200, { applied: true, version: 99 }))];
      return { answer: () => { held.resolve(undefined); } };
    },
  };
}

async function running(options: LoadOrderOptions = {}) {
  const mEdit = loadOrderMEdit(options);
  await mEdit.start();
  return mEdit;
}

function heldLaunch() {
  const up = pending<boolean>();
  return { health: () => up.promise, comeUp: () => { up.resolve(true); } };
}

describe('a snapshot while mEdit is not running', () => {
  it('shares the launch already under way, starting mEdit once', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });

    void mEdit.client.start();
    const sent = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    launch.comeUp();

    await expect(sent.then(outcomeOf)).resolves.toBe('applied');
    expect(mEdit.history).toEqual(['start', 'put']);
  });

  it('answers backendFailed when mEdit does not come up, and takes the half-started mEdit down', async () => {
    const mEdit = loadOrderMEdit({ health: () => Promise.resolve(false), pollTimeoutMs: 0 });

    void mEdit.client.start();
    await expect(mEdit.client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);

    await settled(() => { expect(mEdit.history).toEqual(['start', 'stop']); });
    expect(mEdit.client.status).toBe('stopped');
  });

  it('answers backendFailed when the launch throws', async () => {
    const mEdit = loadOrderMEdit({ freePort: () => Promise.reject(new Error('no port')) });

    void mEdit.client.start();
    await expect(mEdit.client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);
  });

  it('never rejects the launch with the extension, and leaves mEdit stopped when it fails', async () => {
    const mEdit = loadOrderMEdit({ freePort: () => Promise.reject(new Error('no port')) });

    await expect(mEdit.client.start()).resolves.toBeUndefined();

    expect(mEdit.client.status).toBe('stopped');
  });
});

describe('the newest snapshot lands', () => {
  it('sends only the newest of the snapshots that piled up while mEdit started', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });

    void mEdit.client.start();
    const first = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    const second = mEdit.client.sendLoadOrder(snapshot('B.esp'));
    launch.comeUp();

    expect(await first).toEqual(ABANDONED);
    expect(outcomeOf(await second)).toBe('applied');
    expect(mEdit.puts).toEqual([snapshot('B.esp')]);
  });

  it('turns a snapshot arriving mid-send into exactly one more send after it, never a concurrent one', async () => {
    const mEdit = await running();
    const released = pending<undefined>();
    mEdit.answerPuts(() => released.promise.then(mEdit.applies), mEdit.applies);

    const first = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    const second = mEdit.client.sendLoadOrder(snapshot('B.esp'));
    const third = mEdit.client.sendLoadOrder(snapshot('C.esp'));
    await settled(() => { expect(mEdit.puts).toEqual([snapshot('A.esp')]); });

    released.resolve(undefined);

    expect((await Promise.all([first, second, third])).map(outcomeOf)).toEqual(['applied', 'abandoned', 'applied']);
    expect(mEdit.puts).toEqual([snapshot('A.esp'), snapshot('C.esp')]);
  });

  it('answers a put that throws as failed, and the next send is still served', async () => {
    const mEdit = await running();
    mEdit.answerPuts(() => Promise.reject(new Error('boom')));

    await expect(mEdit.client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual({
      outcome: 'failed', message: 'Failed to send the load order — boom',
    });

    mEdit.answerPuts(mEdit.applies);
    await expect(mEdit.client.sendLoadOrder(snapshot('B.esp')).then(outcomeOf)).resolves.toBe('applied');
  });

  it('answers latest with the outcome of the snapshot parked behind a put in flight', async () => {
    const mEdit = await running();
    const released = pending<undefined>();
    mEdit.answerPuts(() => released.promise.then(() => jsonResponse(500, { detail: 'no' })), mEdit.applies);
    void mEdit.client.sendLoadOrder(snapshot('A.esp'));
    void mEdit.client.sendLoadOrder(snapshot('B.esp'));
    const latest = mEdit.client.latestLoadOrder();

    released.resolve(undefined);

    await expect(latest.then((sent) => sent?.outcome)).resolves.toBe('applied');
    expect(mEdit.puts).toEqual([snapshot('A.esp'), snapshot('B.esp')]);
  });

  it('answers latest with nothing before any send', async () => {
    await expect((await running()).client.latestLoadOrder()).resolves.toBeUndefined();
  });
});

describe('a send during a disconnect', () => {
  it('answers abandoned, never a killed backend as a network failure', async () => {
    const mEdit = await running();
    mEdit.holdPuts();

    const sent = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await settled(() => { expect(mEdit.puts).toHaveLength(1); });
    await mEdit.exit();

    expect(await sent).toEqual(ABANDONED);
  });
});

describe('a reconnect', () => {
  it('puts nothing again itself, the flow handing the load order once mEdit is found to hold none', async () => {
    const mEdit = await running();
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));

    await mEdit.reopen();
    await mEdit.client.latestLoadOrder();

    expect(mEdit.puts).toEqual([snapshot('A.esp')]);
  });

  it('tells a snapshot that was waiting at the reopen to its sender alone, never as a resend', async () => {
    const mEdit = await running();
    const released = pending<undefined>();
    mEdit.answerPuts(() => released.promise.then(mEdit.applies), () => Promise.resolve(jsonResponse(500, { detail: 'no' })));
    const older = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await settled(() => { expect(mEdit.puts).toHaveLength(1); });
    const newer = mEdit.client.sendLoadOrder(snapshot('B.esp'));

    await mEdit.reopen();
    released.resolve(undefined);

    await expect(older.then(outcomeOf)).resolves.toBe('applied');
    await expect(newer).resolves.toEqual({ outcome: 'failed', message: 'Failed to send the load order — no' });
    expect(mEdit.puts).toEqual([snapshot('A.esp'), snapshot('B.esp')]);
  });

  it('puts nothing before any snapshot was handed', async () => {
    const mEdit = await running();

    await mEdit.reopen();
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));

    expect(mEdit.puts).toEqual([snapshot('A.esp')]);
  });
});

describe('a stop during a send', () => {
  it('drops the snapshot still waiting for mEdit to start, so nothing is queued for the next process', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });
    void mEdit.client.start();
    const sent = mEdit.client.sendLoadOrder(snapshot('A.esp'));

    await mEdit.client.stop();
    launch.comeUp();

    expect(await sent).toEqual(ABANDONED);
    expect(mEdit.puts).toEqual([]);
  });

  it('answers a launch that the stop cut short as abandoned, never as mEdit failing to start', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });
    void mEdit.client.start();
    const sent = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await settled(() => { expect(mEdit.history).toContain('start'); });

    await mEdit.client.stop();
    launch.comeUp();

    expect(await sent).toEqual(ABANDONED);
    expect(mEdit.history).toEqual(['start', 'stop']);
  });

  it('launches nothing for a snapshot the stop abandoned before its launch began', async () => {
    const mEdit = loadOrderMEdit();

    const sent = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await mEdit.client.stop();

    expect(await sent).toEqual(ABANDONED);
    expect(mEdit.history).toEqual([]);
  });
});

describe('each launch, announced as it begins', () => {
  const launchesOf = (mEdit: ReturnType<typeof loadOrderMEdit>) => {
    const launches: Promise<LaunchOutcome>[] = [];
    mEdit.client.onLaunch((launched) => { launches.push(launched); });
    return launches;
  };

  it('announces the launch with the extension, and a send during it launches nothing more', async () => {
    const mEdit = loadOrderMEdit();
    const launches = launchesOf(mEdit);

    void mEdit.client.start();
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));

    expect(launches).toHaveLength(1);
  });

  const notUp = { health: () => Promise.resolve(false), pollTimeoutMs: 0 };

  it.each([
    ['the launch threw', { freePort: () => Promise.reject(new Error('no port')) }, { outcome: 'failed', error: 'no port' }],
    ['mEdit did not come up', notUp, { outcome: 'failed' }],
    ['taking the half-started mEdit down threw', { ...notUp, stopThrows: 'would not die' }, { outcome: 'failed', error: 'would not die' }],
    ['the launch and taking it down both threw', { startThrows: 'no port', stopThrows: 'would not die' }, { outcome: 'failed', error: 'no port; would not die' }],
  ] as const)('comes to failed carrying what went wrong when %s', async (_name, options, expected) => {
    const mEdit = loadOrderMEdit(options);
    const launches = launchesOf(mEdit);

    await mEdit.client.start();

    await expect(launches[0]).resolves.toEqual(expected);
  });

  it('comes to stopped when a stop cut it short', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });
    const launches = launchesOf(mEdit);
    void mEdit.client.start();
    await settled(() => { expect(mEdit.history).toContain('start'); });

    await mEdit.client.stop();
    launch.comeUp();

    await expect(launches[0]).resolves.toEqual({ outcome: 'stopped' });
  });

  it('announces no reconnect, the process having kept running', async () => {
    const mEdit = await running();
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));
    const launches = launchesOf(mEdit);

    await mEdit.reopen();
    await mEdit.client.latestLoadOrder();

    expect(launches).toHaveLength(0);
  });
});

describe('after a launch that failed', () => {
  it('answers every snapshot backendFailed and launches nothing again', async () => {
    const mEdit = loadOrderMEdit({ health: () => Promise.resolve(false), pollTimeoutMs: 0 });
    await mEdit.client.start();
    const launches: unknown[] = [];
    mEdit.client.onLaunch((launched) => launches.push(launched));

    await expect(mEdit.client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);
    await expect(mEdit.client.sendLoadOrder(snapshot('B.esp'))).resolves.toEqual(BACKEND_FAILED);

    expect(launches).toEqual([]);
    expect(mEdit.history).toEqual(['start', 'stop']);
  });
});

describe('mEdit exiting', () => {
  const exitsOf = (mEdit: ReturnType<typeof loadOrderMEdit>) => {
    const exits: string[] = [];
    mEdit.client.onExit(() => exits.push('exit'));
    return exits;
  };

  it('abandons the put in flight, and answers the snapshot waiting behind it backendFailed', async () => {
    const mEdit = await running();
    mEdit.holdPuts();
    const first = mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await settled(() => { expect(mEdit.puts).toHaveLength(1); });
    const second = mEdit.client.sendLoadOrder(snapshot('B.esp'));

    await mEdit.exit();

    expect(await first).toEqual(ABANDONED);
    expect(await second).toEqual(BACKEND_FAILED);
  });

  it('is not heard for a launch that failed, the launch telling it', async () => {
    const mEdit = loadOrderMEdit({ health: () => Promise.resolve(false), pollTimeoutMs: 0 });
    const exits = exitsOf(mEdit);

    await mEdit.client.start();

    expect(exits).toEqual([]);
  });

  it('is not heard for a stop', async () => {
    const mEdit = await running();
    const exits = exitsOf(mEdit);

    await mEdit.client.stop();

    expect(exits).toEqual([]);
  });
});

describe('a change signalled', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('is sent once the snapshot handed before it has answered, so mEdit checks the load order it holds then', async () => {
    const mEdit = await running();
    const { answer } = mEdit.holdPuts();
    void mEdit.client.sendLoadOrder(snapshot('A.esp'));

    void mEdit.client.signalChange([]);
    await settled(() => { expect(mEdit.history).toEqual(['start', 'put']); });
    answer();

    await settled(() => { expect(mEdit.history).toEqual(['start', 'put', 'signalChange']); });
  });

  it('is sent within a bounded time while the snapshots handed before it go unanswered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const mEdit = await running();
    mEdit.holdPuts();
    void mEdit.client.sendLoadOrder(snapshot('A.esp'));
    void mEdit.client.sendLoadOrder(snapshot('B.esp'));

    void mEdit.client.signalChange([]);
    await vi.advanceTimersByTimeAsync(SIGNAL_WAIT_CAP_MS - 1);
    expect(mEdit.history).toEqual(['start', 'put']);
    await vi.advanceTimersByTimeAsync(1);

    expect(mEdit.history).toEqual(['start', 'put', 'signalChange']);
  });

  it('waits for the snapshot handed before it even when it was owed more than the cap before mEdit ran', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });
    const { answer } = mEdit.holdPuts();
    void mEdit.client.start();
    void mEdit.client.sendLoadOrder(snapshot('A.esp'));
    void mEdit.client.signalChange([]);
    await vi.advanceTimersByTimeAsync(SIGNAL_WAIT_CAP_MS + 1);

    launch.comeUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(mEdit.history).toEqual(['start', 'put']);
    answer();

    await vi.advanceTimersByTimeAsync(0);
    expect(mEdit.history).toEqual(['start', 'put', 'signalChange']);
  });

  it('folds the signals handed while one is in flight into one more', async () => {
    const mEdit = await running();
    const released = pending<undefined>();
    mEdit.answerSignals(() => released.promise.then(noContent));

    void mEdit.client.signalChange([]);
    void mEdit.client.signalChange([]);
    void mEdit.client.signalChange([]);
    await settled(() => { expect(mEdit.history).toEqual(['start', 'signalChange']); });
    released.resolve(undefined);
    await settled(() => { expect(mEdit.history).toEqual(['start', 'signalChange', 'signalChange']); });
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));

    expect(mEdit.history).toEqual(['start', 'signalChange', 'signalChange', 'put']);
  });

  it.each([
    { handed: [['/a.esp'], ['/b.esp', '/a.esp']], folded: ['/a.esp', '/b.esp'] },
    { handed: [['/a.esp'], [], ['/b.esp']], folded: [] },
  ])('folds the paths of the signals handed while one is in flight, and a signal that names none checks the disk: $handed', async ({ handed, folded }) => {
    const mEdit = await running();
    const released = pending<undefined>();
    mEdit.answerSignals(() => released.promise.then(noContent));
    void mEdit.client.signalChange(['/first.esp']);
    await settled(() => { expect(mEdit.signals).toHaveLength(1); });

    for (const paths of handed) void mEdit.client.signalChange(paths);
    released.resolve(undefined);

    await settled(() => { expect(mEdit.signals).toEqual([{ paths: ['/first.esp'] }, { paths: folded }]); });
  });

  it('waits for mEdit to run', async () => {
    const mEdit = loadOrderMEdit();

    void mEdit.client.signalChange([]);
    expect(mEdit.history).toEqual([]);
    await mEdit.start();

    await settled(() => { expect(mEdit.history).toEqual(['start', 'signalChange']); });
  });

  it('follows a reconnect, since the process behind the stream may not have checked the disk', async () => {
    const mEdit = await running();
    await mEdit.client.sendLoadOrder(snapshot('A.esp'));

    await mEdit.reopen();

    await settled(() => { expect(mEdit.history).toEqual(['start', 'put', 'signalChange']); });
  });
});

describe('the promise a change signal returns', () => {
  async function behindAnUnansweredPut() {
    const mEdit = await running();
    const { answer } = mEdit.holdPuts();
    void mEdit.client.sendLoadOrder(snapshot('A.esp'));
    await settled(() => { expect(mEdit.puts).toHaveLength(1); });
    return { ...mEdit, answer };
  }

  it('settles at once while mEdit is not running, and the signal stays owed for the next run', async () => {
    const mEdit = await running();
    await mEdit.exit();

    await expect(settledYet(mEdit.client.signalChange([]))).resolves.toBe(true);
    expect(mEdit.signals).toEqual([]);

    await mEdit.start();
    await settled(() => { expect(mEdit.signals).toEqual([{ paths: [] }]); });
  });

  it('waits while mEdit starts, posts the signal once it runs, and settles when it goes instead', async () => {
    const launch = heldLaunch();
    const mEdit = loadOrderMEdit({ health: launch.health });
    void mEdit.client.start();
    const waiting = mEdit.client.signalChange([]);
    await expect(settledYet(waiting)).resolves.toBe(false);
    expect(mEdit.signals).toEqual([]);

    launch.comeUp();
    await settled(() => { expect(mEdit.signals).toEqual([{ paths: [] }]); });
    await waiting;

    const next = loadOrderMEdit({ health: heldLaunch().health });
    void next.client.start();
    const never = next.client.signalChange([]);
    await settled(() => { expect(next.spawned).toHaveLength(1); });
    next.spawned[0]?.exit(1);
    await expect(never.then(() => true)).resolves.toBe(true);
  });

  it('is one for the signals folded into one, and waits for that signal', async () => {
    const { client, signals, answer } = await behindAnUnansweredPut();

    const all = Promise.all([client.signalChange(['/a.esp']), client.signalChange(['/b.esp']), client.signalChange([])]);
    await expect(settledYet(all)).resolves.toBe(false);
    answer();
    await all;

    expect(signals).toEqual([{ paths: [] }]);
  });

  it('settles when mEdit goes before the signal is posted, and the signal stays owed', async () => {
    const mEdit = await behindAnUnansweredPut();
    const waiting = mEdit.client.signalChange([]);

    await mEdit.exit();

    await expect(settledYet(waiting)).resolves.toBe(true);
    expect(mEdit.signals).toEqual([]);
  });

  it('settles when the client stops before the signal is posted', async () => {
    const mEdit = await behindAnUnansweredPut();
    const waiting = mEdit.client.signalChange([]);

    await mEdit.client.stop();

    await expect(settledYet(waiting)).resolves.toBe(true);
    expect(mEdit.signals).toEqual([]);
  });
});

describe('a stop', () => {
  it('is the end: a snapshot or a start after it launches nothing, and announces none', async () => {
    const mEdit = await running();
    await mEdit.client.stop();
    const launches: unknown[] = [];
    mEdit.client.onLaunch((launched) => launches.push(launched));

    await expect(mEdit.client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(ABANDONED);
    await mEdit.client.start();

    expect(mEdit.history).toEqual(['start', 'stop']);
    expect(launches).toEqual([]);
  });
});
