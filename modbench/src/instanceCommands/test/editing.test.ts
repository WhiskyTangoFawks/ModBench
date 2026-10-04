import { describe, it, expect, vi } from 'vitest';
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderPluginInput, type LoadOrderProgress,
} from '../../client';
import { editingFlow, type Told } from '../editing';
import type { LoadOrderSource } from '../loadOrder';

const STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 7, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: STATUS };

const NO_SNAPSHOT: LoadOrderSource = { gameName: 'Fallout 4', gameRelease: 'Fallout4', loadOrderSnapshot: undefined };

function valueWith(name: string): LoadOrderSource {
  const plugin = { name, path: `/game/Data/${name}`, origin: 'Data' };
  return {
    ...NO_SNAPSHOT,
    loadOrderSnapshot: { plugins: [plugin], active: [{ name, origin: 'Data' }], loadedWithNoLine: [], dataFolder: '/game/Data' },
  };
}

function isPluginInputs(value: unknown): value is LoadOrderPluginInput[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'name' in v);
}

function wired(status: 'running' | 'starting', first: LoadOrderSource) {
  const client = new InMemoryMEditClient();
  client.setCommandResult('putLoadOrder', APPLIED);
  client.setStatus(status);
  const sender = createLoadOrderSender(client);
  let held = first;
  let sendFails = false;
  const landed = vi.fn(() => Promise.resolve(held));
  const exitEditing = vi.fn();
  const told: Told[] = [];
  const tellListeners: (() => void)[] = [];
  const tell = (what: Told): Promise<void> => {
    told.push(what);
    for (const listener of tellListeners.splice(0)) listener();
    return Promise.resolve();
  };
  const toldCount = (count: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => { if (told.length >= count) resolve(); else tellListeners.push(check); };
    check();
  });
  const flow = editingFlow({
    client, instanceRoot: '/instance', landed, exitEditing, tell, log: () => undefined,
    sender: { arm: () => sender.arm(), send: (snapshot) => (sendFails ? Promise.reject(new Error('boom')) : sender.send(snapshot)) },
    around: (entry) => entry(),
  });
  const putPluginNames = (): string[] => client.calls
    .filter((c) => c.method === 'putLoadOrder')
    .map((c) => {
      const plugins = c.args[0];
      if (!isPluginInputs(plugins)) throw new Error('expected putLoadOrder args[0] to be a plugin array');
      return plugins.map((p) => p.name).join(',');
    });
  const land = (value: LoadOrderSource): void => { held = value; flow.onRecompute(value); };
  return {
    client, flow, sender, landed, exitEditing, told, toldCount, putPluginNames, land,
    failSends: () => { sendFails = true; },
  };
}

