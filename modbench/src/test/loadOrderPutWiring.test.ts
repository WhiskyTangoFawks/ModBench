import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from './vscodeMock';
vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon }));
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderPluginInput,
} from '../client';
import type { InstanceSubscriber, InstanceValue } from '../instanceLoader/instance';
import { putLoadOrder, type LoadOrderSource } from '../instanceCommands/loadOrder';
import { registerLoadOrderPut } from '../toolbox';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const ROOT = '/instance';
const APPLIED: LoadOrderOutcome = {
  outcome: 'applied',
  status: { totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [] },
};

function valueWith(name: string, overrides: Partial<InstanceValue> = {}): InstanceValue {
  return instanceValueFixture({
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    pluginsLoadedWithNoLine: [],
    plugins: [{ name, path: `/game/Data/${name}`, origin: 'Data', slot: 0, enabled: true, winning: true }],
    ...overrides,
  });
}

const sourceOf = (value: InstanceValue): LoadOrderSource => ({
  plugins: value.plugins, gameFolder: value.gameFolder, gameName: value.gameName, gameRelease: value.gameRelease,
  pluginsLoadedWithNoLine: value.pluginsLoadedWithNoLine,
});

function isPluginInputs(value: unknown): value is LoadOrderPluginInput[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'name' in v);
}

function wired(status: 'running' | 'starting', first: InstanceValue) {
  const client = new InMemoryMEditClient();
  client.setCommandResult('putLoadOrder', APPLIED);
  client.setStatus(status);
  let current = first;
  const subscribers: InstanceSubscriber[] = [];
  const instance = {
    subscribe: (subscriber: InstanceSubscriber): vscode.Disposable => {
      subscribers.push(subscriber);
      return { dispose: () => subscribers.splice(subscribers.indexOf(subscriber), 1) };
    },
  };
  const channel = { error: vi.fn() };
  const owned: vscode.Disposable[] = [];
  const puts = registerLoadOrderPut(
    (d) => { owned.push(d); return d; }, instance, client,
    async () => { await putLoadOrder(sender, ROOT, sourceOf(current)); },
    channel,
  );
  const sender = createLoadOrderSender(client);
  let sequence = 0;
  const land = (value: InstanceValue): void => {
    current = value;
    sequence += 1;
    for (const subscriber of [...subscribers]) subscriber(value, sequence);
  };
  const putPluginNames = (): string[] => client.calls
    .filter((c) => c.method === 'putLoadOrder')
    .map((c) => {
      const plugins = c.args[0];
      if (!isPluginInputs(plugins)) throw new Error('expected putLoadOrder args[0] to be a plugin array');
      return plugins.map((p) => p.name).join(',');
    });
  const dispose = (): void => { for (const d of owned) d.dispose(); };
  return { client, puts, land, putPluginNames, channel, dispose };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the load order is put at every recompute', () => {
  it('puts a load order equal to the last one put', async () => {
    const { puts, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    for (const value of [valueWith('A.esp'), valueWith('B.esp'), valueWith('B.esp', { overwriteFileCount: 3 })]) {
      land(value);
      await settled();
    }

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp', 'B.esp', 'B.esp']);
  });

  it('puts nothing without a game folder, and keeps what mEdit holds', async () => {
    const { puts, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    land(instanceValueFixture());
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });

  it('logs a put that throws, since no caller is left to hear it', async () => {
    let land!: InstanceSubscriber;
    const instance = { subscribe: (s: InstanceSubscriber) => { land = s; return { dispose: () => {} }; } };
    const channel = { error: vi.fn() };
    const puts = registerLoadOrderPut(
      (d) => d, instance, new InMemoryMEditClient(), () => Promise.reject(new Error('boom')), channel);
    await puts.putOnMEditStarted().catch(() => {});

    land(valueWith('B.esp'), 1);
    await settled();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('the load order is put when mEdit started', () => {
  it('puts a value that arrived while mEdit was detached when mEdit started, once', async () => {
    const { client, puts, land, putPluginNames } = wired('starting', valueWith('A.esp'));

    land(valueWith('B.esp'));
    await settled();
    client.setStatus('running');
    await puts.putOnMEditStarted();
    await settled();

    expect(putPluginNames()).toEqual(['B.esp']);
  });

  it('puts when mEdit started the load order the backend before it already had', async () => {
    const { client, puts, putPluginNames } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    client.setStatus('disconnected');
    client.setStatus('running');
    await puts.putOnMEditStarted();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts no change between the backend going and mEdit next starting', async () => {
    const { client, puts, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    client.setStatus('stopped');
    land(valueWith('B.esp'));
    client.setStatus('running');
    land(valueWith('C.esp'));
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });

  it('puts on a stream reopen, with no value landing after it', async () => {
    const { client, puts, putPluginNames } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts nothing on a stream reopen before mEdit started', async () => {
    const { client, putPluginNames } = wired('running', valueWith('A.esp'));

    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual([]);
  });

  it('puts nothing once disposed', async () => {
    const { client, puts, land, putPluginNames, dispose } = wired('running', valueWith('A.esp'));
    await puts.putOnMEditStarted();

    dispose();
    land(valueWith('B.esp'));
    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });
});
