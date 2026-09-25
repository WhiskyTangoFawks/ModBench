import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../test/mo2/fakeVscodeWatcher';
import type { GameDirectoryResolver } from '../instanceAdapter/gameDirectory';
import { downloadsDirectoryResolver } from '../instanceAdapter/downloadsDirectory';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import { registerPluginSync } from '../pluginSyncTrigger';
import { syncPlugins, setPluginsEnabled, type PluginSyncResult } from '../pluginsCommands/plugins';
import { setSelectedProfileInText } from '../mo2Codecs/modOrganizerIni';
import { present } from '../ports/present';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { resolvesNotFound } from '../test/mo2/gameFolderNotFound';
import { logGameFolderNotFound } from '../gameFolderNotFoundLog';
import { registerModSync } from '../modSyncTrigger';
import { syncMods } from '../modlist/modlist';
import { providedPluginsOf } from '../instanceLoader/loadOrderSnapshot';

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
    Promise.resolve({ kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') });
  const instance = new Instance({
    instanceRoot: root, resolveGameDirectory, resolveDownloadsDirectory: downloadsDirectoryResolver(),
    log: () => {}, logReadFailure: () => {},
  });
  instances.push(instance);

  const syncs: Promise<PluginSyncResult>[] = [];
  // The game each run was handed — the backend answers a different implicit-master set per game,
  // so a run that assumed one would ask about the wrong install.
  const games: string[] = [];
  const trigger = registerPluginSync(instance, (value) => {
    games.push(value.gameRelease);
    const run = syncPlugins(
      root, value.activeProfile, providedPluginsOf(value.plugins), value.dataFolderPlugins, () => Promise.resolve([]));
    syncs.push(run);
    return run;
  }, { error: () => {}, info: () => {} });
  // mEdit attached on the first value, so every value after it runs plugin sync.
  await instance.refresh();
  trigger.runOnConnect();
  await syncs[syncs.length - 1];

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

// common.md, States, story 5: the game folder not found is told once, the same way everywhere.
// Every Instance-driven writer to the Output is wired onto one channel, as the root wires them.
describe('the game folder not found, across the whole instance', () => {
  // Rival: plugin sync refusing with its own reason, a second Output line for the same cause.
  it('is exactly one Output line, however many values land after mEdit has attached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'game-not-found-'));
    roots.push(root);
    await mkdir(join(root, 'mods', 'Provider'), { recursive: true });
    await mkdir(join(root, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), INI);
    await writeFile(join(root, 'profiles', PROFILE, 'modlist.txt'), '+Provider\r\n');
    await writeFile(join(root, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
    await writeFile(join(root, 'mods', 'Provider', 'Base.esp'), 'plugin');
    // Every level of the one Output channel, in the order written.
    const output: string[] = [];
    const write = (line: string): void => { output.push(line); };
    const channel = { error: write, warn: write, info: write };
    const instance = new Instance({
      instanceRoot: root, resolveGameDirectory: resolvesNotFound,
      resolveDownloadsDirectory: downloadsDirectoryResolver(), log: write, logReadFailure: write,
    });
    instances.push(instance);
    logGameFolderNotFound(instance, (line) => channel.warn(`[instance] ${line}`));
    const pluginSync = registerPluginSync(instance, (value) => syncPlugins(
      root, value.activeProfile, providedPluginsOf(value.plugins), value.dataFolderPlugins,
      () => Promise.resolve(undefined)), channel);
    const modSync = registerModSync(instance, (value) => syncMods(root, value.activeProfile, value.modFolders), channel);

    await instance.refresh();
    pluginSync.runOnConnect();
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

    // Exactly what the composition root binds enable/disable to.
    const result = await setPluginsEnabled(root, instance.value.activeProfile, ['Base.esp'], false);

    expect(result).toEqual({ applied: true, outcome: { landed: ['Base.esp'], refused: [] } });
    expect(await pluginsOf(OTHER_PROFILE)).toBe('Base.esp\r\n');
    expect(await pluginsOf(PROFILE)).toBe('*Base.esp\r\n');
  });
});

// The Instance as the trigger reads it: a current value, and each landed value handed on.
function fired(...outcomes: (() => Promise<PluginSyncResult>)[]) {
  return firedAnswering((_profile, call) => present(outcomes[call], 'an outcome for this run')());
}

function firedAnswering(answer: (profile: string, call: number) => Promise<PluginSyncResult>) {
  let subscriber: ((value: InstanceValue, seq: number) => void) | undefined;
  let seq = 0;
  const instance = {
    value: instanceValueFixture({ activeProfile: 'Before' }),
    subscribe: (cb: (value: InstanceValue, seq: number) => void) => {
      subscriber = cb;
      return { dispose: () => { subscriber = undefined; } };
    },
  };
  const channel = { error: vi.fn(), info: vi.fn() };
  const messageChanged = vi.fn();
  const calls: Promise<PluginSyncResult>[] = [];
  const profiles: string[] = [];
  const trigger = registerPluginSync(instance, ({ activeProfile }) => {
    profiles.push(activeProfile);
    const run = answer(activeProfile, calls.length);
    calls.push(run);
    return run;
  }, channel);
  trigger.onMessageChanged(messageChanged);
  const settled = (): Promise<void> => trigger.settled();
  const land = async (value = instanceValueFixture()): Promise<void> => {
    instance.value = value;
    seq += 1;
    expect(() => subscriber?.(value, seq)).not.toThrow();
    await settled();
  };
  const connect = async (): Promise<void> => {
    trigger.runOnConnect();
    await settled();
  };
  return { instance, channel, messageChanged, trigger, profiles, land, connect };
}

// mEdit attached once, on a run that landed, so every value after it runs plugin sync.
async function firedAttached(...outcomes: (() => Promise<PluginSyncResult>)[]) {
  const harness = fired(landed, ...outcomes);
  await harness.connect();
  return harness;
}

const DATA_UNLISTABLE = "the game's Data folder cannot be listed: EACCES";
const toldAsInstanceState = () => Promise.resolve<PluginSyncResult>({ applied: false, toldAsInstanceState: true });

const refused = (refusal: string) => () => Promise.resolve<PluginSyncResult>({ applied: false, refusal });
const landed = () => Promise.resolve<PluginSyncResult>({ applied: true, wrote: false, added: [], dropped: [] });

// How a caller learns a run has told what it did: no sleep and no poll.
describe('registerPluginSync — settled', () => {
  // Rival: resolving once the command answers, before the trigger has written its Output line.
  it('resolves once every run begun has written its Output', async () => {
    const instance = { value: instanceValueFixture(), subscribe: () => ({ dispose: () => {} }) };
    const channel = { error: vi.fn(), info: vi.fn() };
    let answer = (): void => {};
    const answered = new Promise<PluginSyncResult>((resolve) => {
      answer = () => resolve({ applied: true, wrote: true, added: ['New.esp'], dropped: [] });
    });
    const trigger = registerPluginSync(instance, () => answered, channel);

    trigger.runOnConnect();
    const settled = trigger.settled();
    answer();
    await settled;

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New.esp'));
  });
});

describe('registerPluginSync — outcome handling', () => {
  it('logs the lines it added and dropped, one Output line each way', async () => {
    const { channel, land } = await firedAttached(() => Promise.resolve<PluginSyncResult>(
      { applied: true, wrote: true, added: ['New.esp'], dropped: ['Gone.esp'] }));
    await land();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New.esp'));
    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone.esp'));
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('logs nothing when the file already agrees', async () => {
    const { channel, land } = await firedAttached(landed);
    await land();

    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('says the command\'s own refusal in the Output and the Plugins view\'s message line', async () => {
    const { channel, trigger, messageChanged, land } = await firedAttached(refused(DATA_UNLISTABLE));
    await land();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining(DATA_UNLISTABLE));
    expect(trigger.message()).toBe(`plugins.txt is not synced: ${DATA_UNLISTABLE}.`);
    expect(messageChanged).toHaveBeenCalledTimes(1);
  });

  // Rival: `void run(...)` with no catch, which leaves the rejection unhandled and the Output silent.
  it('says a thrown sync error the same way', async () => {
    const { channel, trigger, land } = await firedAttached(() => Promise.reject(new Error('disk unplugged')));
    await land();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
    expect(trigger.message()).toContain('disk unplugged');
  });

  // Rival: log every refused run, which fills the Output with one line per recompute.
  it('reports the same refusal once, and clears the message line when a run lands', async () => {
    const reason = 'mEdit cannot say which plugins the game loads with no line';
    const { channel, trigger, land } = await firedAttached(refused(reason), refused(reason), landed);
    await land();
    await land();
    expect(channel.error).toHaveBeenCalledTimes(1);

    await land();
    expect(trigger.message()).toBeUndefined();
  });

  // Rival: report only the first refusal, so a Data folder listed after mEdit went quiet keeps
  // showing the listing.
  it('reports again when the reason changes', async () => {
    const { channel, trigger, messageChanged, land } = await firedAttached(
      refused(DATA_UNLISTABLE), refused('mEdit cannot say which plugins the game loads with no line'));
    await land();
    await land();

    expect(channel.error).toHaveBeenCalledTimes(2);
    expect(channel.error).toHaveBeenLastCalledWith(expect.stringContaining('mEdit cannot say'));
    expect(trigger.message()).toBe('plugins.txt is not synced: mEdit cannot say which plugins the game loads with no line.');
    expect(messageChanged).toHaveBeenCalledTimes(2);
  });
});

// update-load-order-file, Refusals: a game folder that is not found writes nothing, and is told
// once, as the instance's state (common.md, States, story 5).
describe('registerPluginSync — the game folder not found', () => {
  // Rival: report it as the command's own refusal, a second telling beside the instance's state.
  it('reports nothing of its own: no Output line and no message line', async () => {
    const { channel, trigger, messageChanged, land } = await firedAttached(toldAsInstanceState);
    await land();

    expect(channel.error).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
    expect(trigger.message()).toBeUndefined();
    expect(messageChanged).not.toHaveBeenCalled();
  });

  // Rival: leave the standing refusal alone, so the message line keeps a cause plugin sync no
  // longer has beside the instance's own.
  it('takes its own standing refusal off the message line', async () => {
    const { trigger, land } = await firedAttached(refused(DATA_UNLISTABLE), toldAsInstanceState);
    await land();

    await land();

    expect(trigger.message()).toBeUndefined();
  });
});

// update-load-order-file, Refusals: before mEdit first attaches, plugin sync waits and runs on
// attach, so a launch reports nothing.
describe('registerPluginSync — before mEdit first attaches', () => {
  // Rival: run on every landed value from the start, which tells every launch that mEdit cannot say.
  it('a launch then an attach reports nothing, and the attach runs on the current value', async () => {
    const { channel, trigger, messageChanged, profiles, land, connect } = firedAnswering((profile) =>
      (profile === 'Current' ? landed() : refused('mEdit cannot say which plugins the game loads with no line')()));
    await land(instanceValueFixture({ activeProfile: 'Launched' }));
    await land(instanceValueFixture({ activeProfile: 'Current' }));

    await connect();

    expect(profiles).toEqual(['Current']);
    expect(channel.error).not.toHaveBeenCalled();
    expect(trigger.message()).toBeUndefined();
    expect(messageChanged).not.toHaveBeenCalled();
  });

  // Rival: run only on connect, so a value landing between connects waits for the next one.
  it('runs on every value that lands once mEdit has attached', async () => {
    const { profiles, land, connect } = fired(landed, landed);
    await connect();

    await land(instanceValueFixture({ activeProfile: 'Landed' }));

    expect(profiles).toEqual(['Before', 'Landed']);
  });
});

// update-load-order-file, The flow: mEdit answers which plugins load with no line, so a connect
// after it went away is a moment plugin sync runs again.
describe('registerPluginSync — on connect', () => {
  // Rival: no run on connect, so the refusal from while mEdit was away stands until a file changes.
  it('runs again with the current value, and a run that lands clears the refusal before it', async () => {
    const { instance, trigger, profiles, land, connect } = await firedAttached(refused('mEdit cannot say'), landed);
    await land(instanceValueFixture({ activeProfile: 'Landed' }));
    instance.value = instanceValueFixture({ activeProfile: 'Current' });

    await connect();

    expect(profiles).toEqual(['Before', 'Landed', 'Current']);
    expect(trigger.message()).toBeUndefined();
  });
});
