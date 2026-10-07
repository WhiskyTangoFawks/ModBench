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
import { modSyncOver, type ModSyncResult } from '../modlist/modlist';
import { type PluginSyncResult } from '../pluginsCommands/plugins';
import type { ModFolder } from '../instanceAdapter/instanceAdapter';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import { accessTo, adapterOver, STEADY_WINDOW } from './mo2/adapterOver';

const noPluginSync = () => Promise.resolve<PluginSyncResult>({ applied: true, wrote: false, added: [], dropped: [] });

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
  syncs: Promise<ModSyncResult>[];
  handed: (readonly ModFolder[] | undefined)[];
}> {
  const root = cloneCorpusFixture();
  roots.push(root);
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: DATA_FOLDER_FOUND }),
    log: () => {},
    logReadFailure: () => {},
  });
  instances.push(instance);
  const channel = channelDouble();
  const syncs: Promise<ModSyncResult>[] = [];
  const handed: (readonly ModFolder[] | undefined)[] = [];
  const { modSync } = instanceSyncs({
    instance, channel, syncPlugins: noPluginSync,
    syncMods: (args) => {
      handed.push(args.modFolders);
      const run = modSyncOver(accessTo(root))(args);
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await modSync.settled();
  channel.info.mockClear();
  return { root, instance, channel, syncs, handed };
}

describe('mod sync and the Instance, over a real mods/ folder', () => {
  it('adds a line for a mod folder dropped in, off the Instance value alone', async () => {
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

  it('drops the line of a folder deleted by hand, off the Instance value alone', async () => {
    const { root, instance, syncs } = await settledWiredInstance();
    const before = instance.sequence;
    await rm(join(root, 'mods', 'Harder VATS'), { recursive: true, force: true });

    watcherFor('mods/**').fireDelete(join(root, 'mods', 'Harder VATS'));
    await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(await modlistText(root)).not.toContain('Harder VATS');
  });

  it('leaves modlist.txt as it is, and says why in one Output line, when mods/ goes missing', async () => {
    const { root, instance, channel, syncs } = await settledWiredInstance();
    const settled = await modlistText(root);
    const before = instance.sequence;
    await rm(join(root, 'mods'), { recursive: true, force: true });

    watcherFor('mods/**').fireDelete(join(root, 'mods'));
    await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(await modlistText(root)).toBe(settled);
    expect(channel.error).toHaveBeenCalledTimes(1);
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('there is no folder for mods'));
  });

  it('hands the command the value\'s own mod folders, not a listing of its own', async () => {
    const { root, instance, handed, syncs } = await settledWiredInstance();
    const before = instance.sequence;
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    watcherFor('mods/**').fireCreate(join(root, 'mods', 'Hand Extracted Mod'));
    const value = await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(handed[handed.length - 1]).toBe(value.modFolders);
    expect(value.modFolders?.map((f) => f.name)).toContain('Hand Extracted Mod');
  });

  it('a further landed value once disk and modlist.txt agree writes nothing and logs nothing', async () => {
    const { root, instance, channel, syncs } = await settledWiredInstance();
    const settled = await modlistText(root);
    const before = instance.sequence;

    watcherFor('profiles/*/plugins.txt').fireChange();
    await pastSequence(instance, before);
    const outcome = await syncs[syncs.length - 1];

    expect(outcome).toEqual({ applied: true, added: [], dropped: [] });
    expect(await modlistText(root)).toBe(settled);
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });
});

describe('mod sync, as each landed value drives it', () => {
  it('runs on every value that lands, from the first', async () => {
    const profiles: string[] = [];
    const instance = new FakeInstance(instanceValueFixture());
    const { modSync } = instanceSyncs({
      instance, syncPlugins: noPluginSync, channel: channelDouble(),
      syncMods: ({ profile }) => { profiles.push(profile); return Promise.resolve({ applied: true, added: [], dropped: [] }); },
    });

    instance.publish(instanceValueFixture({ activeProfile: 'First' }));
    instance.publish(instanceValueFixture({ activeProfile: 'Second' }));
    await modSync.settled();

    expect(profiles).toEqual(['First', 'Second']);
  });

  it('names the file mod order is kept in as the value names it', async () => {
    const instance = new FakeInstance(instanceValueFixture({
      managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadMetadataFile: 'order.sidecar' },
    }));
    const channel = channelDouble();
    const { modSync } = instanceSyncs({
      instance, syncPlugins: noPluginSync, channel,
      syncMods: () => Promise.resolve({ applied: true, added: ['New Mod'], dropped: [] }),
    });

    instance.publish(instance.value);
    await modSync.settled();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('1 order.txt line(s)'));
  });

  it('says a refusal on the Mods view\'s message line as modlist.txt not synced', async () => {
    const instance = new FakeInstance(instanceValueFixture());
    const { modSync } = instanceSyncs({
      instance, syncPlugins: noPluginSync, channel: channelDouble(),
      syncMods: () => Promise.resolve({ applied: false, refusal: '/instance/mods does not exist' }),
    });

    instance.publish(instance.value);
    await modSync.settled();

    expect(modSync.message()).toBe('modlist.txt is not synced: /instance/mods does not exist.');
  });
});
