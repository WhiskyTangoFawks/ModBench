import { describe, it, expect } from 'vitest';
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderProgress,
} from '../../client';
import { putLoadOrder, refresh, type LoadOrderSource } from '../loadOrder';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };

const PLUGIN = {
  name: 'TestMod.esp', path: '/instance/mods/TestMod/TestMod.esp', origin: 'TestMod',
  slot: 0, enabled: true, winning: true,
};
const LINE_WITHOUT_A_FILE = {
  name: 'Gone.esp', path: undefined, origin: 'Gone', slot: 1, enabled: true, winning: true,
};

const VALUE: LoadOrderSource = {
  gameName: 'Fallout 4',
  gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
  plugins: [PLUGIN, LINE_WITHOUT_A_FILE],
};

function attachedClient(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setStatus('attached');
  client.setCommandResult('putLoadOrder', APPLIED);
  return client;
}

describe('put load order', () => {
  it('hands the mEdit client the snapshot of the value it was given', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(createLoadOrderSender(client), '/instance', VALUE);

    const puts = client.calls.filter((c) => c.method === 'putLoadOrder');
    expect(puts.map((c) => c.args.slice(0, 4))).toEqual([[[PLUGIN], '/game/Data', '/instance', 'Fallout4']]);
    expect(result).toEqual({
      sent: true,
      snapshot: { plugins: [PLUGIN], gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' },
      outcome: APPLIED,
    });
  });

  it('sends nothing while the game directory is unresolved', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(createLoadOrderSender(client), '/instance', { ...VALUE, gameFolder: { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } });

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });
});

describe('refresh', () => {
  it('rebuilds the index for the instance, then sends the load order', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });

    const result = await refresh(client, createLoadOrderSender(client), '/instance', VALUE);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex', 'putLoadOrder']);
    const [rebuild] = client.calls;
    expect(rebuild?.args).toEqual(['/instance', 'Fallout4']);
    expect(result).toEqual({
      applied: true,
      loadOrder: {
        sent: true,
        snapshot: { plugins: [PLUGIN], gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4' },
        outcome: APPLIED,
      },
    });
  });

  // ADR-0009 invariant 5: held-elsewhere is refused by name, apart from every other failure — the
  // rival is a refresh that folds it into the same generic refusal every other failure gets.
  it('sends nothing and reports held-elsewhere apart from every other refusal', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: true });

    const result = await refresh(client, createLoadOrderSender(client), '/instance', VALUE);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: true });
  });

  it('sends nothing and returns the reason for every other refused rebuild', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' });

    const result = await refresh(client, createLoadOrderSender(client), '/instance', VALUE);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' });
  });
});
