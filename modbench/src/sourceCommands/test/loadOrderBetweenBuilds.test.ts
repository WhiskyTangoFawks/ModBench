import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, sourceModsOf } from '../../test/fakeInstanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import { sourceCommands } from '../sourceCommands';
import type { BuildMod } from '../../client';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';

const SOURCES = { ModA: '/instance/source/ModA', ModB: '/instance/source/Old ModB' };
const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
const builtOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [], made: [] });
const savedAll = () => Promise.resolve([]);

const indexedAsOnDisk = (client: InMemoryMEditClient, as: boolean): void => {
  client.setQueryAnswer('isPluginIndexedAsOnDisk', as);
  client.emit(loadOrderStatusEventFixture({ indexedPlugins: [{ name: 'B.esp', origin: 'ModB' }] }));
};

const buildingModBThenModA = (mods: ReturnType<typeof pluginFilesHeld>) => {
  const client = new InMemoryMEditClient();
  client.setCommandHandler('build', (sent: readonly BuildMod[]) => Promise.resolve({ landed: sent.map(({ name }) => builtOf(name)), refused: [] }));
  const adapter = fakeInstanceAdapter(readingFixture({ mods: [...ORDER], sourceMods: sourceModsOf(SOURCES), ...mods })).adapter;
  const built = (waitMs = 1_000) => sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), loadOrderWaitMs: waitMs }).build(['ModA', 'ModB']);
  return { client, built };
};
const builtMods = (client: InMemoryMEditClient): unknown[] => client.calls.filter((call) => call.method === 'build').map((call) => JSON.stringify(call.args[0]).match(/"name":"(\w+)"/)?.[1]);
const pause = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

describe('sourceCommands build, between mods', () => {
  const modBHoldsPlugin = pluginFilesHeld({ origin: { kind: 'mod', name: 'ModB' }, name: 'B.esp' });
  const bInTheIndex = { name: 'B.esp', origin: 'ModB' };

  it('builds the next mod once mEdit holds the plugins the built mod\'s folder gives the load order as they are on disk', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('isPluginIndexedAsOnDisk', false);

    const outcome = built();
    await pause();
    expect(builtMods(client)).toEqual(['ModB']);
    indexedAsOnDisk(client, true);

    expect(await outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }], refused: [] });
    expect(client.calls.filter((call) => call.method === 'isPluginIndexedAsOnDisk').map((call) => call.args[0])).toContainEqual(bInTheIndex);
  });

  it('waits for a rerun plugin of a name the record index already holds, as the file it read before', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.emit(loadOrderStatusEventFixture({ indexedPlugins: [bInTheIndex] }));
    client.setQueryAnswer('isPluginIndexedAsOnDisk', false);

    const outcome = await built(20);

    expect(builtMods(client)).toEqual(['ModB']);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }], refused: [{ item: 'ModA' }] });
  });

  it('builds the next mod at once when mEdit already holds the plugins as on disk, and when the built mod gives none', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('isPluginIndexedAsOnDisk', true);
    expect(await built()).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });

    const none = buildingModBThenModA(pluginFilesHeld());
    expect(await none.built()).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('lands a mod whose plugin never reaches the record index as on disk, naming it, and refuses the mods after it', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('isPluginIndexedAsOnDisk', false);

    const outcome = await built(20);

    expect(builtMods(client)).toEqual(['ModB']);
    expect(outcome).toMatchObject({
      landed: [{ mod: 'ModB', failure: expect.stringContaining('B.esp') as unknown }],
      refused: [{ item: 'ModA', reason: expect.stringMatching(/^was not built: .*B\.esp/) as unknown }],
    });
  });
});
