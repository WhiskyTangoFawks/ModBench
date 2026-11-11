import { describe, it, expect } from 'vitest';
import type { LoadOrderOutcome, LoadOrderProgress } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { putLoadOrder, type InGameOrder, type LoadOrderSource } from '../loadOrder';

const READY_STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, validating: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: READY_STATUS };

const PLUGIN = { name: 'TestMod.esp', path: '/instance/mods/TestMod/TestMod.esp', origin: 'TestMod', provider: { kind: 'Mod' as const, mod: 'TestMod', folder: '/instance/mods/TestMod' }, line: 0, lineNamesIt: true, archives: [], stringsFiles: [] };
const MASTER = { name: 'Master.esm', path: '/game/Data/Master.esm', origin: 'Base Mod', provider: { kind: 'Game' as const }, line: null, lineNamesIt: false, archives: [], stringsFiles: [] };
const AS_LOADED: InGameOrder = ({ active }) => [...active];
const CHANGED = (): boolean => true;
const SENT_PLUGINS = [MASTER, PLUGIN];
const SENT_ACTIVE = [{ name: 'Master.esm', origin: 'Base Mod' }, { name: PLUGIN.name, origin: PLUGIN.origin }];
const SENT_LOADED_WITH_NO_LINE = [{ name: 'Master.esm', origin: 'Base Mod' }];
const SENT_ARCHIVES = [{ path: '/game/Data/Master - Main.ba2', stamp: '1/2/3' }];
const SENT_LISTED = [{ path: '/game/Data/Fallout4 - Interface.ba2', stamp: '7/8/9' }];
const SENT_STRINGS_FILES = [{ path: '/instance/mods/TestMod/Strings/TestMod_en.STRINGS', stamp: '4/5/6' }];
const SENT_PLACES = [{ name: 'TestMod', folder: '/instance/mods/TestMod' }];

const SOURCE: LoadOrderSource = {
  plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, stringsFiles: SENT_STRINGS_FILES,
  listedArchives: SENT_LISTED, archivesByPlugin: [{ name: 'Master.esm', origin: 'Base Mod', archives: SENT_ARCHIVES }],
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

    const result = await putLoadOrder(client, '/instance', SOURCE, 'French', AS_LOADED, CHANGED);

    expect(client.puts()).toEqual([{
      plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, archives: [...SENT_LISTED, ...SENT_ARCHIVES], listedArchives: SENT_LISTED.map(({ path }) => path), stringsFiles: SENT_STRINGS_FILES,
      places: SENT_PLACES, dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'French',
    }]);
    expect(result).toEqual({
      sent: true,
      snapshot: {
        plugins: SENT_PLUGINS, active: SENT_ACTIVE, loadedWithNoLine: SENT_LOADED_WITH_NO_LINE, archives: [...SENT_LISTED, ...SENT_ARCHIVES], listedArchives: SENT_LISTED.map(({ path }) => path), stringsFiles: SENT_STRINGS_FILES,
        places: SENT_PLACES, dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'French',
      },
      outcome: APPLIED,
    });
  });

  it('sends the release the snapshot was built for', async () => {
    const client = attachedClient();

    await putLoadOrder(client, '/instance', { ...SOURCE, gameRelease: 'Fallout4VR' }, 'English', AS_LOADED, CHANGED);

    expect(client.puts().map((put) => put.gameRelease)).toEqual(['Fallout4VR']);
  });

  it('sends nothing while the loader read no snapshot, which is the loader\'s answer to a game folder not found or not listable', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(client, '/instance', undefined, 'English', AS_LOADED, CHANGED);

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false });
  });
});

describe('put load order without a strings language', () => {
  it('fails loudly rather than inventing a default the manifest owns', async () => {
    await expect(putLoadOrder(attachedClient(), '/instance', SOURCE, undefined, AS_LOADED, CHANGED)).rejects.toThrow('The strings language has no value');
  });
});

describe('put load order, refused by the loader', () => {
  it('sends nothing and carries the refusal for the caller to tell', async () => {
    const client = attachedClient();

    const result = await putLoadOrder(
      client, '/instance', { refusal: 'a.esp has no mod folder' }, 'English', AS_LOADED, CHANGED);

    expect(client.calls).toEqual([]);
    expect(result).toEqual({ sent: false, refusal: 'a.esp has no mod folder' });
  });
});

describe('put load order in the order the game loads', () => {
  it('sends the active plugins in the order it is given, and the plugins the game loads with no line as the loader read them', async () => {
    const client = attachedClient();
    const reversed: InGameOrder = ({ active }) => [...active].reverse();

    await putLoadOrder(client, '/instance', SOURCE, 'English', reversed, CHANGED);

    expect(client.puts().map(({ active, loadedWithNoLine }) => ({ active, loadedWithNoLine })))
      .toEqual([{ active: [...SENT_ACTIVE].reverse(), loadedWithNoLine: SENT_LOADED_WITH_NO_LINE }]);
  });
});

describe('put load order, the archives follow the plugins', () => {
  const stamped = (path: string) => ({ path, stamp: '1/2/3' });
  const address = (name: string) => ({ name, origin: 'Base Mod' });
  const STARFIELD: LoadOrderSource = {
    ...SOURCE,
    active: ['Starfield.esm', 'Blueprint.esm', 'A.esp'].map(address),
    loadedWithNoLine: ['Starfield.esm', 'Blueprint.esm'].map(address),
    listedArchives: [stamped('/g/Interface.ba2')],
    archivesByPlugin: [
      { ...address('Starfield.esm'), archives: [stamped('/g/Starfield - Main.ba2')] },
      { ...address('Blueprint.esm'), archives: [stamped('/g/Blueprint - Main.ba2')] },
      { ...address('A.esp'), archives: [stamped('/a/A - Main.ba2')] },
    ],
  };
  const blueprintLast: InGameOrder = ({ active }) => [...active.filter(({ name }) => name !== 'Blueprint.esm'), ...active.filter(({ name }) => name === 'Blueprint.esm')];
  const archivesSent = async (order: InGameOrder): Promise<string[]> => {
    const client = attachedClient();
    await putLoadOrder(client, '/instance', STARFIELD, 'English', order, CHANGED);
    return client.puts().flatMap((put) => put.archives.map(({ path }) => path));
  };

  it.each([
    ['the order the game loads the plugins in', blueprintLast, ['/g/Interface.ba2', '/g/Starfield - Main.ba2', '/a/A - Main.ba2', '/g/Blueprint - Main.ba2']],
    ['the plugins.txt order, for a release that loads no blueprint plugin last', AS_LOADED, ['/g/Interface.ba2', '/g/Starfield - Main.ba2', '/g/Blueprint - Main.ba2', '/a/A - Main.ba2']],
  ])('sends the INIs\' archives, then each plugin\'s with it, in %s', async (_order, order, expected) => {
    expect(await archivesSent(order)).toEqual(expected);
  });

  it('sends an archive once, at its first place', async () => {
    const client = attachedClient();
    const twice = { ...STARFIELD, listedArchives: [stamped('/a/A - Main.ba2')] };

    await putLoadOrder(client, '/instance', twice, 'English', AS_LOADED, CHANGED);

    expect(client.puts().flatMap((put) => put.archives.map(({ path }) => path))).toEqual(['/a/A - Main.ba2', '/g/Starfield - Main.ba2', '/g/Blueprint - Main.ba2']);
  });
});