describe('entering editing', () => {
  it('reads the instance value while the backend starts, then puts the load order it carries', async () => {
    const { client, flow, landed, told, putPluginNames } = wired('running', valueWith('A.esp'));
    const start = vi.spyOn(client, 'start');

    await flow.enter();

    expect(landed.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0] ?? 0);
    expect(putPluginNames()).toEqual(['A.esp']);
    expect(told.map((t) => t.kind)).toEqual(['put']);
  });

  it('exits editing, putting and telling nothing, when the value carries no snapshot', async () => {
    const { flow, exitEditing, told, putPluginNames } = wired('running', NO_SNAPSHOT);

    await flow.enter();

    expect(exitEditing).toHaveBeenCalledOnce();
    expect(putPluginNames()).toEqual([]);
    expect(told).toEqual([]);
  });

  it('exits editing and tells when the backend did not come up', async () => {
    const { flow, exitEditing, told, putPluginNames } = wired('starting', valueWith('A.esp'));

    await flow.enter();

    expect(exitEditing).toHaveBeenCalledOnce();
    expect(told).toEqual([{ kind: 'backendFailed' }]);
    expect(putPluginNames()).toEqual([]);
  });

  it('tells an abandoned launch, and neither exits editing nor puts', async () => {
    const { client, flow, sender, exitEditing, told, putPluginNames } = wired('running', valueWith('A.esp'));
    client.start = () => { sender.abandon(); return Promise.resolve(); };

    await flow.enter();

    expect(told).toEqual([{ kind: 'abandoned' }]);
    expect(exitEditing).not.toHaveBeenCalled();
    expect(putPluginNames()).toEqual([]);
  });

  it('enters again when the backend restarts after a crash', async () => {
    const { client, flow, toldCount, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.setStatus('disconnected');
    client.setStatus('running');
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('enters no more once disposed', async () => {
    const { client, flow, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    flow.dispose();
    client.setStatus('disconnected');
    client.setStatus('running');
    await flow.put(valueWith('Z.esp'));

    expect(putPluginNames()).toEqual(['A.esp', 'Z.esp']);
  });
});

describe('put load order', () => {
  it('tells the put it made', async () => {
    const { flow, told } = wired('running', valueWith('A.esp'));

    await flow.put(valueWith('A.esp'));

    expect(told).toMatchObject([{ kind: 'put', put: { sent: true, outcome: APPLIED } }]);
  });

  it('tells a value without a snapshot as nothing sent', async () => {
    const { flow, told, putPluginNames } = wired('running', valueWith('A.esp'));

    await flow.put(NO_SNAPSHOT);

    expect(told).toEqual([{ kind: 'put', put: { sent: false } }]);
    expect(putPluginNames()).toEqual([]);
  });
});

describe('the load order is put at every recompute', () => {
  it('puts a load order equal to the last one put', async () => {
    const { flow, land, toldCount, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    land(valueWith('A.esp'));
    await toldCount(2);
    land(valueWith('B.esp'));
    await toldCount(3);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp', 'B.esp']);
  });

  it('puts nothing without a game folder, and keeps what mEdit holds', async () => {
    const { flow, land, toldCount, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    land(NO_SNAPSHOT);
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp']);
  });

  it('tells a put that threw, since no caller is left to hear it', async () => {
    const { flow, land, failSends, told, toldCount } = wired('running', valueWith('A.esp'));
    await flow.enter();
    failSends();

    land(valueWith('B.esp'));
    await toldCount(2);

    expect(told[1]).toEqual({ kind: 'putThrew', message: 'boom' });
  });

  it('puts a value that arrived before mEdit started only when it starts, once', async () => {
    const { client, flow, land, putPluginNames, told } = wired('starting', valueWith('A.esp'));

    land(valueWith('B.esp'));
    client.setStatus('running');
    await flow.enter();

    expect(putPluginNames()).toEqual(['B.esp']);
    expect(told).toHaveLength(1);
  });

  it('puts nothing between the backend going and mEdit next starting', async () => {
    const { client, flow, land, told, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.setStatus('stopped');
    client.setStatus('running');
    land(valueWith('B.esp'));
    await flow.put(valueWith('C.esp'));

    expect(told).toHaveLength(2);
    expect(putPluginNames()).toEqual(['A.esp', 'C.esp']);
  });

  it('puts on a stream reopen, with no value landing after it', async () => {
    const { client, flow, toldCount, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.reconnected();
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts nothing on a stream reopen before mEdit started', async () => {
    const { client, flow, told, putPluginNames } = wired('running', valueWith('A.esp'));

    client.reconnected();
    await flow.put(valueWith('Z.esp'));

    expect(told).toHaveLength(1);
    expect(putPluginNames()).toEqual(['Z.esp']);
  });

  it('puts nothing once disposed', async () => {
    const { client, flow, land, told, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    flow.dispose();
    land(valueWith('B.esp'));
    client.reconnected();
    await flow.put(valueWith('Z.esp'));

    expect(told).toHaveLength(2);
    expect(putPluginNames()).toEqual(['A.esp', 'Z.esp']);
  });
});
