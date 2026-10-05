import { describe, it, expect } from 'vitest';
import { createLoadOrderSender, InMemoryMEditClient } from '../client';
import { editingFlow, type Told } from '../instanceCommands/editing';
import { loadOrderSnapshotOf } from '../instanceLoader/loadOrderSnapshot';
import { loadOrderPutOnEachValue } from '../syncWiring';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';

function valueWith(name: string) {
  const derived = {
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const,
    pluginsLoadedWithNoLine: [],
    modFolders: undefined,
    plugins: [{ name, path: `/game/Data/${name}`, origin: 'Data', slot: 0, enabled: true, winning: true }],
  };
  return instanceValueFixture({ ...derived, loadOrderSnapshot: loadOrderSnapshotOf(derived) });
}

describe('the Instance value puts the load order at each recompute', () => {
  it('puts each value that lands once editing is entered, and none after the subscription is disposed', async () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    const instance = new FakeInstance(valueWith('A.esp'));
    const told: Told[] = [];
    const heard: (() => void)[] = [];
    const toldTwice = new Promise<void>((resolve) => {
      const check = (): void => { if (told.length >= 2) resolve(); else heard.push(check); };
      check();
    });
    const flow = editingFlow({
      client, sender: createLoadOrderSender(client), instanceRoot: '/instance',
      exitEditing: () => undefined, around: (entry) => entry(), log: () => undefined,
      tell: (what) => { told.push(what); heard.splice(0).forEach((listener) => listener()); return Promise.resolve(); },
    });
    const subscription = loadOrderPutOnEachValue(instance, flow);
    await flow.enter(Promise.resolve(instance.value));

    instance.publish(valueWith('B.esp'));
    await toldTwice;
    subscription.dispose();
    instance.publish(valueWith('C.esp'));
    await flow.put(valueWith('D.esp'));

    const sent = client.calls.filter((c) => c.method === 'putLoadOrder').map((c) => JSON.stringify(c.args[0]));
    expect(sent.map((plugins) => /"name":"(\w\.esp)"/.exec(plugins)?.[1])).toEqual(['A.esp', 'B.esp', 'D.esp']);
  });
});
