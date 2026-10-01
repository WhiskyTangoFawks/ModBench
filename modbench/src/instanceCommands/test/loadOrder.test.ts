import { describe, it, expect } from 'vitest';
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderProgress,
} from '../../client';
import { putLoadOrder, refresh, type LoadOrderSource } from '../loadOrder';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
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
  gameRelease: 'Fallout4',
  gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
  plugins: [PLUGIN, LINE_WITHOUT_A_FILE],
  pluginsLoadedWithNoLine: [{ name: 'Master.esm', origin: 'Data' }],
};
const MASTER = { name: 'Master.esm', path: '/game/Data/Master.esm', origin: 'Data' };
const SENT_PLUGINS = [MASTER, { name: PLUGIN.name, path: PLUGIN.path, origin: PLUGIN.origin }];
const SENT_ACTIVE = [{ name: 'Master.esm', origin: 'Data' }, { name: PLUGIN.name, origin: PLUGIN.origin }];
const SENT_LOADED_WITH_NO_LINE = [{ name: 'Master.esm', origin: 'Data' }];

function attachedClient(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  client.setCommandResult('putLoadOrder', APPLIED);
  return client;
}

describe('put load order', () => {
  it('hands the mEdit client the snapshot of the value it was given', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(createLoadOrderSender(client), '/instance', VALUE);

    const puts = client.calls.filter((c) => c.method === 'putLoadOrder');
    expect(puts.map((c) => c.args.slice(0, 6)))
      .toEqual([[SENT_PLUGINS, SENT_ACTIVE, SENT_LOADED_WITH_NO_LINE, '/game/Data', '/instance', 'Fallout4']]);
    expect(result).toEqual({
      sent: true,
      snapshot: {
        plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, gameDirectory: '/game/Data',
        instanceRoot: '/instance', gameRelease: 'Fallout4',
      },
      outcome: APPLIED,
    });
  });

  // Rival: looking the release up from the game's name here, beside the Instance adapter's answer.
  it('sends the release the value holds', async () => {
    const client = attachedClient();

    await putLoadOrder(createLoadOrderSender(client), '/instance', { ...VALUE, gameRelease: 'Fallout4VR' });

    expect(client.calls.filter((c) => c.method === 'putLoadOrder').map((c) => c.args[5])).toEqual(['Fallout4VR']);
  });

  // A guessed release would answer about another game; the name is refused visibly instead.
  it('sends the game as the instance names it when the value holds no release', async () => {
    const client = attachedClient();

    await putLoadOrder(createLoadOrderSender(client), '/instance', { ...VALUE, gameName: 'Morrowind', gameRelease: undefined });

    expect(client.calls.filter((c) => c.method === 'putLoadOrder').map((c) => c.args[5])).toEqual(['Morrowind']);
  });

  // common.md, States, story 5: without the game's masters the snapshot would be wrong, so mEdit
  // keeps what it holds.
  it('sends nothing while the game folder\'s plugins cannot be listed', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(createLoadOrderSender(client), '/instance', { ...VALUE, pluginsLoadedWithNoLine: undefined });

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });

  it('sends nothing while the game directory is unresolved', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(createLoadOrderSender(client), '/instance', { ...VALUE, gameFolder: { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } });

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });
});

describe('refresh', () => {
  // commands.md, `refresh`: mEdit reads every plugin again against the load order it holds.
  it('rebuilds the index for the instance and sends nothing', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });

    const result = await refresh(client, '/instance', VALUE);

    expect(client.calls.map((c) => [c.method, ...c.args])).toEqual([['rebuildIndex', '/instance', 'Fallout4']]);
    expect(result).toEqual({ applied: true });
  });

  // ADR-0009 invariant 5: held-elsewhere is refused by name, apart from every other failure — the
  // rival is a refresh that folds it into the same generic refusal every other failure gets.
  it('sends nothing and reports held-elsewhere apart from every other refusal', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: true });

    const result = await refresh(client, '/instance', VALUE);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: true });
  });

  it('sends nothing and returns the reason for every other refused rebuild', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' });

    const result = await refresh(client, '/instance', VALUE);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' });
  });
});
