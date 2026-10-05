import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../InMemoryMEditClient';
import { createLoadOrderSender, type LoadOrderSnapshot } from '../loadOrderSender';
import type { LoadOrderOutcome, LoadOrderPluginInput, LoadOrderProgress } from '../MEditClient';
import { present } from '../../ports/present';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };
const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };

function snapshot(name: string): LoadOrderSnapshot {
  return {
    plugins: [{ name, path: `/game/Data/${name}`, origin: 'Data', provider: { kind: 'Game' } }],
    active: [{ name, origin: 'Data' }],
    loadedWithNoLine: [],
    gameDirectory: '/game/Data',
    instanceRoot: '/instance',
    gameRelease: 'Fallout4',
  };
}

const puts = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'putLoadOrder');

function isPluginInputs(value: unknown): value is LoadOrderPluginInput[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'name' in v);
}
const sentNames = (client: InMemoryMEditClient) =>
  puts(client).map((c) => {
    const plugins = c.args[0];
    if (!isPluginInputs(plugins)) throw new Error('expected putLoadOrder args[0] to be a plugin array');
    return present(plugins[0], "the snapshot's sole plugin").name;
  });

function attached(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setCommandResult('putLoadOrder', APPLIED);
  client.setStatus('running');
  return client;
}

describe('createLoadOrderSender — connect precedes the first put, the sequencing of the Instance-to-mEdit arrow sitting on the client\'s own side of the seam', () => {
  it('holds a snapshot handed over before the backend attaches, and sends it on connect', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', APPLIED);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    await Promise.resolve();
    expect(puts(client)).toEqual([]);

    client.setStatus('running');

    await expect(sent).resolves.toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp']);
  });

  it('sends straight away once the backend is already attached', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp']);
  });

  it('passes the snapshot whole — plugins, active plugins, game directory, instance root and release', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);

    await sender.send(snapshot('A.esp'));

    const [plugins, active, loadedWithNoLine, gameDirectory, instanceRoot, gameRelease] =
      present(puts(client)[0], "the sole putLoadOrder call").args;
    expect({ plugins, active, loadedWithNoLine, gameDirectory, instanceRoot, gameRelease }).toEqual({
      plugins: snapshot('A.esp').plugins, active: snapshot('A.esp').active, loadedWithNoLine: [], gameDirectory: '/game/Data',
      instanceRoot: '/instance', gameRelease: 'Fallout4',
    });
  });
});

describe('createLoadOrderSender — the last snapshot lands and the superseded ones are dropped', () => {
  it('sends only the newest of the snapshots that piled up before the backend attached', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', APPLIED);
    const sender = createLoadOrderSender(client);

    const first = sender.send(snapshot('A.esp'));
    const second = sender.send(snapshot('B.esp'));
    const third = sender.send(snapshot('C.esp'));
    client.setStatus('running');

    expect(await first).toEqual(ABANDONED);
    expect(await second).toEqual(ABANDONED);
    expect(await third).toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['C.esp']);
  });

  it('a snapshot arriving mid-send becomes exactly one more send after it, never a concurrent one', async () => {
    const client = attached();
    let releaseFirst!: () => void;
    client.setCommandHandler('putLoadOrder', () =>
      new Promise<LoadOrderOutcome>((resolve) => { releaseFirst = () => resolve(APPLIED); }));
    const sender = createLoadOrderSender(client);

    const first = sender.send(snapshot('A.esp'));
    await Promise.resolve();
    const second = sender.send(snapshot('B.esp'));
    const third = sender.send(snapshot('C.esp'));
    expect(sentNames(client)).toEqual(['A.esp']);

    releaseFirst();
    client.setCommandHandler('putLoadOrder', () => Promise.resolve(APPLIED));

    expect(await first).toEqual(APPLIED);
    expect(await second).toEqual(ABANDONED);
    expect(await third).toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp', 'C.esp']);
  });

  it('a send that throws is answered as failed and does not wedge the next one', async () => {
    const client = attached();
    client.setCommandHandler('putLoadOrder', () => Promise.reject(new Error('boom')));
    const sender = createLoadOrderSender(client);

    const failed = await sender.send(snapshot('A.esp'));
    if (failed.outcome !== 'failed') throw new Error('expected outcome: failed');
    expect(failed.message).toContain('boom');

    client.setCommandHandler('putLoadOrder', () => Promise.resolve(APPLIED));
    await expect(sender.send(snapshot('B.esp'))).resolves.toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['A.esp', 'B.esp']);
  });
});

