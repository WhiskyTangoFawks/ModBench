import { describe, it, expect, vi } from 'vitest';
import type { LaunchOutcome, LoadOrderOutcome, LoadOrderProgress, LoadOrderSnapshot } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { editingFlow } from '../editing';
import type { PutLoadOrderResult } from '../loadOrder';
import type { LoadOrderSource } from '../loadOrder';

const STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 7, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: STATUS };

const NO_SNAPSHOT: LoadOrderSource = undefined;
const REFUSED: LoadOrderSource = { refusal: 'a.esp has no mod folder' };

function valueWith(name: string): LoadOrderSource {
  const plugin = { name, path: `/game/Data/${name}`, origin: 'Base Mod', provider: { kind: 'Game' as const }, line: null, lineNamesIt: false, archives: [], stringsFiles: [] };
  return { plugins: [plugin], active: [{ name, origin: 'Base Mod' }], loadedWithNoLine: [], listedArchives: [], archivesByPlugin: [], stringsFiles: [], places: [], dataFolder: '/game/Data', gameRelease: 'Fallout4' };
}

type Told = PutLoadOrderResult;

function wired(status: 'running' | 'stopped' = 'running') {
  const client = new InMemoryMEditClient();
  client.answerPuts(() => Promise.resolve(APPLIED));
  client.setStatus(status);
  const told: Told[] = [];
  const tellListeners: (() => void)[] = [];
  let tellFailure: Error | undefined;
  const tell = (what: Told): void => {
    told.push(what);
    for (const listener of tellListeners.splice(0)) listener();
    const failure = tellFailure;
    tellFailure = undefined;
    if (failure) throw failure;
  };
  const logged: string[] = [];
  const toldCount = (count: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => { if (told.length >= count) resolve(); else tellListeners.push(check); };
    check();
  });
  const around: { entered: number; settled: boolean; told: number[] } = { entered: 0, settled: false, told: [] };
  let blueprintNames: string[] = [];
  const changeListeners: (() => void)[] = [];
  const inGameOrder = {
    of: ({ active }: Pick<LoadOrderSnapshot, 'active'>) => [...active.filter(({ name }) => !blueprintNames.includes(name)), ...active.filter(({ name }) => blueprintNames.includes(name))],
    onChange: (listener: () => void) => { changeListeners.push(listener); return { dispose: () => undefined }; },
  };
  const flow = editingFlow({
    client, instanceRoot: '/instance', inGameOrder, onPut: (put) => { tell(put); return Promise.resolve(); }, log: (line) => { logged.push(line); },
    around: async (entry) => { around.entered++; await entry(); around.settled = true; around.told.push(told.length); },
  });
  const putPluginNames = (): string[] => client.puts().map((put) => put.plugins.map((p) => p.name).join());
  const land = (value: LoadOrderSource): void => { flow.onRecompute(value, 'English'); };
  const failNextTell = (error: Error): void => { tellFailure = error; };
  const readBlueprints = (...names: string[]): void => {
    blueprintNames = names;
    for (const listener of changeListeners) listener();
  };
  return { client, flow, readBlueprints, told, toldCount, putPluginNames, land, around, logged, failNextTell };
}

describe('the load order is put again when what Editing read of the plugins changes the order the game loads in', () => {
  const address = (name: string) => ({ name, origin: 'Base Mod' });
  const starfield: LoadOrderSource = {
    plugins: [], active: ['Starfield.esm', 'Blueprint.esm', 'A.esp'].map(address), loadedWithNoLine: ['Starfield.esm', 'Blueprint.esm'].map(address),
    listedArchives: [], archivesByPlugin: [], stringsFiles: [], places: [], dataFolder: '/game/Data', gameRelease: 'Fallout4',
  };
  const activeSent = (client: InMemoryMEditClient): string[][] => client.puts().map((put) => put.active.map(({ name }) => name));

  it('sends the order again once, and settles when the next read finds the same blueprints', async () => {
    const { client, land, readBlueprints, toldCount } = wired();
    land(starfield);
    await toldCount(1);

    readBlueprints('Blueprint.esm');
    await toldCount(2);
    readBlueprints('Blueprint.esm');
    await Promise.resolve();

    expect(activeSent(client)).toEqual([['Starfield.esm', 'Blueprint.esm', 'A.esp'], ['Starfield.esm', 'A.esp', 'Blueprint.esm']]);
  });

  it('sends nothing before the loader has landed a value', async () => {
    const { client, readBlueprints } = wired();

    readBlueprints('Blueprint.esm');
    await Promise.resolve();

    expect(client.calls).toEqual([]);
  });
});

