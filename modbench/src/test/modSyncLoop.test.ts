import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { NO_MOD_STATUSES } from './noModStatuses';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance } from '../instanceLoader/instance';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { FakeInstance } from './mo2/fakeInstance';
import { pastSequence, watcherFor } from './mo2/instanceLoop';
import { instanceSyncs } from '../syncWiring';
import { modSyncOver, type ModSyncRun } from '../modCommands/modCommands';
import type { PluginSyncRun } from '../pluginCommands/plugins';
import type { InstanceReading, Mod } from '../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture } from './fakeInstanceAdapter';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';
import { STEADY_WINDOW } from './steadyWindow';

const noPluginSync: PluginSyncRun = () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] });

const MOD = 'Freshly Installed Mod';
const DATA_FOLDER = '/game/Data';
const DATA_FOLDER_FOUND = { kind: 'found', root: '/game', dataFolder: DATA_FOLDER } as const;

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const modlistText = (root: string): Promise<string> => readFile(join(root, DEFAULT_MODLIST), 'utf8');

const channelDouble = () => ({ error: vi.fn(), info: vi.fn() });

async function settledWiredInstance(): Promise<{
  root: string;
  instance: Instance;
  channel: ReturnType<typeof channelDouble>;
  syncs: ReturnType<ModSyncRun>[];
}> {
  const root = cloneCorpusFixture();
  roots.push(root);
  const instance = new Instance({
    gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: DATA_FOLDER_FOUND }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  instances.push(instance);
  const channel = channelDouble();
  const syncs: ReturnType<ModSyncRun>[] = [];
  const { modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
    instance, channel, syncPlugins: noPluginSync,
    syncMods: () => {
      const run = modSyncOver(adapterOver(root))();
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await modSync.settled();
  channel.info.mockClear();
  return { root, instance, channel, syncs };
}

describe('mod sync and the Instance, over a real mods/ folder', () => {
  it('adds a line for a mod folder dropped in, once the next value lands', async () => {
    const { root, instance, syncs } = await settledWiredInstance();
    const before = instance.sequence;
    await mkdir(join(root, 'mods', MOD));
    await writeFile(join(root, 'mods', MOD, 'Installed.esp'), 'plugin bytes');
    expect(await modlistText(root)).not.toContain(MOD);

    watcherFor('mods/**').fireCreate(join(root, 'mods', MOD, 'Installed.esp'));
    await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(await modlistText(root)).toContain(MOD);
  });
});

async function settledFakeInstance(overrides: Partial<InstanceReading>) {
  const fake = fakeInstanceAdapter(readingFixture(overrides));
  const instance = new Instance({
    gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, adapter: fake.adapter, log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  instances.push(instance);
  const channel = channelDouble();
  const syncs: ReturnType<ModSyncRun>[] = [];
  const syncMods = modSyncOver(fake.adapter);
  const { modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
    instance, channel, syncPlugins: noPluginSync,
    syncMods: () => {
      const run = syncMods();
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await modSync.settled();
  channel.info.mockClear();
  fake.forgetCalls();
  return { fake, instance, channel, syncs, modSync };
}

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });

describe('mod sync, as the Instance value drives it', () => {
  const listed = { mods: [mod('Harder VATS')], modFolders: modFoldersOf('Harder VATS') };

  it('drops the line of a folder deleted by hand, once the next value lands', async () => {
    const { fake, instance, syncs } = await settledFakeInstance(listed);

    fake.read({ modFolders: modFoldersOf() });
    await instance.refresh();
    await syncs[syncs.length - 1];

    expect(fake.calls).toEqual([{ verb: 'changeModOrder', profile: 'Default', changes: [{ kind: 'dropMod', mod: 'Harder VATS' }] }]);
  });

  it('writes nothing, and says why in one Output line, when mods/ goes missing', async () => {
    const { fake, instance, channel, syncs } = await settledFakeInstance(listed);

    fake.read({ modFolders: undefined });
    await instance.refresh();
    await syncs[syncs.length - 1];

    expect(fake.calls).toEqual([]);
    expect(channel.error).toHaveBeenCalledTimes(1);
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('there is no folder for mods'));
  });

  it('decides on the mod folders the Instance adapter answers when it runs, not on the value that landed before them', async () => {
    const { fake, instance, modSync } = await settledFakeInstance(listed);

    fake.read({ modFolders: modFoldersOf('Harder VATS', 'Hand Extracted Mod') });
    await modSync.run();

    expect(instance.value.modFolders?.map((folder) => folder.name)).toEqual(['Harder VATS']);
    expect(fake.calls).toEqual([{
      verb: 'changeModOrder', profile: 'Default', changes: [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Hand Extracted Mod' } }],
    }]);
  });

  it('a further landed value once disk and mod order agree writes nothing and logs nothing', async () => {
    const { fake, instance, channel, syncs } = await settledFakeInstance(listed);

    fake.changed();
    await pastSequence(instance, instance.sequence);
    const outcome = await syncs[syncs.length - 1];

    expect(outcome).toEqual({ applied: true, added: [], dropped: [] });
    expect(fake.calls.flatMap((call) => (call.verb === 'changeModOrder' ? call.changes : []))).toEqual([]);
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });
});

describe('mod sync, as each landed value drives it', () => {
  it('runs on every value that lands, from the first', async () => {
    const syncMods = vi.fn<ModSyncRun>(() => Promise.resolve({ applied: true, added: [], dropped: [] }));
    const instance = new FakeInstance(instanceValueFixture());
    const { modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES, instance, syncPlugins: noPluginSync, channel: channelDouble(), syncMods });

    instance.publish(instanceValueFixture());
    instance.publish(instanceValueFixture());
    await modSync.settled();

    expect(syncMods).toHaveBeenCalledTimes(2);
  });

  it('names the file mod order is kept in as the value names it', async () => {
    const instance = new FakeInstance(instanceValueFixture({
      managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' },
    }));
    const channel = channelDouble();
    const { modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
      instance, syncPlugins: noPluginSync, channel,
      syncMods: () => Promise.resolve({ applied: true, added: ['New Mod'], dropped: [] }),
    });

    instance.publish(instance.value);
    await modSync.settled();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('1 order.txt line(s)'));
  });

  it('says a refusal on the Mods view\'s message line as modlist.txt not synced', async () => {
    const instance = new FakeInstance(instanceValueFixture());
    const { modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
      instance, syncPlugins: noPluginSync, channel: channelDouble(),
      syncMods: () => Promise.resolve({ applied: false, refusal: '/instance/mods does not exist' }),
    });

    instance.publish(instance.value);
    await modSync.settled();

    expect(modSync.message()).toBe('modlist.txt is not synced: /instance/mods does not exist.');
  });
});
