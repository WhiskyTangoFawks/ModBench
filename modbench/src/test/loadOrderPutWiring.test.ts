// update-load-order-file: the load order is put on change and on connect. Wired as the root
// wires it, through the real sender, so a put is a put the client actually receives.
import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from './vscodeMock';

// `../toolbox` wires every MO2-side view, so its own vscode surface is wide: `fakeVscodeModule()`
// covers it, as copyValueCommand.test.ts does for the same module.
vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon }));
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderPluginInput,
} from '../client';
import type { InstanceSubscriber, InstanceValue } from '../instanceLoader/instance';
import { loadOrderChanged, putLoadOrder, type LoadOrderSource } from '../instanceCommands/loadOrder';
import { registerLoadOrderPut } from '../toolbox';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const ROOT = '/instance';
const APPLIED: LoadOrderOutcome = {
  outcome: 'applied',
  status: { totalPlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [] },
};

function valueWith(name: string, overrides: Partial<InstanceValue> = {}): InstanceValue {
  return instanceValueFixture({
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    plugins: [{ name, path: `/game/Data/${name}`, origin: 'Data', slot: 0, enabled: true, winning: true }],
    ...overrides,
  });
}

const sourceOf = (value: InstanceValue): LoadOrderSource =>
  ({ plugins: value.plugins, gameFolder: value.gameFolder, gameName: value.gameRelease });

function isPluginInputs(value: unknown): value is LoadOrderPluginInput[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'name' in v);
}

// The Instance as the trigger reads it: each landed value handed to every subscriber.
function wired(status: 'attached' | 'starting', first: InstanceValue) {
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
  const connected = vi.fn();
  const owned: vscode.Disposable[] = [];
  const puts = registerLoadOrderPut(
    (d) => { owned.push(d); return d; }, instance, client,
    (value) => loadOrderChanged(sender, ROOT, sourceOf(value)),
    async () => { await putLoadOrder(sender, ROOT, sourceOf(current)); },
    connected,
    channel,
  );
  // After the trigger, so the trigger hears a reopen before the sender does.
  const sender = createLoadOrderSender(client);
  let sequence = 0;
  const land = (value: InstanceValue): void => {
    current = value;
    sequence += 1;
    for (const subscriber of [...subscribers]) subscriber(value, sequence);
  };
  // Every put the client received, by its sole plugin's name.
  const sent = (): string[] => client.calls
    .filter((c) => c.method === 'putLoadOrder')
    .map((c) => {
      const plugins = c.args[0];
      if (!isPluginInputs(plugins)) throw new Error('expected putLoadOrder args[0] to be a plugin array');
      return plugins.map((p) => p.name).join(',');
    });
  const dispose = (): void => { for (const d of owned) d.dispose(); };
  return { client, puts, land, sent, channel, connected, dispose };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the load order is put on change', () => {
  it('puts two instance values with an equal load order once', async () => {
    const { puts, land, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    land(valueWith('B.esp'));
    land(valueWith('B.esp', { overwriteFileCount: 3 }));
    await settled();

    expect(sent()).toEqual(['A.esp', 'B.esp']);
  });

  it('puts nothing for a value whose load order is the one put on connect', async () => {
    const { puts, land, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    land(valueWith('A.esp', { activeProfile: 'Other' }));
    await settled();

    expect(sent()).toEqual(['A.esp']);
  });

  it('puts nothing without a game folder, and keeps what mEdit holds', async () => {
    const { puts, land, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    land(instanceValueFixture());
    await settled();

    expect(sent()).toEqual(['A.esp']);
  });

  it('logs a put that throws, since no caller is left to hear it', async () => {
    let land!: InstanceSubscriber;
    const instance = { subscribe: (s: InstanceSubscriber) => { land = s; return { dispose: () => {} }; } };
    const channel = { error: vi.fn() };
    const puts = registerLoadOrderPut(
      (d) => d, instance, new InMemoryMEditClient(), () => true, () => Promise.reject(new Error('boom')), () => {},
      channel);
    await puts.putOnConnect().catch(() => {});

    land(valueWith('B.esp'), 1);
    await settled();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('the load order is put on connect', () => {
  it('puts a value that arrived while mEdit was detached on connect, once', async () => {
    const { client, puts, land, sent } = wired('starting', valueWith('A.esp'));

    land(valueWith('B.esp'));
    await settled();
    client.setStatus('attached');
    await puts.putOnConnect();
    await settled();

    expect(sent()).toEqual(['B.esp']);
  });

  it('puts on connect the load order the backend before it already had', async () => {
    const { client, puts, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    client.setStatus('disconnected');
    client.setStatus('attached');
    await puts.putOnConnect();

    expect(sent()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts no change between the backend going and the next connect', async () => {
    const { client, puts, land, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    client.setStatus('stopped');
    land(valueWith('B.esp'));
    client.setStatus('attached');
    land(valueWith('C.esp'));
    await settled();

    expect(sent()).toEqual(['A.esp']);
  });

  // A backend the client attached to without owning it can restart under a live status.
  it('puts once on a stream reopen, and not again for a value with the same load order', async () => {
    const { client, puts, land, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    client.reconnected();
    await settled();
    land(valueWith('A.esp', { overwriteFileCount: 3 }));
    await settled();

    expect(sent()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts on a stream reopen, with no value landing after it', async () => {
    const { client, puts, sent } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    client.reconnected();
    await settled();

    expect(sent()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts nothing on a stream reopen before the connect has put', async () => {
    const { client, sent } = wired('attached', valueWith('A.esp'));

    client.reconnected();
    await settled();

    expect(sent()).toEqual([]);
  });

  it('puts nothing once disposed', async () => {
    const { client, puts, land, sent, dispose } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    dispose();
    land(valueWith('B.esp'));
    client.reconnected();
    await settled();

    expect(sent()).toEqual(['A.esp']);
  });
});

// Plugin sync asks mEdit which plugins load with no line, so it runs again at the same moment.
describe('a connect runs what waits on mEdit', () => {
  // Rival: a second attach detector of its own, which runs on an `attached` status alone.
  it('on the connect and on a stream reopen after it, never on a reopen before it', async () => {
    const { client, puts, connected } = wired('attached', valueWith('A.esp'));
    client.reconnected();
    await settled();
    expect(connected).not.toHaveBeenCalled();

    await puts.putOnConnect();
    expect(connected).toHaveBeenCalledTimes(1);

    client.reconnected();
    await settled();
    expect(connected).toHaveBeenCalledTimes(2);
  });

  it('not on a status change alone', async () => {
    const { client, puts, connected } = wired('attached', valueWith('A.esp'));
    await puts.putOnConnect();

    client.setStatus('disconnected');
    client.setStatus('attached');
    await settled();

    expect(connected).toHaveBeenCalledTimes(1);
  });
});