describe('createLoadOrderSender — latest answers the newest snapshot handed to send', () => {
  it('is none before any send', async () => {
    const sender = createLoadOrderSender(attached());

    await expect(sender.latest()).resolves.toBeUndefined();
  });

  it('waits behind a put in flight for the snapshot parked after it, not for the put in flight', async () => {
    const client = attached();
    let release!: () => void;
    client.setCommandHandler('putLoadOrder', () =>
      new Promise<LoadOrderOutcome>((resolve) => { release = () => resolve(APPLIED); }));
    const sender = createLoadOrderSender(client);
    void sender.send(snapshot('A.esp'));
    await Promise.resolve();
    void sender.send(snapshot('B.esp'));
    const settled: LoadOrderOutcome[] = [];
    const latest = sender.latest().then((outcome) => { if (outcome) settled.push(outcome); });

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual([]);

    release();
    await latest;
    expect(settled).toEqual([APPLIED]);
    expect(sentNames(client)).toEqual(['A.esp', 'B.esp']);
  });

  it('follows a snapshot that a newer one supersedes before it is sent', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', APPLIED);
    const sender = createLoadOrderSender(client);
    void sender.send(snapshot('A.esp'));
    const latest = sender.latest();
    void sender.send(snapshot('B.esp'));
    client.setStatus('running');

    await expect(latest).resolves.toEqual(APPLIED);
    expect(sentNames(client)).toEqual(['B.esp']);
  });
});

describe('createLoadOrderSender — arm and abandon', () => {
  it('a freshly armed scope is not abandoned', () => {
    const sender = createLoadOrderSender(attached());

    const { signal, abandoned } = sender.arm();

    expect(signal.aborted).toBe(false);
    expect(abandoned()).toBe(false);
  });

  it('abandon() aborts the most recently armed scope', () => {
    const sender = createLoadOrderSender(attached());
    const { signal, abandoned } = sender.arm();

    sender.abandon();

    expect(signal.aborted).toBe(true);
    expect(abandoned()).toBe(true);
  });

  it('abandon() is a silent no-op when nothing has ever been armed', () => {
    const sender = createLoadOrderSender(attached());

    expect(() => sender.abandon()).not.toThrow();
  });

  it('arming again replaces the previous scope without aborting it, a superseded send needing no abort as the backend answers it 409', () => {
    const sender = createLoadOrderSender(attached());
    const first = sender.arm();
    const second = sender.arm();

    sender.abandon();

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  it('aborts the send in flight, so the backend hears the close rather than the extension waiting on a dead socket', async () => {
    const client = attached();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    client.setCommandHandler('putLoadOrder', (...args) => new Promise<LoadOrderOutcome>((resolve) => {
      const signal = args[6]?.signal;
      if (!signal) throw new Error('expected putLoadOrder to receive an abort signal');
      started();
      signal.addEventListener('abort', () => resolve(ABANDONED));
    }));
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    await inFlight;
    sender.abandon();

    expect(await sent).toEqual(ABANDONED);
  });

  it('drops the snapshot still waiting on connect, so a closed backend leaves nothing queued for the next one', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', APPLIED);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    sender.abandon();
    client.setStatus('running');

    expect(await sent).toEqual(ABANDONED);
    expect(puts(client)).toEqual([]);
  });

  it('serves a send made after an abandon — a relaunch (launch, close, launch) finds the sender able', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);
    sender.arm();
    sender.abandon();

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(APPLIED);
  });
});

describe('createLoadOrderSender — mEdit going away', () => {
  function heldInFlight(client: InMemoryMEditClient): Promise<void> {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    client.setCommandHandler('putLoadOrder', (...args) => new Promise<LoadOrderOutcome>((resolve) => {
      const signal = args[6]?.signal;
      if (!signal) throw new Error('expected putLoadOrder to receive an abort signal');
      started();
      signal.addEventListener('abort', () => resolve(ABANDONED));
    }));
    return inFlight;
  }

  it.each(['disconnected', 'stopped'] as const)('answers the send in flight abandoned when mEdit is %s, never a killed backend as a network failure', async (status) => {
    const client = attached();
    const inFlight = heldInFlight(client);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    await inFlight;
    client.setStatus(status);

    expect(await sent).toEqual(ABANDONED);
  });

  it('leaves the armed scope alone while mEdit starts and attaches, since a launch arms it before the start', () => {
    const client = new InMemoryMEditClient();
    const sender = createLoadOrderSender(client);
    const { abandoned } = sender.arm();

    client.setStatus('starting');
    client.setStatus('running');

    expect(abandoned()).toBe(false);
  });
});

describe('createLoadOrderSender — dispose', () => {
  it('sends nothing after dispose and stops listening for the connect', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);
    sender.dispose();

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(ABANDONED);
    expect(puts(client)).toEqual([]);

    client.setStatus('running');
    await Promise.resolve();
    expect(puts(client)).toEqual([]);
  });

  it('drops a snapshot still waiting on connect', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', APPLIED);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    sender.dispose();

    expect(await sent).toEqual(ABANDONED);
    expect(puts(client)).toEqual([]);
  });
});
