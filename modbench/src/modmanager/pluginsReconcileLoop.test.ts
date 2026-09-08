import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from './test/fakeVscodeWatcher';
import type { ConfigLike, DetectWinePrefix } from './gameDirectory';
import type { ConfigChangeEvent } from './gameDirectoryResolver';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from './instance';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { registerPluginsReconcile } from './pluginsReconcileTrigger';
import { reconcilePlugins, type PluginsReconcileResult } from './commands/plugins';

const PROFILE = 'Default';
const INI = '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n';
const noDetectWinePrefix: DetectWinePrefix = () => Promise.resolve(null);

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
  return found[0];
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

async function wiredInstance(): Promise<{
  root: string;
  instance: Instance;
  reconciles: Promise<PluginsReconcileResult>[];
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

  const source = new Mo2ModlistSource(root);
  const config: ConfigLike = { get: (key) => (key === 'mods.gameDirectory' ? join(root, 'Game') : undefined) };
  const instance = new Instance({
    instanceRoot: root,
    source,
    config: () => config,
    detectPaths: () => Promise.resolve(null),
    detectWinePrefix: noDetectWinePrefix,
    onConfigChange: (_listener: (e: ConfigChangeEvent) => void) => ({ dispose: () => {} }),
    log: () => {},
  });
  instances.push(instance);

  const reconciles: Promise<PluginsReconcileResult>[] = [];
  registerPluginsReconcile(instance, (profile, dataFolder) => {
    const run = reconcilePlugins(root, profile, dataFolder, () => {});
    reconciles.push(run);
    return run;
  });

  return { root, instance, reconciles, plugins: () => readFile(join(root, 'profiles', PROFILE, 'plugins.txt'), 'utf8') };
}

// Drives the loop the way the platform does: a plugins.txt write comes back as the watcher event
// that recomputes the Instance, which runs the reconcile again.
async function driveToQuiescence(
  instance: Instance, reconciles: Promise<PluginsReconcileResult>[], maxRounds: number,
): Promise<{ writes: number; quiescent: boolean }> {
  let writes = 0;
  for (let round = 0; round < maxRounds; round++) {
    const landed = await pastSequenceWithin(instance, instance.sequence, 5000);
    if (landed === TIMED_OUT) return { writes, quiescent: true }; // no recompute left to run
    const result = await reconciles[reconciles.length - 1];
    if (!(result.applied && result.wrote)) return { writes, quiescent: true };
    writes++;
    watcherFor('profiles/*/plugins.txt').fireChange();
  }
  return { writes, quiescent: false };
}

describe('the plugins reconcile and the Instance close a loop that settles', () => {
  it('a burst of mod-folder changes settles after exactly one plugins.txt write', async () => {
    const { root, instance, reconciles, plugins } = await wiredInstance();

    await writeFile(join(root, 'mods', 'Provider', 'New.esp'), 'plugin');
    const mods = watcherFor('mods/**');
    for (let i = 0; i < 5; i++) mods.fireChange();

    const { writes, quiescent } = await driveToQuiescence(instance, reconciles, 8);

    expect(writes).toBe(1);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });

  it('a burst that leaves plugins.txt already matching disk writes nothing at all', async () => {
    const { instance, reconciles, plugins } = await wiredInstance();

    const mods = watcherFor('mods/**');
    for (let i = 0; i < 5; i++) mods.fireChange();

    const { writes, quiescent } = await driveToQuiescence(instance, reconciles, 8);

    expect(writes).toBe(0);
    expect(quiescent).toBe(true);
    expect(await plugins()).toBe('*Base.esp\r\n');
  });
});
