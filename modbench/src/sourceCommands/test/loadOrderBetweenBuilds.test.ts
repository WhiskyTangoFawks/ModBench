import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, sourceModsOf } from '../../test/fakeInstanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import { sourceCommands } from '../sourceCommands';
import type { BuildMod, LoadOrderProgress } from '../../client';

const SOURCES = { ModA: '/instance/source/ModA', ModB: '/instance/source/Old ModB' };
const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
const builtOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [], made: [] });
const savedAll = () => Promise.resolve([]);

const statusHolding = (...indexed: readonly { name: string; origin: string }[]): LoadOrderProgress =>
  ({ totalPlugins: indexed.length, activePlugins: indexed.length, indexedPlugins: [...indexed], conflictsComputed: true, failures: [], version: 1, holdsNone: false });
const hear = (client: InMemoryMEditClient, status: LoadOrderProgress): void => { client.emit({ kind: 'load-order-status', loadOrderStatus: status }); };

const buildingModBThenModA = (mods: ReturnType<typeof pluginFilesHeld>) => {
  const client = new InMemoryMEditClient();
  client.setCommandHandler('build', (sent: readonly BuildMod[]) => Promise.resolve({ landed: sent.map(({ name }) => builtOf(name)), refused: [] }));
  const adapter = fakeInstanceAdapter(readingFixture({ mods: [...ORDER], sourceMods: sourceModsOf(SOURCES), ...mods })).adapter;
  const built = (waitMs = 1_000) => sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), loadOrderWaitMs: waitMs }).build(['ModA', 'ModB']);
  return { client, built };
};
const builtMods = (client: InMemoryMEditClient): unknown[] => client.calls.map((call) => JSON.stringify(call.args[0]).match(/"name":"(\w+)"/)?.[1]);
const pause = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

describe('sourceCommands build, between mods', () => {
  const modBHoldsPlugin = pluginFilesHeld({ origin: { kind: 'mod', name: 'ModB' }, name: 'B.esp' });

  it('builds the next mod once the record index holds the plugins the built mod\'s folder gives the load order', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);

    const outcome = built();
    await pause();
    expect(builtMods(client)).toEqual(['ModB']);
    hear(client, statusHolding({ name: 'B.esp', origin: 'ModB' }));

    expect(await outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }], refused: [] });
    expect(builtMods(client)).toEqual(['ModB', 'ModA']);
  });

  it('builds the next mod at once when the record index already holds the plugins, and when the built mod gives none', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    hear(client, statusHolding({ name: 'B.esp', origin: 'ModB' }));
    expect(await built()).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });

    const none = buildingModBThenModA(pluginFilesHeld());
    expect(await none.built()).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('does not take another origin\'s plugin of the same filename for the built mod\'s', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    hear(client, statusHolding({ name: 'B.esp', origin: 'ModA' }));

    const outcome = await built(20);

    expect(builtMods(client)).toEqual(['ModB']);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }], refused: [{ item: 'ModA' }] });
  });

  it('lands a mod whose plugin never reaches the record index, naming it, and refuses the mods after it', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);

    const outcome = await built(20);

    expect(builtMods(client)).toEqual(['ModB']);
    expect(outcome).toMatchObject({
      landed: [{ mod: 'ModB', failure: expect.stringContaining('B.esp') as unknown }],
      refused: [{ item: 'ModA', reason: expect.stringMatching(/^was not built: .*B\.esp/) as unknown }],
    });
  });
});
