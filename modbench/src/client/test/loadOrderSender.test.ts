import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from './InMemoryMEditClient';
import type { LaunchOutcome, LoadOrderOutcome, LoadOrderProgress, LoadOrderSnapshot } from '../MEditClient';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };
const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };

function snapshot(name: string): LoadOrderSnapshot {
  return {
    plugins: [{ name, path: `/game/Data/${name}`, origin: DATA_DIRECTORY_ORIGIN, provider: { kind: 'Game' }, line: null, lineNamesIt: false }],
    active: [{ name, origin: DATA_DIRECTORY_ORIGIN }],
    loadedWithNoLine: [],
    gameDirectory: '/game/Data',
    instanceRoot: '/instance',
    gameRelease: 'Fallout4',
  };
}

const sentNames = (client: InMemoryMEditClient) => client.puts().map((put) => put.plugins.map((p) => p.name).join());
const methods = (client: InMemoryMEditClient) => client.calls.map((c) => c.method);

function running(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.answerPuts(() => Promise.resolve(APPLIED));
  client.setStatus('running');
  return client;
}

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function putHeldUntilAborted(client: InMemoryMEditClient): { inFlight: Promise<void>; aborted: () => boolean } {
  const started = pending<undefined>();
  let signal: AbortSignal | undefined;
  client.answerPuts((_snapshot, putSignal) => new Promise<LoadOrderOutcome>((resolve) => {
    signal = putSignal;
    started.resolve(undefined);
    putSignal.addEventListener('abort', () => resolve(ABANDONED));
  }));
  return { inFlight: started.promise, aborted: () => signal?.aborted === true };
}

const resentOf = (client: InMemoryMEditClient) => {
  const resent: { name: string; outcome: LoadOrderOutcome }[] = [];
  client.onLoadOrderResent((sent, outcome) => {
    resent.push({ name: sent.plugins.map((p) => p.name).join(), outcome });
  });
  return resent;
};

const until = async (check: () => boolean): Promise<void> => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('a snapshot while mEdit is not running', () => {
  it.each(['stopped', 'disconnected'] as const)('answers backendFailed when %s, launching nothing', async (status) => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    client.setStatus(status);

    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);

    expect(methods(client)).toEqual([]);
  });

  it('shares the launch already under way, starting mEdit once', async () => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    const launched = pending<undefined>();
    client.answerStart(() => launched.promise.then(() => { client.setStatus('running'); }));

    void client.start();
    const sent = client.sendLoadOrder(snapshot('A.esp'));
    launched.resolve(undefined);

    await expect(sent).resolves.toEqual(APPLIED);
    expect(methods(client)).toEqual(['start', 'put']);
  });

  it('answers backendFailed when mEdit does not come up, and takes the half-started mEdit down', async () => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    client.answerStart(() => { client.setStatus('disconnected'); return Promise.resolve(); });

    void client.start();
    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);

    expect(methods(client)).toEqual(['start', 'stop']);
    expect(client.status).toBe('stopped');
  });

  it('answers backendFailed when the launch throws', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => Promise.reject(new Error('no port')));

    void client.start();
    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);
  });

  it('never rejects the launch with the extension, and leaves mEdit stopped when it fails', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => Promise.reject(new Error('no port')));

    await expect(client.start()).resolves.toBeUndefined();

    expect(client.status).toBe('stopped');
  });
});

describe('the newest snapshot lands', () => {
  it('sends only the newest of the snapshots that piled up while mEdit started', async () => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    const launched = pending<undefined>();
    client.answerStart(() => launched.promise.then(() => { client.setStatus('running'); }));

    void client.start();
    const first = client.sendLoadOrder(snapshot('A.esp'));
    const second = client.sendLoadOrder(snapshot('B.esp'));
    launched.resolve(undefined);

    expect(await first).toEqual(ABANDONED);
    expect(await second).toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['B.esp']);
  });

  it('turns a snapshot arriving mid-send into exactly one more send after it, never a concurrent one', async () => {
    const client = running();
    const released = pending<LoadOrderOutcome>();
    client.answerPuts(() => released.promise);

    const first = client.sendLoadOrder(snapshot('A.esp'));
    const second = client.sendLoadOrder(snapshot('B.esp'));
    const third = client.sendLoadOrder(snapshot('C.esp'));
    expect(sentNames(client)).toEqual(['A.esp']);

    client.answerPuts(() => Promise.resolve(APPLIED));
    released.resolve(APPLIED);

    expect(await first).toEqual(APPLIED);
    expect(await second).toEqual(ABANDONED);
    expect(await third).toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp', 'C.esp']);
  });

  it('answers a put that throws as failed, and the next send is still served', async () => {
    const client = running();
    client.answerPuts(() => Promise.reject(new Error('boom')));

    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual({
      outcome: 'failed', message: 'Failed to send the load order — boom',
    });

    client.answerPuts(() => Promise.resolve(APPLIED));
    await expect(client.sendLoadOrder(snapshot('B.esp'))).resolves.toEqual(APPLIED);
  });

  it('answers latest with the outcome of the snapshot parked behind a put in flight', async () => {
    const client = running();
    const released = pending<LoadOrderOutcome>();
    client.answerPuts(() => released.promise);
    void client.sendLoadOrder(snapshot('A.esp'));
    void client.sendLoadOrder(snapshot('B.esp'));
    const latest = client.latestLoadOrder();

    client.answerPuts(() => Promise.resolve(APPLIED));
    released.resolve(ABANDONED);

    await expect(latest).resolves.toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp', 'B.esp']);
  });

  it('answers latest with nothing before any send', async () => {
    await expect(running().latestLoadOrder()).resolves.toBeUndefined();
  });
});

