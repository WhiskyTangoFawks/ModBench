import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../InMemoryMEditClient';
import { createLoadOrderSender, type LoadOrderSnapshot } from '../loadOrderSender';
import type { LoadOrderOutcome, LoadOrderPluginInput } from '../MEditClient';

const RECONCILED: LoadOrderOutcome = { outcome: 'reconciled', failures: [], crashRepairOffers: [] };
const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };

function snapshot(name: string): LoadOrderSnapshot {
  return {
    plugins: [{ name, path: `/game/Data/${name}`, origin: 'Data', slot: 0, enabled: true, winning: true }],
    gameDirectory: '/game/Data',
    instanceRoot: '/instance',
    gameRelease: 'Fallout4',
  };
}

const puts = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'putLoadOrder');
const sentNames = (client: InMemoryMEditClient) =>
  puts(client).map((c) => (c.args[0] as LoadOrderPluginInput[])[0].name);

function attached(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setCommandResult('putLoadOrder', RECONCILED);
  client.setStatus('attached');
  return client;
}

// ADR-0013: the Instance-to-mEdit arrow, with its whole sequencing on the client's own side of
// the seam — connect before the first PUT, one PUT at a time, and the newest snapshot the one
// that lands.
describe('createLoadOrderSender — connect precedes the first put', () => {
  it('holds a snapshot handed over before the backend attaches, and sends it on connect', async () => {
    const client = new InMemoryMEditClient(); // 'starting' — never attached
    client.setCommandResult('putLoadOrder', RECONCILED);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    await Promise.resolve();
    expect(puts(client)).toEqual([]);

    client.setStatus('attached');

    await expect(sent).resolves.toEqual(RECONCILED);
    expect(sentNames(client)).toEqual(['A.esp']);
  });

  it('sends straight away once the backend is already attached', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(RECONCILED);
    expect(sentNames(client)).toEqual(['A.esp']);
  });

  it('passes the snapshot whole — copies, game directory, instance root and release', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);

    await sender.send(snapshot('A.esp'));

    const [plugins, gameDirectory, instanceRoot, gameRelease] = puts(client)[0].args;
    expect({ plugins, gameDirectory, instanceRoot, gameRelease }).toEqual({
      plugins: snapshot('A.esp').plugins, gameDirectory: '/game/Data',
      instanceRoot: '/instance', gameRelease: 'Fallout4',
    });
  });
});

describe('createLoadOrderSender — the last snapshot lands and the superseded ones are dropped', () => {
  it('sends only the newest of the snapshots that piled up before the backend attached', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', RECONCILED);
    const sender = createLoadOrderSender(client);

    const first = sender.send(snapshot('A.esp'));
    const second = sender.send(snapshot('B.esp'));
    const third = sender.send(snapshot('C.esp'));
    client.setStatus('attached');

    expect(await first).toEqual(ABANDONED);
    expect(await second).toEqual(ABANDONED);
    expect(await third).toEqual(RECONCILED);
    expect(sentNames(client)).toEqual(['C.esp']);
  });

  it('a snapshot arriving mid-send becomes exactly one more send after it, never a concurrent one', async () => {
    const client = attached();
    let releaseFirst!: () => void;
    client.setCommandHandler('putLoadOrder', () =>
      new Promise<LoadOrderOutcome>((resolve) => { releaseFirst = () => resolve(RECONCILED); }));
    const sender = createLoadOrderSender(client);

    const first = sender.send(snapshot('A.esp'));
    await Promise.resolve();
    const second = sender.send(snapshot('B.esp'));
    const third = sender.send(snapshot('C.esp'));
    expect(sentNames(client)).toEqual(['A.esp']); // still in flight — nothing concurrent

    releaseFirst();
    client.setCommandHandler('putLoadOrder', () => Promise.resolve(RECONCILED));

    expect(await first).toEqual(RECONCILED);
    expect(await second).toEqual(ABANDONED);
    expect(await third).toEqual(RECONCILED);
    expect(sentNames(client)).toEqual(['A.esp', 'C.esp']);
  });

  it('a send that throws is answered as failed and does not wedge the next one', async () => {
    const client = attached();
    client.setCommandHandler('putLoadOrder', () => Promise.reject(new Error('boom')));
    const sender = createLoadOrderSender(client);

    const failed = await sender.send(snapshot('A.esp'));
    expect(failed).toEqual({ outcome: 'failed', message: expect.stringContaining('boom') });

    client.setCommandHandler('putLoadOrder', () => Promise.resolve(RECONCILED));
    await expect(sender.send(snapshot('B.esp'))).resolves.toEqual(RECONCILED);
    expect(sentNames(client)).toEqual(['A.esp', 'B.esp']);
  });
});

// The in-flight send's abort handle and the sender's own lifecycle stay independent: abandoning
// the send in flight must never disable a later one (launch → close → launch).
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

  // A superseded send does not need aborting — the backend answers it 409 — so arming again must
  // not reach back and abort the scope it replaces.
  it('arming again replaces the previous scope without aborting it', () => {
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
      const { signal } = args[4] as { signal: AbortSignal };
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
    client.setCommandResult('putLoadOrder', RECONCILED);
    const sender = createLoadOrderSender(client);

    const sent = sender.send(snapshot('A.esp'));
    sender.abandon();
    client.setStatus('attached');

    expect(await sent).toEqual(ABANDONED);
    expect(puts(client)).toEqual([]);
  });

  it('serves a send made after an abandon — a relaunch finds the sender able', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);
    sender.arm();
    sender.abandon();

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(RECONCILED);
  });
});

describe('createLoadOrderSender — dispose', () => {
  it('sends nothing after dispose and stops listening for the connect', async () => {
    const client = attached();
    const sender = createLoadOrderSender(client);
    sender.dispose();

    await expect(sender.send(snapshot('A.esp'))).resolves.toEqual(ABANDONED);
    expect(puts(client)).toEqual([]);

    client.setStatus('attached');
    await Promise.resolve();
    expect(puts(client)).toEqual([]);
  });

  it('drops a snapshot still waiting on connect', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('putLoadOrder', RECONCILED);
    const sender = createLoadOrderSender(client);
    const onProgress = vi.fn();

    const sent = sender.send(snapshot('A.esp'), { onProgress });
    sender.dispose();

    expect(await sent).toEqual(ABANDONED);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
