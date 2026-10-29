import { describe, it, expect } from 'vitest';
import type { LoadOrderOutcome, LoadOrderProgress } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { putLoadOrder, type LoadOrderSource } from '../loadOrder';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };

const PLUGIN = { name: 'TestMod.esp', path: '/instance/mods/TestMod/TestMod.esp', origin: 'TestMod', provider: { kind: 'Mod' as const, mod: 'TestMod', folder: '/instance/mods/TestMod' }, line: 0, lineNamesIt: true, archives: [], stringsFiles: [] };
const MASTER = { name: 'Master.esm', path: '/game/Data/Master.esm', origin: 'Base Mod', provider: { kind: 'Game' as const }, line: null, lineNamesIt: false, archives: [], stringsFiles: [] };
const SENT_PLUGINS = [MASTER, PLUGIN];
const SENT_ACTIVE = [{ name: 'Master.esm', origin: 'Base Mod' }, { name: PLUGIN.name, origin: PLUGIN.origin }];
const SENT_LOADED_WITH_NO_LINE = [{ name: 'Master.esm', origin: 'Base Mod' }];
const SENT_ARCHIVES = [{ path: '/game/Data/Master - Main.ba2', stamp: '1/2/3' }];
const SENT_STRINGS_FILES = [{ path: '/instance/mods/TestMod/Strings/TestMod_en.STRINGS', stamp: '4/5/6' }];
const SENT_PLACES = [{ name: 'TestMod', folder: '/instance/mods/TestMod' }];

const SOURCE: LoadOrderSource = {
  plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, archives: SENT_ARCHIVES, stringsFiles: SENT_STRINGS_FILES,
  places: SENT_PLACES, dataFolder: '/game/Data', gameRelease: 'Fallout4',
};

function attachedClient(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setStatus('running');
  client.answerPuts(() => Promise.resolve(APPLIED));
  return client;
}

describe('put load order', () => {
  it('hands the mEdit client the snapshot the loader read, keyed by the instance and its release', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(client, '/instance', SOURCE, 'French');

    expect(client.puts()).toEqual([{
      plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, archives: SENT_ARCHIVES, stringsFiles: SENT_STRINGS_FILES,
      places: SENT_PLACES, dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'French',
    }]);
    expect(result).toEqual({
      sent: true,
      snapshot: {
        plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, archives: SENT_ARCHIVES, stringsFiles: SENT_STRINGS_FILES,
        places: SENT_PLACES, dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'French',
      },
      outcome: APPLIED,
    });
  });

  it('sends the release the snapshot was built for', async () => {
    const client = attachedClient();

    await putLoadOrder(client, '/instance', { ...SOURCE, gameRelease: 'Fallout4VR' }, 'English');

    expect(client.puts().map((put) => put.gameRelease)).toEqual(['Fallout4VR']);
  });

  it('sends nothing while the loader read no snapshot, which is the loader\'s answer to a game folder not found or not listable', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(client, '/instance', undefined, 'English');

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });
});

describe('put load order without a strings language', () => {
  it('fails loudly rather than inventing a default the manifest owns', async () => {
    await expect(putLoadOrder(attachedClient(), '/instance', SOURCE, undefined)).rejects.toThrow('The strings language has no value');
  });
});

describe('put load order, refused by the loader', () => {
  it('sends nothing and carries the refusal for the caller to tell', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(
      client, '/instance', { refusal: 'a.esp has no mod folder' }, 'English');

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false, refusal: 'a.esp has no mod folder' });
  });
});
