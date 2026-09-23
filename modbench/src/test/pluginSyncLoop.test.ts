import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../test/mo2/fakeVscodeWatcher';
import type { GameDirectoryResolver } from '../instanceAdapter/gameDirectory';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import { registerPluginSync } from '../pluginSyncTrigger';
import { syncPlugins, setPluginEnabled, type PluginSyncResult } from '../pluginsCommands/plugins';
import { setSelectedProfileInText } from '../mo2Codecs/modOrganizerIni';
import { present } from '../ports/present';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';

const PROFILE = 'Default';
const OTHER_PROFILE = 'Secondary';
const INI = '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const watcherFor = (glob: string): FakeWatcher => {
  const found = watchers.filter((w) => w.pattern === glob);
  expect(found).toHaveLength(1);
  return present(found[0], `the sole watcher for "${glob}"`);
};

// How a test learns a recompute landed: no sleep and no poll.
function pastSequence(instance: Instance, sequence: number): Promise<InstanceValue> {
  if (instance.sequence > sequence) return Promise.resolve(instance.value);
  return new Promise((resolve) => {
    const subscription = instance.subscribe((value, seq) => {
      if (seq <= sequence) return;
      subscription.dispose();
      resolve(value);
    });
  });
}

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
  games: string[];
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
  // Both profiles start already matching disk, so the sync never writes either of them and
  // a changed file can only be the gesture's own.
  await writeFile(join(root, 'profiles', OTHER_PROFILE, 'modlist.txt'), '+Provider\r\n');
  await writeFile(join(root, 'profiles', OTHER_PROFILE, 'plugins.txt'), '*Base.esp\r\n');
  await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');

  const resolveGameDirectory: GameDirectoryResolver = () =>
    Promise.resolve({ root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') });
  const instance = new Instance({ instanceRoot: root, resolveGameDirectory, log: () => {}, logReadFailure: () => {} });
  instances.push(instance);

  const syncs: Promise<PluginSyncResult>[] = [];
  // The game each run was handed — the backend answers a different implicit-master set per game,
  // so a run that assumed one would ask about the wrong install.
  const games: string[] = [];
  registerPluginSync(instance, (profile, provided, inData, _dataFolder, gameName) => {
    games.push(gameName);
    const run = syncPlugins(root, profile, provided, inData, () => Promise.resolve([]), () => {});
    syncs.push(run);
    return run;
  }, { error: () => {}, info: () => {} });

  const pluginsOf = (profile: string) => readFile(join(root, 'profiles', profile, 'plugins.txt'), 'utf8');
  return { root, instance, syncs, games, plugins: () => pluginsOf(PROFILE), pluginsOf };
}

// Drives the loop the way the platform does: a plugins.txt write comes back as the watcher event
// that recomputes the Instance, which runs the sync again.
async function driveToQuiescence(
  instance: Instance, syncs: Promise<PluginSyncResult>[], maxRounds: number,
): Promise<{ writes: number; quiescent: boolean }> {
  let writes = 0;
  for (let round = 0; round < maxRounds; round++) {
    const landed = await pastSequenceWithin(instance, instance.sequence, 5000);
    if (landed === TIMED_OUT) return { writes, quiescent: true }; // no recompute left to run
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

  // Rival: hand the run no Data-folder presence. Nothing is then prunable, so the dead line
  // below stays and the DLC line survives for the wrong reason.
  it('prunes against the Data-folder presence the value carries, keeping what Data provides', async () => {
    const { root, instance, syncs, plugins } = await wiredInstance();
    await writeFile(join(root, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');
    await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n*DLCCoast.esm\r\n*Gone.esp\r\n');

    watcherFor('profiles/*/plugins.txt').fireChange();
    const { quiescent } = await driveToQuiescence(instance, syncs, 8);

    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
  });

  // The implicit-master set is per game, and only the Instance knows which game this is. A run
  // handed a hardcoded one would ask the backend about another install.
  it('hands each run the game the Instance read, not an assumed one', async () => {
    // Deliberately not Fallout 4: a run that hardcoded the fixture's usual game would pass.
    const { instance, syncs, games } = await wiredInstance('Skyrim Special Edition');

    watcherFor('mods/**').fireChange();
    await driveToQuiescence(instance, syncs, 8);

    expect(games.length).toBeGreaterThan(0);
    expect([...new Set(games)]).toEqual(['Skyrim Special Edition']);
  });
});

// A gesture writes `profiles/<profile>/plugins.txt` for the profile the Instance last landed, so
// a value that missed a switch would silently edit the profile the user just left.
describe('a gesture writes the profile the Instance last landed', () => {
  it('lands on the new profile after a switch, with no refresh asked for', async () => {
    const { root, instance, pluginsOf } = await wiredInstance();
    await instance.refresh();
    const before = instance.sequence;

    const ini = join(root, 'ModOrganizer.ini');
    await writeFile(ini, setSelectedProfileInText(await readFile(ini, 'utf8'), OTHER_PROFILE));
    watcherFor('ModOrganizer.ini').fireChange();
    expect(await pastSequenceWithin(instance, before, 5000)).not.toBe(TIMED_OUT);

    // Exactly what the composition root binds into the tree's source.
    const result = await setPluginEnabled(root, instance.value.activeProfile, 'Base.esp', false);

    expect(result).toEqual({ applied: true, wrote: true });
    expect(await pluginsOf(OTHER_PROFILE)).toBe('Base.esp\r\n');
    expect(await pluginsOf(PROFILE)).toBe('*Base.esp\r\n');
  });
});

function firedOnce(outcome: () => Promise<PluginSyncResult>): {
  channel: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  run: () => Promise<unknown>;
} {
  let subscriber: ((value: InstanceValue, seq: number) => void) | undefined;
  const instance = {
    subscribe: (cb: (value: InstanceValue, seq: number) => void) => {
      subscriber = cb;
      return { dispose: () => { subscriber = undefined; } };
    },
  };
  const channel = { error: vi.fn(), info: vi.fn() };
  const calls: Promise<PluginSyncResult>[] = [];
  registerPluginSync(instance, () => {
    const run = outcome();
    calls.push(run);
    return run;
  }, channel);
  expect(() => subscriber?.(instanceValueFixture(), 1)).not.toThrow();
  return { channel, run: () => present(calls[calls.length - 1], 'the sync the fire triggered').catch(() => undefined) };
}

describe('registerPluginSync — outcome handling', () => {
  it('logs the lines it added and dropped, one Output line each way', async () => {
    const { channel, run } = firedOnce(() => Promise.resolve<PluginSyncResult>(
      { applied: true, wrote: true, added: ['New.esp'], dropped: ['Gone.esp'] }));
    await run();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New.esp'));
    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone.esp'));
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('logs nothing when the file already agrees', async () => {
    const { channel, run } = firedOnce(() => Promise.resolve<PluginSyncResult>(
      { applied: true, wrote: false, added: [], dropped: [] }));
    await run();

    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('logs the command\'s own refusal', async () => {
    const { channel, run } = firedOnce(() => Promise.resolve<PluginSyncResult>(
      { applied: false, refusal: 'plugins.txt is locked' }));
    await run();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('plugins.txt is locked'));
  });

  // Rival: `void run(...)` with no catch, which leaves the rejection unhandled and the Output silent.
  it('logs a thrown sync error the same way', async () => {
    const { channel, run } = firedOnce(() => Promise.reject(new Error('disk unplugged')));
    await run();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
  });
});