describe('a send during a disconnect', () => {
  it('answers abandoned, never a killed backend as a network failure', async () => {
    const client = running();
    const { inFlight } = putHeldUntilAborted(client);

    const sent = client.sendLoadOrder(snapshot('A.esp'));
    await inFlight;
    client.disconnected();

    expect(await sent).toEqual(ABANDONED);
  });
});

describe('a reconnect', () => {
  it('puts the newest snapshot again, since the process behind the stream may hold nothing', async () => {
    const client = running();
    const resent = resentOf(client);
    await client.sendLoadOrder(snapshot('A.esp'));

    client.reconnected();
    await until(() => resent.length > 0);

    expect(resent).toEqual([{ name: 'A.esp', outcome: APPLIED }]);
    expect(sentNames(client)).toEqual(['A.esp', 'A.esp']);
  });

  it('puts the snapshot in flight again after it, since it may have landed on the process before', async () => {
    const client = running();
    const resent = resentOf(client);
    const released = pending<LoadOrderOutcome>();
    client.answerPuts(() => released.promise);
    const sent = client.sendLoadOrder(snapshot('A.esp'));

    client.reconnected();
    client.answerPuts(() => Promise.resolve(APPLIED));
    released.resolve(APPLIED);
    await until(() => resent.length > 0);

    expect(await sent).toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp', 'A.esp']);
  });

  it('puts nothing before any snapshot was handed', async () => {
    const client = running();
    const resent = resentOf(client);

    client.reconnected();
    await client.sendLoadOrder(snapshot('A.esp'));

    expect(sentNames(client)).toEqual(['A.esp']);
    expect(resent).toEqual([]);
  });
});

describe('a stop during a send', () => {
  it('abandons the put in flight before it takes mEdit down', async () => {
    const client = running();
    const { inFlight, aborted } = putHeldUntilAborted(client);
    let abortedAtStop: boolean | undefined;
    client.answerStop(() => { abortedAtStop = aborted(); });
    const sent = client.sendLoadOrder(snapshot('A.esp'));
    await inFlight;

    await client.stop();

    expect(await sent).toEqual(ABANDONED);
    expect(abortedAtStop).toBe(true);
  });

  it('drops the snapshot still waiting for mEdit to start, so nothing is queued for the next process', async () => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    const launched = pending<undefined>();
    client.answerStart(() => launched.promise);
    void client.start();
    const sent = client.sendLoadOrder(snapshot('A.esp'));

    await client.stop();
    client.setStatus('running');
    launched.resolve(undefined);

    expect(await sent).toEqual(ABANDONED);
    expect(sentNames(client)).toEqual([]);
  });

  it('answers a launch that the stop cut short as abandoned, never as mEdit failing to start', async () => {
    const client = new InMemoryMEditClient();
    const launched = pending<undefined>();
    client.answerStart(() => launched.promise);
    void client.start();
    const sent = client.sendLoadOrder(snapshot('A.esp'));
    await until(() => methods(client).includes('start'));

    await client.stop();
    launched.resolve(undefined);

    expect(await sent).toEqual(ABANDONED);
    expect(methods(client)).toEqual(['start', 'stop']);
  });

  it('launches nothing for a snapshot the stop abandoned before its launch began', async () => {
    const client = new InMemoryMEditClient();

    const sent = client.sendLoadOrder(snapshot('A.esp'));
    await client.stop();

    expect(await sent).toEqual(ABANDONED);
    expect(methods(client)).toEqual(['stop']);
  });
});

