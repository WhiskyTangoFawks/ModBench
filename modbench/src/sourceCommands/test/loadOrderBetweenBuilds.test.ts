import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSourceManifestIn } from '../../manifestAdapter/manifestAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, sourceModsOf } from '../../test/fakeInstanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import { sourceCommands } from '../sourceCommands';
import type { BuildMod } from '../../client/MEditClient';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';

let root: string;
let SOURCES: Record<string, string>;
const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
const landedOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], overwritten: [] });
const builtOf = (mod: string) => ({ ...landedOf(mod), made: [] });
const NOT_YET = { state: 'NotYet' } as const;
const AS_ON_DISK = { state: 'AsOnDisk' } as const;
const savedAll = () => Promise.resolve([]);

const buildingModBThenModA = (mods: ReturnType<typeof pluginFilesHeld>) => {
  const client = new InMemoryMEditClient();
  client.setCommandHandler('build', (sent: readonly BuildMod[]) => Promise.resolve({ landed: sent.map(({ name }) => builtOf(name)), refused: [] }));
  const adapter = fakeInstanceAdapter(readingFixture({ mods: [...ORDER], sourceMods: sourceModsOf(SOURCES), ...mods })).adapter;
  const built = (mods: readonly string[] = ['ModA', 'ModB']) => sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks() }).build(mods);
  return { client, built };
};
const builtMods = (client: InMemoryMEditClient): unknown[] => client.calls.filter((call) => call.method === 'build').map((call) => JSON.stringify(call.args[0]).match(/"name":"(\w+)"/)?.[1]);
const askedOfMEdit = (client: InMemoryMEditClient): unknown[] => client.calls.filter((call) => call.method === 'getPluginIndexing').map((call) => call.args[0]);

describe('sourceCommands build, between mods', () => {
  const modBHoldsPlugin = pluginFilesHeld({ origin: { kind: 'mod', name: 'ModB' }, name: 'B.esp' });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'between-builds-'));
    SOURCES = { ModA: join(root, 'ModA'), ModB: join(root, 'Old ModB') };
    for (const [output, folder] of Object.entries(SOURCES)) {
      await mkdir(folder);
      await writeSourceManifestIn(folder, { packages: [], output, exclude: [], archives: [], steps: [], tools: [], files: [] });
    }
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('builds the next mod once mEdit holds the plugins the built mod\'s folder gives the load order as they are on disk', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('getPluginIndexing', NOT_YET);

    const outcome = built();
    await vi.waitFor(() => { expect(builtMods(client)).toEqual(['ModB']); });
    client.setQueryAnswer('getPluginIndexing', AS_ON_DISK);
    client.emit(loadOrderStatusEventFixture());

    expect(await outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }], refused: [] });
    expect(askedOfMEdit(client)).toContainEqual({ name: 'B.esp', origin: 'ModB' });
  });

  it.each<[string, ReturnType<typeof pluginFilesHeld>, boolean]>([
    ['mEdit already holds the plugins as on disk', modBHoldsPlugin, true],
    ['the built mod gives no plugin', pluginFilesHeld(), false],
  ])('builds the next mod at once when %s', async (_case, mods, asked) => {
    const { client, built } = buildingModBThenModA(mods);
    client.setQueryAnswer('getPluginIndexing', AS_ON_DISK);

    expect(await built()).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
    expect(askedOfMEdit(client).length > 0).toBe(asked);
  });

  it('asks nothing after the last mod, whether it is one of several or alone', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('getPluginIndexing', NOT_YET);

    const alone = await built(['ModB']);

    expect(askedOfMEdit(client)).toEqual([]);
    expect(alone).toEqual({ landed: [landedOf('ModB')], refused: [] });
  });

  it.each<[string, { state: 'NotYet' } | { failed: 'refused'; refusal: string }, string]>([
    ['never reaches the record index as on disk', NOT_YET, 'plugin B.esp did not reach the record index within 120 seconds'],
    ['mEdit cannot say', { failed: 'refused', refusal: 'mEdit cannot say.' }, 'mEdit cannot say.'],
  ])('lands a mod whose plugin %s, naming why, and refuses the mods after it', async (_case, answer, why) => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('getPluginIndexing', answer);

    const outcome = built();
    await vi.waitFor(() => { expect(builtMods(client)).toEqual(['ModB']); });
    await vi.advanceTimersByTimeAsync(121_000);

    expect(builtMods(client)).toEqual(['ModB']);
    expect(await outcome).toMatchObject({
      landed: [{ mod: 'ModB', failure: expect.stringContaining(why) as unknown }],
      refused: [{ item: 'ModA', reason: expect.stringContaining(`was not built: ModB's plugin B.esp`) as unknown }],
    });
  });

  it('ends the wait at once, with mEdit\'s reason, for a plugin mEdit failed to read', async () => {
    const { client, built } = buildingModBThenModA(modBHoldsPlugin);
    client.setQueryAnswer('getPluginIndexing', { state: 'ReadFailed', reason: 'B.esp is not a plugin.' });

    const outcome = built();
    await vi.waitFor(() => { expect(builtMods(client)).toEqual(['ModB']); });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toMatchObject({
      landed: [{ mod: 'ModB', failure: expect.stringContaining('plugin B.esp could not be read: B.esp is not a plugin.') as unknown }],
      refused: [{ item: 'ModA' }],
    });
  });
});
