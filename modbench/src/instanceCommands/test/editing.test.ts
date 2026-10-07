import { describe, it, expect } from 'vitest';
import type { LoadOrderOutcome, LoadOrderProgress } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { editingFlow, type Told } from '../editing';
import type { LoadOrderSource } from '../loadOrder';

const STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 7, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: STATUS };

const NO_SNAPSHOT: LoadOrderSource = { gameName: 'Fallout 4', gameRelease: 'Fallout4', loadOrderSnapshot: undefined };
const REFUSED: LoadOrderSource = { ...NO_SNAPSHOT, loadOrderSnapshot: { refusal: 'a.esp has no mod folder' } };

function valueWith(name: string): LoadOrderSource {
  const plugin = { name, path: `/game/Data/${name}`, origin: 'Data', provider: { kind: 'Game' as const } };
  return {
    ...NO_SNAPSHOT,
    loadOrderSnapshot: { plugins: [plugin], active: [{ name, origin: 'Data' }], loadedWithNoLine: [], dataFolder: '/game/Data' },
  };
}

function wired(status: 'running' | 'stopped' = 'running') {
  const client = new InMemoryMEditClient();
  client.answerPuts(() => Promise.resolve(APPLIED));
  client.setStatus(status);
  const told: Told[] = [];
  const tellListeners: (() => void)[] = [];
  let tellFailure: Error | undefined;
  const tell = (what: Told): Promise<void> => {
    told.push(what);
    for (const listener of tellListeners.splice(0)) listener();
    const failure = tellFailure;
    tellFailure = undefined;
    return failure ? Promise.reject(failure) : Promise.resolve();
  };
  const toldCount = (count: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => { if (told.length >= count) resolve(); else tellListeners.push(check); };
    check();
  });
  const around: { entered: number; settled: boolean } = { entered: 0, settled: false };
  const flow = editingFlow({
    client, instanceRoot: '/instance', tell,
    around: async (entry) => { around.entered++; await entry(); around.settled = true; },
  });
  const putPluginNames = (): string[] => client.puts().map((put) => put.plugins.map((p) => p.name).join());
  const land = (value: LoadOrderSource): void => { flow.onRecompute(value); };
  const failNextTell = (error: Error): void => { tellFailure = error; };
  return { client, flow, told, toldCount, putPluginNames, land, around, failNextTell };
}

describe('the load order is put at every recompute', () => {
  it('hands the client each snapshot and tells what came of it', async () => {
    const { told, toldCount, land, putPluginNames } = wired();

    land(valueWith('A.esp'));
    await toldCount(1);
    land(valueWith('A.esp'));
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
    expect(told[1]).toMatchObject({ kind: 'put', put: { sent: true, outcome: APPLIED } });
  });

  it('tells a value without a snapshot as nothing sent, and hands the client nothing', async () => {
    const { client, told, toldCount, land } = wired();

    land(NO_SNAPSHOT);
    await toldCount(1);

    expect(told).toEqual([{ kind: 'put', put: { sent: false } }]);
    expect(client.calls).toEqual([]);
  });

  it('tells a load order the loader refused, with nothing sent', async () => {
    const { told, toldCount, land, putPluginNames } = wired();

    land(REFUSED);
    await toldCount(1);

    expect(told).toEqual([{ kind: 'put', put: { sent: false, refusal: 'a.esp has no mod folder' } }]);
    expect(putPluginNames()).toEqual([]);
  });

  it('tells mEdit not coming up to take the snapshot as the backend failing', async () => {
    const { client, told, toldCount, land } = wired('stopped');
    client.answerStart(() => Promise.resolve());

    land(valueWith('A.esp'));
    await toldCount(1);

    expect(told).toEqual([{ kind: 'backendFailed' }]);
  });

  it('tells a put whose telling threw, since no caller is left to hear it', async () => {
    const { told, toldCount, land, failNextTell } = wired();
    failNextTell(new Error('boom'));

    land(valueWith('A.esp'));
    await toldCount(2);

    expect(told[1]).toEqual({ kind: 'putThrew', message: 'boom' });
  });
});

describe('a put the client makes again on its own', () => {
  it('is told as the snapshot it put', async () => {
    const { client, told, toldCount, land } = wired();
    land(valueWith('A.esp'));
    await toldCount(1);

    client.reconnected();
    await toldCount(2);

    expect(told[1]).toMatchObject({ kind: 'put', put: { sent: true, snapshot: { gameDirectory: '/game/Data' }, outcome: APPLIED } });
  });

  it('is told no more once the flow is disposed', async () => {
    const { client, flow, told, toldCount, land, putPluginNames } = wired();
    land(valueWith('A.esp'));
    await toldCount(1);

    flow.dispose();
    client.reconnected();
    await client.latestLoadOrder();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
    expect(told).toHaveLength(1);
  });
});

describe('entering editing', () => {
  it('shows the entry until the value the first read landed is told', async () => {
    const { client, flow, around, land } = wired('stopped');
    const launched = pending();
    client.answerStart(() => launched.promise.then(() => { client.setStatus('running'); }));

    const entering = flow.enter(Promise.resolve().then(() => { land(valueWith('A.esp')); }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(around).toEqual({ entered: 1, settled: false });
    launched.resolve();
    await entering;

    expect(around).toEqual({ entered: 1, settled: true });
  });

  it('ends the entry when the first read lands no value', async () => {
    const { flow, around, told } = wired();

    await flow.enter(Promise.resolve());

    expect(around).toEqual({ entered: 1, settled: true });
    expect(told).toEqual([]);
  });
});

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
