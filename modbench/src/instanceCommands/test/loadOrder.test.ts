import { describe, it, expect } from 'vitest';
import type { LoadOrderOutcome, LoadOrderProgress } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { putLoadOrder, refresh, type LoadOrderSource } from '../loadOrder';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };

const PLUGIN = { name: 'TestMod.esp', path: '/instance/mods/TestMod/TestMod.esp', origin: 'TestMod', provider: { kind: 'Mod' as const, mod: 'TestMod', folder: '/instance/mods/TestMod' } };
const MASTER = { name: 'Master.esm', path: '/game/Data/Master.esm', origin: 'Data', provider: { kind: 'Game' as const } };
const SENT_PLUGINS = [MASTER, PLUGIN];
const SENT_ACTIVE = [{ name: 'Master.esm', origin: 'Data' }, { name: PLUGIN.name, origin: PLUGIN.origin }];
const SENT_LOADED_WITH_NO_LINE = [{ name: 'Master.esm', origin: 'Data' }];

const VALUE: LoadOrderSource = {
  gameName: 'Fallout 4',
  gameRelease: 'Fallout4',
  loadOrderSnapshot: {
    plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, dataFolder: '/game/Data',
  },
};

function attachedClient(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  client.answerPuts(() => Promise.resolve(APPLIED));
  return client;
}

describe('put load order', () => {
  it('hands the mEdit client the snapshot the value carries, keyed by the instance and its release', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(client, '/instance', VALUE);

    expect(client.puts()).toEqual([{
      plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, gameDirectory: '/game/Data',
      instanceRoot: '/instance', gameRelease: 'Fallout4',
    }]);
    expect(result).toEqual({
      sent: true,
      snapshot: {
        plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, gameDirectory: '/game/Data',
        instanceRoot: '/instance', gameRelease: 'Fallout4',
      },
      outcome: APPLIED,
    });
  });

  it('sends the release the value holds, not one looked up from the game\'s name beside the Instance adapter\'s answer', async () => {
    const client = attachedClient();

    await putLoadOrder(client, '/instance', { ...VALUE, gameRelease: 'Fallout4VR' });

    expect(client.puts().map((put) => put.gameRelease)).toEqual(['Fallout4VR']);
  });

  it('sends the game as the instance names it when the value holds no release, so a guessed release does not answer about another game and the name is refused visibly', async () => {
    const client = attachedClient();

    await putLoadOrder(client, '/instance', { ...VALUE, gameName: 'Morrowind', gameRelease: undefined });

    expect(client.puts().map((put) => put.gameRelease)).toEqual(['Morrowind']);
  });

  it('sends nothing while the value carries no snapshot, which is the loader\'s answer to a game folder not found or not listable', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(client, '/instance', { ...VALUE, loadOrderSnapshot: undefined });

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });
});

describe('put load order, refused by the loader', () => {
  it('sends nothing and carries the refusal for the caller to tell', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(
      client, '/instance', { ...VALUE, loadOrderSnapshot: { refusal: 'a.esp has no mod folder' } });

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false, refusal: 'a.esp has no mod folder' });
  });
});

describe('refresh', () => {
  it('rebuilds the index for the instance, so mEdit reads every plugin again against the load order it holds, and sends nothing', async () => {
    const client = attachedClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });

    const result = await refresh(client, '/instance', VALUE);

    expect(client.calls.map((c) => [c.method, ...c.args])).toEqual([['rebuildIndex', '/instance', 'Fallout4']]);
    expect(result).toEqual({ applied: true });
  });

  it('sends nothing and reports held-elsewhere by name, apart from the generic refusal every other failure gets', async () => {
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
