import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { NO_MOD_STATUSES } from './noModStatuses';
import { unreadStatus } from './unreadStatus';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';
import { adapterOver } from './mo2/adapterOver';
import { STEADY_WINDOW } from './steadyWindow';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture } from './fakeInstanceAdapter';

vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import type { InstanceReading, Mod } from '../instanceAdapter/instanceAdapter';
import { instanceSyncs } from '../syncWiring';
import { FakeInstance } from './mo2/fakeInstance';
import { pastSequence, watcherFor } from './mo2/instanceLoop';
import { pluginSyncOver, type PluginSyncRun } from '../pluginCommands/plugins';
import { present } from '../ports/present';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import { ToolboxProvider } from '../toolbox/ToolboxProvider';
import { modSyncOver, type ModSyncRun } from '../modCommands/modCommands';
import { ModStatuses } from '../mods/modStatuses';
import type { ModStatus } from '../client';
import type { ReadFailed } from '../wire/readFailed';
import { status } from './modStatusFixture';
import { NO_DEPLOYMENT_FOLDER } from './noDeploymentFolder';

const noModSync: ModSyncRun = () => Promise.resolve({ applied: true, added: [], dropped: [] });

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
  syncs: ReturnType<PluginSyncRun>[];
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

  const adapter = adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } });
  const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, adapter, log: { info: () => {}, warn: () => {}, error: () => {} } });
  instances.push(instance);

  const syncs: ReturnType<PluginSyncRun>[] = [];
  instanceSyncs({ modStatuses: NO_MOD_STATUSES,
    instance, channel: { error: () => {}, info: () => {} }, syncMods: noModSync,
    syncPlugins: () => {
      const run = pluginSyncOver(adapter, unreadStatus, NO_MOD_STATUSES)();
      syncs.push(run);
      return run;
    },
  });
  await instance.refresh();
  await syncs[syncs.length - 1];

  return { root, instance, syncs, plugins: () => readFile(join(root, 'profiles', PROFILE, 'plugins.txt'), 'utf8') };
}

async function driveToQuiescence(
  instance: Instance, syncs: ReturnType<PluginSyncRun>[], maxRounds: number,
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
    mods.fireChange();
    mods.fireChange();
    mods.fireChange();

    const { writes, quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect(writes).toBe(1);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });
});

describe('a clone opened before its mods are restored (plugins.md, The tree, story 10)', () => {
  it('keeps plugins.txt and loadorder.txt byte for byte, before mEdit answers and after', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugins-clone-'));
    roots.push(root);
    const profile = join(root, 'profiles', PROFILE);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'mods', 'Provider'), { recursive: true });
    await mkdir(join(root, 'mods', 'Unrestored'));
    await mkdir(join(root, 'Game', 'Data'), { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), INI);
    await writeFile(join(profile, 'modlist.txt'), '+Unrestored\r\n+Provider\r\n');
    await writeFile(join(profile, 'plugins.txt'), '*Unrestored.esp\r\n*Base.esp\r\n');
    await writeFile(join(profile, 'loadorder.txt'), 'Unrestored.esp\r\nBase.esp\r\n');
    await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');
    await writeFile(join(root, 'mods', 'Unrestored', 'Unrestored.manifest'), 'its manifest');
    const pluginFiles = () => Promise.all(['plugins.txt', 'loadorder.txt'].map((file) => readFile(join(profile, file), 'utf8')));
    const committed = await pluginFiles();
    const adapter = adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } });
    const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, adapter, log: { info: () => {}, warn: () => {}, error: () => {} } });
    instances.push(instance);
    let answer: readonly ModStatus[] | ReadFailed = { failed: 'unreachable' };
    const readStatus = () => Promise.resolve(answer);
    const push = new InMemoryMEditClient();
    const modStatuses = new ModStatuses(push, readStatus, () => undefined);
    const { pluginSync } = instanceSyncs({
      instance, channel: { error: () => {}, info: () => {} }, syncMods: noModSync, modStatuses,
      syncPlugins: pluginSyncOver(adapter, readStatus, modStatuses),
    });

    await instance.refresh();
    await pluginSync.settled();
    const beforeMEdit = { files: await pluginFiles(), refused: pluginSync.message() !== undefined };
    answer = [status('Provider'), status('Unrestored', { gone: ['Unrestored.esp'] })];
    push.emit({ kind: 'mod-status-changed', plugin: '', origin: '', keys: [], sequence: 0, mods: ['Provider', 'Unrestored'] });
    await vi.waitFor(() => { expect(pluginSync.message()).toBeUndefined(); });

    expect(beforeMEdit).toEqual({ files: committed, refused: true });
    expect(await pluginFiles()).toEqual(committed);
  });
});

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const GAME_ROOT = '/game';

