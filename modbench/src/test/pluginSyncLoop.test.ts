import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers } from './mo2/fakeVscodeWatcher';
import { adapterOver } from './mo2/adapterOver';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture } from './fakeInstanceAdapter';

vi.mock('vscode', async () => {
  const host = await import('../plugins/test/vscodeHost');
  const watching = (await import('./mo2/fakeVscodeWatcher')).fakeVscodeModule();
  return { ...host, RelativePattern: watching.RelativePattern, workspace: { ...host.workspace, createFileSystemWatcher: watching.workspace.createFileSystemWatcher } };
});

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import type { InstanceReading, Mod } from '../instanceAdapter/instanceAdapter';
import { pluginsOver } from '../plugins/test/pluginsOver';
import { pastSequence, watcherOver } from './mo2/instanceLoop';
import { pluginSyncOver, type PluginSyncRun } from '../pluginCommands/plugins';
import { present } from '../ports/present';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import { ToolboxProvider } from '../toolbox/ToolboxProvider';
import { modSyncOver } from '../modCommands/modCommands';
import { modSyncOn } from '../mods/modSync';
import { manifestedIn } from './modStatusFixture';
import { NO_DEPLOYMENT_FOLDER } from './noDeploymentFolder';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';


const NOT_INDEXED = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };
const PROFILE = 'Default';
const INI = '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n';

const roots: string[] = [];
const instances: Instance[] = [];
const toolboxes: ToolboxProvider[] = [];
const views: { dispose(): void }[] = [];

afterEach(async () => {
  for (const view of views.splice(0)) view.dispose();
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

  const adapter = adapterOver(root, { gameFolderSettingValue: join(root, 'Game') });
  const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, adapter, log: { info: () => {}, warn: () => {}, error: () => {} }, medit: new InMemoryMEditClient(), workspace: fakeWorkspace() });
  instances.push(instance);

  const syncs: ReturnType<PluginSyncRun>[] = [];
  views.push(pluginsOver({
    instance, adapter,
    syncPlugins: () => {
      const run = pluginSyncOver(adapter, NOT_INDEXED)();
      syncs.push(run);
      return run;
    },
  }));
  await instance.refresh();
  await syncs[syncs.length - 1];

  return { root, instance, syncs, plugins: () => readFile(join(root, 'profiles', PROFILE, 'plugins.txt'), 'utf8') };
}

async function driveToQuiescence(
  root: string, instance: Instance, syncs: ReturnType<PluginSyncRun>[], maxRounds: number,
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
    watcherOver(join(root, 'profiles', PROFILE)).fireChange(join(root, 'profiles', PROFILE, 'plugins.txt'));
  }
  return { writes, quiescent: false };
}

describe('plugin sync and the Instance close a loop that settles', () => {
  it('a burst of mod-folder changes settles after exactly one plugins.txt write', async () => {
    const { root, instance, syncs, plugins } = await wiredInstance();

    await writeFile(join(root, 'mods', 'Provider', 'New.esp'), 'plugin');
    const provider = watcherOver(join(root, 'mods'));
    provider.fireCreate(join(root, 'mods', 'Provider', 'New.esp'));
    provider.fireChange(join(root, 'mods', 'Provider', 'New.esp'));
    provider.fireChange(join(root, 'mods', 'Provider', 'New.esp'));

    const { writes, quiescent } = await driveToQuiescence(root, instance, syncs, 8);

    expect(writes).toBe(1);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });
});

describe('a clone opened before its mods are restored (plugins.md, The tree, story 10)', () => {
  it('keeps plugins.txt and loadorder.txt byte for byte', async () => {
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
    await manifestedIn(join(root, 'mods', 'Unrestored'), ['Unrestored.esp']);
    const pluginFiles = () => Promise.all(['plugins.txt', 'loadorder.txt'].map((file) => readFile(join(profile, file), 'utf8')));
    const committed = await pluginFiles();
    const adapter = adapterOver(root, { gameFolderSettingValue: join(root, 'Game') });
    const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, adapter, log: { info: () => {}, warn: () => {}, error: () => {} }, medit: new InMemoryMEditClient(), workspace: fakeWorkspace() });
    instances.push(instance);
    const plugins = pluginsOver({ instance, adapter, syncPlugins: pluginSyncOver(adapter, NOT_INDEXED) });
    views.push(plugins);

    await instance.refresh();

    expect([await pluginFiles(), plugins.output]).toEqual([committed, []]);
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
    const instance = new Instance({ gameFolderSettingId: GAME_FOLDER_SETTING_ID, adapter: fake.adapter, log: channel, medit: new InMemoryMEditClient(), workspace: fakeWorkspace() });
    instances.push(instance);
    toolboxes.push(new ToolboxProvider({ instance, channel, deploymentFolder: NO_DEPLOYMENT_FOLDER, pluginsTxtPlace: () => Promise.resolve({ why: 'none' }) }));
    const { modSync } = modSyncOn({ instance, channel, syncMods: modSyncOver(fake.adapter) });
    const plugins = pluginsOver({ instance, adapter: fake.adapter, syncPlugins: pluginSyncOver(fake.adapter, NOT_INDEXED) });
    views.push(plugins);

    await instance.refresh();
    await instance.refresh();
    await instance.refresh();
    await modSync.settled();

    expect([output, plugins.output]).toEqual([[
      '[instance] Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameFolder: not set; ' +
        "ModOrganizer.ini's gamePath: not set; the Steam install: the game is in no Steam library. " +
        'Set modbench.mods.gameFolder to the game folder to fix it.',
    ], []]);
  });
});
