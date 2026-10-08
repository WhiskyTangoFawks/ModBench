import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../test/mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';
import { adapterOver, STEADY_WINDOW } from './mo2/adapterOver';

vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import { instanceSyncs } from '../syncWiring';
import { FakeInstance } from './mo2/fakeInstance';
import { pastSequence, watcherFor } from './mo2/instanceLoop';
import { pluginSyncOver, setPluginsEnabled, type PluginSyncResult } from '../pluginsCommands/plugins';
import { present } from '../ports/present';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../test/mo2/gameFolderNotFound';
import { ToolboxProvider } from '../toolbox/ToolboxProvider';
import { modSyncOver, type ModSyncResult } from '../modlist/modlist';

const noModSync = () => Promise.resolve<ModSyncResult>({ applied: true, added: [], dropped: [] });

const PROFILE = 'Default';
const OTHER_PROFILE = 'Secondary';
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

async function wiredInstance(gameName = 'Fallout 4'): Promise<{
  root: string;
  instance: Instance;
  syncs: Promise<PluginSyncResult>[];
  loadedWithNoLine: (readonly string[] | undefined)[];
  plugins: () => Promise<string>;
  pluginsOf: (profile: string) => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'plugins-loop-'));
  roots.push(root);
  await mkdir(join(root, 'mods', 'Provider'), { recursive: true });
  await mkdir(join(root, 'profiles', PROFILE), { recursive: true });
  await mkdir(join(root, 'profiles', OTHER_PROFILE), { recursive: true });
  await mkdir(join(root, 'Game', 'Data'), { recursive: true });
  await writeFile(join(root, 'ModOrganizer.ini'), INI.replace('Fallout 4', gameName));
  await writeFile(join(root, 'profiles', PROFILE, 'modlist.txt'), '+Provider\r\n');
  await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
  await writeFile(join(root, 'profiles', OTHER_PROFILE, 'modlist.txt'), '+Provider\r\n');
  await writeFile(join(root, 'profiles', OTHER_PROFILE, 'plugins.txt'), '*Base.esp\r\n');
  await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');

  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } }),
    log: () => {}, logReadFailure: () => {},
  });
  instances.push(instance);

  const syncs: Promise<PluginSyncResult>[] = [];
  const loadedWithNoLine: (readonly string[] | undefined)[] = [];
  instanceSyncs({
    instance, channel: { error: () => {}, info: () => {} }, syncMods: noModSync,
    syncPlugins: (args) => {
      loadedWithNoLine.push(args.loadedWithNoLine);
      const run = pluginSyncOver(adapterOver(root))(args);
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await syncs[syncs.length - 1];

  const pluginsOf = (profile: string) => readFile(join(root, 'profiles', profile, 'plugins.txt'), 'utf8');
  return { root, instance, syncs, loadedWithNoLine, plugins: () => pluginsOf(PROFILE), pluginsOf };
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

  it('a burst that leaves plugins.txt already matching disk writes nothing at all', async () => {
    const { instance, syncs, plugins } = await wiredInstance();

    const mods = watcherFor('mods/**');
    for (let i = 0; i < 5; i++) mods.fireChange();

    const { writes, quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect(writes).toBe(0);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('prunes against the Data-folder presence the value carries, keeping what Data provides', async () => {
    const { root, instance, syncs, plugins } = await wiredInstance();
    await writeFile(join(root, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');
    await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n*DLCCoast.esm\r\n*Gone.esp\r\n');

    watcherFor('profiles/*/plugins.txt').fireChange();
    const { quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
  });

  it('hands each run the no-line plugins of the game the Instance read, not the fixture\'s usual Fallout 4', async () => {
    const { root, instance, syncs, loadedWithNoLine } = await wiredInstance('Skyrim Special Edition');
    await writeFile(join(root, 'Game', 'Data', 'Skyrim.esm'), 'vanilla');

    watcherFor('mods/**').fireChange();
    await driveToQuiescence(instance, syncs, 8);

    expect(loadedWithNoLine.at(-1)).toEqual(['Skyrim.esm']);
  });
});

describe('plugin sync keeps another tool\'s plugins.txt write', () => {
  it('keeps the line the mod manager wrote after the value was read, in its place and state, through the next value\'s sync', async () => {
    const { root, instance, syncs, plugins } = await wiredInstance();
    const readBefore = instance.value;
    await mkdir(join(root, 'mods', 'Extra'), { recursive: true });
    await writeFile(join(root, 'mods', 'Extra', 'Extra.esp'), 'plugin');
    await writeFile(join(root, 'profiles', PROFILE, 'modlist.txt'), '+Extra\r\n+Provider\r\n');
    await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Extra.esp\r\n*Base.esp\r\n');

    await pluginSyncOver(adapterOver(root))(readBefore.pluginSyncArguments);
    watcherFor('profiles/*/plugins.txt').fireChange();
    const { writes, quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect({ writes, quiescent }).toEqual({ writes: 0, quiescent: true });
    expect(await plugins()).toBe('*Extra.esp\r\n*Base.esp\r\n');
  });
});

describe('the game folder not found, across the whole instance', () => {
  it('is exactly one Output line from every Instance-driven writer, however many values land', async () => {
    const root = await mkdtemp(join(tmpdir(), 'game-not-found-'));
    roots.push(root);
    await mkdir(join(root, 'mods', 'Provider'), { recursive: true });
    await mkdir(join(root, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), INI);
    await writeFile(join(root, 'profiles', PROFILE, 'modlist.txt'), '+Provider\r\n');
    await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
    await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');
    const output: string[] = [];
    const write = (line: string): void => { output.push(line); };
    const channel = { error: write, warn: write, info: write };
    const instance = new Instance({
      window: STEADY_WINDOW,
      adapter: adapterOver(root, { gameFolder: GAME_FOLDER_NOT_FOUND }), log: write, logReadFailure: write,
    });
    instances.push(instance);
    toolboxes.push(new ToolboxProvider({ instance, channel }));
    const { pluginSync, modSync } = instanceSyncs({
      instance, channel, syncMods: modSyncOver(adapterOver(root)), syncPlugins: pluginSyncOver(adapterOver(root)),
    });

    await instance.refresh();
    for (const glob of ['profiles/*/plugins.txt', 'mods/**', 'profiles/*/plugins.txt']) {
      const before = instance.sequence;
      watcherFor(glob).fireChange();
      expect(await pastSequenceWithin(instance, before, 5000)).not.toBe(TIMED_OUT);
    }
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
    const { root, instance, pluginsOf } = await wiredInstance();
    await instance.refresh();
    const before = instance.sequence;

    await adapterOver(root).selectProfile(OTHER_PROFILE);
    watcherFor('ModOrganizer.ini').fireChange();
    expect(await pastSequenceWithin(instance, before, 5000)).not.toBe(TIMED_OUT);

    const result = await setPluginsEnabled(adapterOver(root), instance.value.activeProfile, ['Base.esp'], false);

    expect(result).toEqual({ applied: true, outcome: { landed: ['Base.esp'], refused: [] } });
    expect(await pluginsOf(OTHER_PROFILE)).toBe('Base.esp\r\n');
    expect(await pluginsOf(PROFILE)).toBe('*Base.esp\r\n');
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
