import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../test/mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';
import { adapterOver, pluginsCommandsWith, STEADY_WINDOW } from './mo2/adapterOver';
import { fakeInstanceAdapter, readingFixture } from './fakeInstanceAdapter';

vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import type { InstanceReading, Mod, ModFolder, ModFolders } from '../instanceAdapter/instanceAdapter';
import { instanceSyncs } from '../syncWiring';
import { FakeInstance } from './mo2/fakeInstance';
import { pastSequence, watcherFor } from './mo2/instanceLoop';
import { pluginSyncOver, type PluginSyncResult } from '../pluginsCommands/plugins';
import { present } from '../ports/present';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../test/mo2/gameFolderNotFound';
import { ToolboxProvider } from '../toolbox/ToolboxProvider';
import { modSyncOver, type ModSyncResult } from '../modOrderCommands/modOrderCommands';

const noModSync = () => Promise.resolve<ModSyncResult>({ applied: true, added: [], dropped: [] });

const PROFILE = 'Default';
const INI = '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n';

const roots: string[] = [];
const instances: Instance[] = [];
const toolboxes: ToolboxProvider[] = [];

afterEach(async () => {
  for (const toolbox of toolboxes.splice(0)) toolbox.dispose();
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const TIMED_OUT = Symbol('timed out waiting for a recompute');

function pastSequenceWithin(instance: Instance, sequence: number, ms: number): Promise<InstanceValue | typeof TIMED_OUT> {
  return Promise.race([
    pastSequence(instance, sequence),
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
}

async function wiredInstance(): Promise<{
  root: string;
  instance: Instance;
  syncs: Promise<PluginSyncResult>[];
  plugins: () => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'plugins-loop-'));
  roots.push(root);
  await mkdir(join(root, 'mods', 'Provider'), { recursive: true });
  await mkdir(join(root, 'profiles', PROFILE), { recursive: true });
  await mkdir(join(root, 'Game', 'Data'), { recursive: true });
  await writeFile(join(root, 'ModOrganizer.ini'), INI);
  await writeFile(join(root, 'profiles', PROFILE, 'modlist.txt'), '+Provider\r\n');
  await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
  await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');

  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  instances.push(instance);

  const syncs: Promise<PluginSyncResult>[] = [];
  instanceSyncs({
    instance, channel: { error: () => {}, info: () => {} }, syncMods: noModSync,
    syncPlugins: (args) => {
      const run = pluginSyncOver(adapterOver(root))(args);
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await syncs[syncs.length - 1];

  return { root, instance, syncs, plugins: () => readFile(join(root, 'profiles', PROFILE, 'plugins.txt'), 'utf8') };
}

async function driveToQuiescence(
  instance: Instance, syncs: Promise<PluginSyncResult>[], maxRounds: number,
): Promise<{ writes: number; quiescent: boolean }> {
  let writes = 0;
  for (let round = 0; round < maxRounds; round++) {
    const landed = await pastSequenceWithin(instance, instance.sequence, 5000);
    if (landed === TIMED_OUT) return { writes, quiescent: true };
    const result = present(
      await syncs[syncs.length - 1],
      'the most recently issued sync result',
    );
    if (!(result.applied && result.wrote)) return { writes, quiescent: true };
    writes++;
    watcherFor('profiles/*/plugins.txt').fireChange();
  }
  return { writes, quiescent: false };
}

describe('plugin sync and the Instance close a loop that settles', () => {
  it('a burst of mod-folder changes settles after exactly one plugins.txt write', async () => {
    const { root, instance, syncs, plugins } = await wiredInstance();

    await writeFile(join(root, 'mods', 'Provider', 'New.esp'), 'plugin');
    const mods = watcherFor('mods/**');
    for (let i = 0; i < 5; i++) mods.fireChange();

    const { writes, quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect(writes).toBe(1);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });
});

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const GAME_ROOT = '/game';

const foldersOf = (...names: string[]): ModFolders => {
  const all = names.map((name): ModFolder => ({ kind: 'mod', name, path: `/mods/${name}` }));
  return { all, holding: (entry) => all.find((folder) => folder.kind === entry.kind && folder.name === entry.name) };
};

const withProvider = (overrides: Partial<InstanceReading> = {}): Partial<InstanceReading> => ({
  mods: [mod('Provider')],
  modFolders: foldersOf('Provider'),
  modFiles: new Map([['Provider', { origin: 'Provider', folder: '/mods/Provider', files: [fileIn('Base.esp')], folders: [], notes: [] }]]),
  pluginOrder: [{ name: 'Base.esp', enabled: true }],
  gameFolder: { kind: 'found', root: GAME_ROOT, dataFolder: `${GAME_ROOT}/Data` },
  dataFolderPlugins: { kind: 'listed', names: new Set() },
  ...overrides,
});

function fileIn(relativePath: string) {
  return { relativePath, path: `/mods/Provider/${relativePath}`, sourcePath: `/mods/Provider/${relativePath}`, excluded: false, excludedByName: false };
}

const pluginChanges = (fake: ReturnType<typeof fakeInstanceAdapter>) =>
  fake.calls.flatMap((call) => (call.verb === 'changePluginOrder' ? call.changes : []));

async function settledFakeInstance(overrides: Partial<InstanceReading> = withProvider()) {
  const fake = fakeInstanceAdapter(readingFixture(overrides));
  const instance = new Instance({
    window: STEADY_WINDOW, adapter: fake.adapter, log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  instances.push(instance);
  const syncs: Promise<PluginSyncResult>[] = [];
  const loadedWithNoLine: (readonly string[] | undefined)[] = [];
  instanceSyncs({
    instance, channel: { error: () => {}, info: () => {} }, syncMods: noModSync,
    syncPlugins: (args) => {
      loadedWithNoLine.push(args.loadedWithNoLine);
      const run = pluginSyncOver(fake.adapter)(args);
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await syncs[syncs.length - 1];
  fake.calls.length = 0;
  return { fake, instance, syncs, loadedWithNoLine };
}

describe('plugin sync, as the Instance value drives it', () => {
  it('a burst that leaves plugins.txt already matching disk changes nothing at all', async () => {
    const { fake, instance, syncs } = await settledFakeInstance();
    const before = instance.sequence;

    for (let i = 0; i < 5; i++) fake.changed();
    await pastSequence(instance, before);
    const result = await syncs[syncs.length - 1];

    expect(result).toMatchObject({ applied: true, wrote: false });
    expect(pluginChanges(fake)).toEqual([]);
  });

  it('prunes against the Data-folder presence the value carries, keeping what Data provides', async () => {
    const { fake, instance, syncs } = await settledFakeInstance();

    fake.read({
      pluginOrder: [{ name: 'Base.esp', enabled: true }, { name: 'DLCCoast.esm', enabled: true }, { name: 'Gone.esp', enabled: true }],
      dataFolderPlugins: { kind: 'listed', names: new Set(['DLCCoast.esm']) },
    });
    await instance.refresh();
    await syncs[syncs.length - 1];

    expect(pluginChanges(fake)).toEqual([{ kind: 'drop', plugin: 'Gone.esp' }]);
  });

  it('hands each run the no-line plugins of the game the Instance read', async () => {
    const { loadedWithNoLine } = await settledFakeInstance(withProvider({
      gameRelease: 'SkyrimSE', dataFolderPlugins: { kind: 'listed', names: new Set(['Skyrim.esm']) },
    }));

    expect(loadedWithNoLine.at(-1)).toEqual(['Skyrim.esm']);
  });

  it('keeps the line the mod manager wrote after the value was read, in its place and state, through the next value\'s sync', async () => {
    const { fake, instance, syncs } = await settledFakeInstance();
    const readBefore = instance.value;
    fake.read({
      mods: [mod('Extra'), mod('Provider')],
      modFiles: new Map([
        ['Extra', { origin: 'Extra', folder: '/mods/Extra', files: [fileIn('Extra.esp')], folders: [], notes: [] }],
        ['Provider', { origin: 'Provider', folder: '/mods/Provider', files: [fileIn('Base.esp')], folders: [], notes: [] }],
      ]),
      pluginOrder: [{ name: 'Extra.esp', enabled: true }, { name: 'Base.esp', enabled: true }],
    });

    await pluginSyncOver(fake.adapter)(readBefore.pluginSyncArguments);
    await instance.refresh();
    await syncs[syncs.length - 1];

    expect(pluginChanges(fake)).toEqual([]);
  });
});

describe('the game folder not found, across the whole instance', () => {
  it('is exactly one Output line from every Instance-driven writer, however many values land', async () => {
    const fake = fakeInstanceAdapter(readingFixture(withProvider({ gameFolder: GAME_FOLDER_NOT_FOUND, dataFolderPlugins: { kind: 'unresolved' } })));
    const output: string[] = [];
    const write = (line: string): void => { output.push(line); };
    const channel = { error: write, warn: write, info: write };
    const instance = new Instance({ window: STEADY_WINDOW, adapter: fake.adapter, log: channel });
    instances.push(instance);
    toolboxes.push(new ToolboxProvider({ instance, channel }));
    const { pluginSync, modSync } = instanceSyncs({
      instance, channel, syncMods: modSyncOver(fake.adapter), syncPlugins: pluginSyncOver(fake.adapter),
    });

    await instance.refresh();
    await instance.refresh();
    await instance.refresh();
    await pluginSync.settled();
    await modSync.settled();

    expect(output).toEqual([
      '[instance] Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameDirectory: not set; ' +
        "ModOrganizer.ini's gamePath: not set; the Steam install: the game is in no Steam library. " +
        'Set modbench.mods.gameDirectory to the game folder to fix it.',
    ]);
    expect(pluginSync.message()).toBeUndefined();
  });
});

describe('a gesture writes the profile the Instance last landed', () => {
  it('lands on the new profile after a switch, with no refresh asked for', async () => {
    const { fake, instance } = await settledFakeInstance();
    const before = instance.sequence;

    fake.read({ profile: 'Secondary' });
    fake.changed();
    expect(await pastSequenceWithin(instance, before, 5000)).not.toBe(TIMED_OUT);

    const result = await pluginsCommandsWith(fake.adapter).setPluginsEnabled(instance.value.activeProfile, ['Base.esp'], false);

    expect(result).toEqual({ applied: true, outcome: { landed: ['Base.esp'], refused: [] } });
    expect(fake.calls.at(-1)).toEqual({ verb: 'changePluginOrder', profile: 'Secondary', changes: [{ kind: 'enable', plugin: 'Base.esp', enabled: false }] });
  });
});

describe('plugin sync, as each landed value drives it', () => {
  it('runs on every value that lands, from the first', async () => {
    const profiles: string[] = [];
    const instance = new FakeInstance(instanceValueFixture());
    const { pluginSync } = instanceSyncs({
      instance, syncMods: noModSync, channel: { error: vi.fn(), info: vi.fn() },
      syncPlugins: ({ profile }) => {
        profiles.push(profile);
        return Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] });
      },
    });

    instance.publish(instanceValueFixture({ activeProfile: 'First' }));
    instance.publish(instanceValueFixture({ activeProfile: 'Second' }));
    await pluginSync.settled();

    expect(profiles).toEqual(['First', 'Second']);
  });

  it('says a refusal on the Plugins view\'s message line as plugins.txt not synced', async () => {
    const instance = new FakeInstance(instanceValueFixture());
    const { pluginSync } = instanceSyncs({
      instance, syncMods: noModSync, channel: { error: vi.fn(), info: vi.fn() },
      syncPlugins: () => Promise.resolve({ applied: false, refusal: "the game's Data folder cannot be listed: EACCES" }),
    });

    instance.publish(instance.value);
    await pluginSync.settled();

    expect(pluginSync.message()).toBe("plugins.txt is not synced: the game's Data folder cannot be listed: EACCES.");
  });

  it('names plugins.txt in the Output line for the lines it added', async () => {
    const instance = new FakeInstance(instanceValueFixture());
    const channel = { error: vi.fn(), info: vi.fn() };
    const { pluginSync } = instanceSyncs({
      instance, syncMods: noModSync, channel,
      syncPlugins: () => Promise.resolve({ applied: true, wrote: true, added: ['New.esp'], dropped: [] }),
    });

    instance.publish(instance.value);
    await pluginSync.settled();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('1 disabled plugins.txt line(s)'));
  });
});