describe('each launch, announced as it begins', () => {
  const launchesOf = (client: InMemoryMEditClient) => {
    const launches: Promise<LaunchOutcome>[] = [];
    client.onLaunch((launched) => { launches.push(launched); });
    return launches;
  };

  it('announces the launch with the extension, and a send during it launches nothing more', async () => {
    const client = new InMemoryMEditClient();
    client.answerPuts(() => Promise.resolve(APPLIED));
    const launches = launchesOf(client);

    void client.start();
    await client.sendLoadOrder(snapshot('A.esp'));

    expect(launches).toHaveLength(1);
  });

  it('carries the launch\'s own error when it threw', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => Promise.reject(new Error('no port')));
    const launches = launchesOf(client);

    await client.start();

    await expect(launches[0]).resolves.toEqual({ outcome: 'failed', error: 'no port' });
  });

  it('comes to failed with no error when mEdit did not come up', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => { client.setStatus('disconnected'); return Promise.resolve(); });
    const launches = launchesOf(client);

    await client.start();

    await expect(launches[0]).resolves.toEqual({ outcome: 'failed' });
  });

  it('comes to stopped when a stop cut it short', async () => {
    const client = new InMemoryMEditClient();
    const launched = pending<undefined>();
    client.answerStart(() => launched.promise);
    const launches = launchesOf(client);
    void client.start();
    await until(() => methods(client).includes('start'));

    await client.stop();
    launched.resolve(undefined);

    await expect(launches[0]).resolves.toEqual({ outcome: 'stopped' });
  });

  it('announces no reconnect, the process having kept running', async () => {
    const client = running();
    await client.sendLoadOrder(snapshot('A.esp'));
    const launches = launchesOf(client);

    client.reconnected();
    await client.latestLoadOrder();

    expect(launches).toHaveLength(0);
  });
});

describe('after a launch that failed', () => {
  it('answers every snapshot backendFailed and launches nothing again', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => { client.setStatus('disconnected'); return Promise.resolve(); });
    await client.start();
    const launches: unknown[] = [];
    client.onLaunch((launched) => launches.push(launched));

    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(BACKEND_FAILED);
    await expect(client.sendLoadOrder(snapshot('B.esp'))).resolves.toEqual(BACKEND_FAILED);

    expect(launches).toEqual([]);
    expect(methods(client)).toEqual(['start', 'stop']);
  });
});

describe('mEdit exiting', () => {
  const exitsOf = (client: InMemoryMEditClient) => {
    const exits: string[] = [];
    client.onExit(() => exits.push('exit'));
    return exits;
  };

  it('is heard once, and nothing starts mEdit again: a snapshot after it answers backendFailed', async () => {
    const client = running();
    await client.sendLoadOrder(snapshot('A.esp'));
    const exits = exitsOf(client);

    client.crashed();

    expect(exits).toHaveLength(1);
    await expect(client.sendLoadOrder(snapshot('B.esp'))).resolves.toEqual(BACKEND_FAILED);
    expect(methods(client)).toEqual(['put']);
  });

  it('abandons the put in flight, and answers the snapshot waiting behind it backendFailed', async () => {
    const client = running();
    const { inFlight } = putHeldUntilAborted(client);
    const first = client.sendLoadOrder(snapshot('A.esp'));
    await inFlight;
    const second = client.sendLoadOrder(snapshot('B.esp'));

    client.crashed();

    expect(await first).toEqual(ABANDONED);
    expect(await second).toEqual(BACKEND_FAILED);
  });

  it('is not heard for a launch that failed, the launch telling it', async () => {
    const client = new InMemoryMEditClient();
    client.answerStart(() => { client.setStatus('disconnected'); return Promise.resolve(); });
    const exits = exitsOf(client);

    await client.start();

    expect(exits).toEqual([]);
  });

  it('is not heard for a stop', async () => {
    const client = running();
    const exits = exitsOf(client);

    await client.stop();

    expect(exits).toEqual([]);
  });
});

describe('a stop', () => {
  it('is the end: a snapshot or a start after it launches nothing, and announces none', async () => {
    const client = running();
    await client.stop();
    const launches: unknown[] = [];
    client.onLaunch((launched) => launches.push(launched));

    await expect(client.sendLoadOrder(snapshot('A.esp'))).resolves.toEqual(ABANDONED);
    await client.start();

    expect(methods(client)).toEqual(['stop']);
    expect(launches).toEqual([]);
  });
});