const withProvider = (overrides: Partial<InstanceReading> = {}): Partial<InstanceReading> => ({
  mods: [mod('Provider')],
  modFolders: modFoldersOf('Provider'),
  modFiles: new Map([['Provider', { origin: 'Provider', folder: '/mods/Provider', files: [fileIn('/mods/Provider', 'Base.esp')], folders: [], notes: [] }]]),
  pluginOrder: [{ name: 'Base.esp', enabled: true }],
  gameFolder: { kind: 'found', root: GAME_ROOT, dataFolder: `${GAME_ROOT}/Data` },
  dataFolderPlugins: { kind: 'listed', names: new Set() },
  ...overrides,
});

describe('the game folder not found, across the whole instance', () => {
  it('is exactly one Output line from every Instance-driven writer, however many values land', async () => {
    const fake = fakeInstanceAdapter(readingFixture(withProvider({ gameFolder: GAME_FOLDER_NOT_FOUND, dataFolderPlugins: { kind: 'unresolved' } })));
    const output: string[] = [];
    const write = (line: string): void => { output.push(line); };
    const channel = { error: write, warn: write, info: write };
    const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, adapter: fake.adapter, log: channel });
    instances.push(instance);
    toolboxes.push(new ToolboxProvider({ instance, channel, deploymentFolder: NO_DEPLOYMENT_FOLDER, pluginsTxtPlace: () => Promise.resolve({ why: 'none' }) }));
    const { pluginSync, modSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
      instance, channel, syncMods: modSyncOver(fake.adapter), syncPlugins: pluginSyncOver(fake.adapter, unreadStatus, NO_MOD_STATUSES),
    });

    await instance.refresh();
    await instance.refresh();
    await instance.refresh();
    await pluginSync.settled();
    await modSync.settled();

    expect(output).toEqual([
      '[instance] Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameFolder: not set; ' +
        "ModOrganizer.ini's gamePath: not set; the Steam install: the game is in no Steam library. " +
        'Set modbench.mods.gameFolder to the game folder to fix it.',
    ]);
    expect(pluginSync.message()).toBeUndefined();
  });
});

describe('plugin sync, as each landed value drives it', () => {
  it('runs on every value that lands, from the first', async () => {
    const syncPlugins = vi.fn<PluginSyncRun>(() => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }));
    const instance = new FakeInstance(instanceValueFixture());
    const { pluginSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES, instance, syncMods: noModSync, channel: { error: vi.fn(), info: vi.fn() }, syncPlugins });

    instance.publish(instanceValueFixture());
    instance.publish(instanceValueFixture());
    await pluginSync.settled();

    expect(syncPlugins).toHaveBeenCalledTimes(2);
  });

  it('runs again each time mEdit\'s answer of a mod\'s status lands, for what a manifest names may have changed', async () => {
    const syncPlugins = vi.fn<PluginSyncRun>(() => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }));
    const statusesLanded = new EventEmitter<void>();
    const { pluginSync } = instanceSyncs({
      instance: new FakeInstance(instanceValueFixture()), syncMods: noModSync, channel: { error: vi.fn(), info: vi.fn() }, syncPlugins,
      modStatuses: { onDidChange: statusesLanded.event },
    });

    statusesLanded.fire();
    statusesLanded.fire();
    await pluginSync.settled();

    expect(syncPlugins).toHaveBeenCalledTimes(2);
  });
});