describe('the load order is put at a recompute that changed it', () => {
  it('hands the client each snapshot that changed and tells what came of it', async () => {
    const { told, toldCount, land, putPluginNames } = wired();

    land(valueWith('A.esp'));
    await toldCount(1);
    land(valueWith('B.esp'));
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp', 'B.esp']);
    expect(told[1]).toMatchObject({ sent: true, outcome: APPLIED });
  });

  it('hands the client no snapshot equal to the one mEdit was handed', async () => {
    const { told, toldCount, land, putPluginNames } = wired();

    land(valueWith('A.esp'));
    await toldCount(1);
    land(valueWith('A.esp'));
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp']);
    expect(told[1]).toEqual({ sent: false });
  });

  it('hands the snapshot again once its put failed', async () => {
    const { client, toldCount, land, putPluginNames } = wired();
    client.answerPuts(() => Promise.resolve({ outcome: 'failed', message: 'no' }));
    land(valueWith('A.esp'));
    await toldCount(1);

    client.answerPuts(() => Promise.resolve(APPLIED));
    land(valueWith('A.esp'));
    await toldCount(2);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('hands the snapshot again after a load order the loader refused, so the refusal is told over', async () => {
    const { told, toldCount, land, putPluginNames } = wired();
    land(valueWith('A.esp'));
    await toldCount(1);

    land(REFUSED);
    land(valueWith('A.esp'));
    await toldCount(3);

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
    expect(told[2]).toMatchObject({ sent: true });
  });

  it('tells a value without a snapshot as nothing sent, and hands the client nothing', async () => {
    const { client, told, toldCount, land } = wired();

    land(NO_SNAPSHOT);
    await toldCount(1);

    expect(told).toEqual([{ sent: false }]);
    expect(client.calls).toEqual([]);
  });

  it('tells a load order the loader refused, with nothing sent', async () => {
    const { told, toldCount, land, putPluginNames } = wired();

    land(REFUSED);
    await toldCount(1);

    expect(told).toEqual([{ sent: false, refusal: 'a.esp has no mod folder' }]);
    expect(putPluginNames()).toEqual([]);
  });
});

describe('a put the client makes again on its own', () => {
  it('is told as the snapshot it put', async () => {
    const { client, told, toldCount, land } = wired();
    land(valueWith('A.esp'));
    await toldCount(1);

    client.reconnected();
    await toldCount(2);

    expect(told[1]).toMatchObject({ sent: true, snapshot: { dataFolder: '/game/Data' }, outcome: APPLIED });
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
    void client.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(around).toMatchObject({ entered: 1, settled: false });
    launched.resolve();
    await entering;

    expect(around).toEqual({ entered: 1, settled: true, told: [1] });
  });

  it('shows the launch with the extension as the entry alone, not a second time', async () => {
    const { client, flow, around, land } = wired('stopped');

    const entering = flow.enter(Promise.resolve().then(() => { land(valueWith('A.esp')); }));
    void client.start();
    await entering;

    expect(around).toEqual({ entered: 1, settled: true, told: [1] });
  });

  it('ends the entry when the first read lands no value', async () => {
    const { flow, around, told } = wired();

    await flow.enter(Promise.resolve());

    expect(around).toEqual({ entered: 1, settled: true, told: [0] });
    expect(told).toEqual([]);
  });
});

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('a tell that threw', () => {
  it('reaches the Output once, and the entries after it still end', async () => {
    const { flow, toldCount, land, logged, failNextTell, around } = wired();
    failNextTell(new Error('boom'));
    land(valueWith('A.esp'));
    await toldCount(1);

    await flow.enter(Promise.resolve().then(() => { land(valueWith('B.esp')); }));

    expect(logged).toEqual(['[loadOrder] handing mEdit the load order threw: boom']);
    expect(around.settled).toBe(true);
  });
});

class ClientWhoseLaunchIsHeld extends InMemoryMEditClient {
  heard: (launched: Promise<LaunchOutcome>) => void = () => undefined;
  override onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void {
    this.heard = listener;
    return () => undefined;
  }
}

describe('telling a launch that threw', () => {
  it('reaches the Output once, naming the launch', async () => {
    const client = new ClientWhoseLaunchIsHeld();
    const logged: string[] = [];
    editingFlow({ client, instanceRoot: '/instance', inGameOrder: { of: ({ active }) => [...active], onChange: () => ({ dispose: () => undefined }) }, onPut: () => Promise.resolve(), log: (line) => { logged.push(line); }, around: (entry) => entry() });

    client.heard(Promise.reject(new Error('no kill')));

    await vi.waitFor(() => { expect(logged).toEqual(['[loadOrder] telling the launch of mEdit threw: no kill']); });
  });
});

describe('a recompute after a failed launch', () => {
  it('neither launches mEdit again nor tells nor shows anything', async () => {
    const { client, told, land, around } = wired('stopped');
    client.answerStart(() => Promise.resolve());
    void client.start();
    await vi.waitFor(() => { expect(around.settled).toBe(true); });
    const toldBefore = told.length;

    land(valueWith('A.esp'));
    await client.latestLoadOrder();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(told.slice(toldBefore)).toEqual([]);
    expect(around.entered).toBe(1);
    expect(client.calls.filter((c) => c.method === 'start')).toHaveLength(1);
  });
});
