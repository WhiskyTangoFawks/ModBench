// The installer writes no modlist line; a landed Instance value is what runs the adoption that
// puts one there — the same signal the plugins reconcile runs off (pluginsReconcileTrigger.ts).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from './instance';
import { registerModAdoption, type ModAdoptionOutcome } from './modAdoptionTrigger';
import { adoptMods } from './commands/modlist';
import { installFromFolder } from './commands/install';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './test/corpusFixture';
import type { ConfigLike, DetectPaths, DetectWinePrefix } from './gameDirectory';
import type { ConfigChangeEvent } from './gameDirectory';

const MOD = 'Freshly Installed Mod';
const DATA_FOLDER = '/game/Data';
const noDetectWinePrefix: DetectWinePrefix = () => Promise.resolve(null);
const autodetectsDataFolder: DetectPaths = () => Promise.resolve({ dataFolder: DATA_FOLDER, pluginsTxt: DATA_FOLDER });

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
  return found[0]!;
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

const modlistText = (root: string): Promise<string> => readFile(join(root, DEFAULT_MODLIST), 'utf8');

async function wiredInstance(): Promise<{
  root: string;
  instance: Instance;
  invalidate: ReturnType<typeof vi.fn>;
  channel: { error: ReturnType<typeof vi.fn> };
  adoptions: Promise<ModAdoptionOutcome>[];
  handed: (readonly string[])[];
}> {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const config: ConfigLike = { get: () => undefined };
  const instance = new Instance({
    instanceRoot: root,
    config: () => config,
    detectPaths: autodetectsDataFolder,
    detectWinePrefix: noDetectWinePrefix,
    onConfigChange: (_listener: (e: ConfigChangeEvent) => void) => ({ dispose: () => {} }),
    log: () => {},
  });
  instances.push(instance);
  const invalidate = vi.fn();
  const channel = { error: vi.fn() };
  const adoptions: Promise<ModAdoptionOutcome>[] = [];
  // What the trigger handed the command, so a test can hold it against the value's own field.
  const handed: (readonly string[])[] = [];
  registerModAdoption(instance, (profile, unlistedFolders) => {
    handed.push(unlistedFolders);
    const run = adoptMods(root, profile, unlistedFolders);
    adoptions.push(run);
    return run;
  }, invalidate, channel);
  // The fixture ships "DragIn Manual Extract" unlisted; settle it before a test takes its own
  // baseline sequence, or the fixture's own mismatch reads as that test's effect.
  await instance.refresh();
  await adoptions[adoptions.length - 1];
  invalidate.mockClear();
  return { root, instance, invalidate, channel, adoptions, handed };
}

describe('registerModAdoption — driven by the Instance value', () => {
  // Rival this catches: dropping the adoption trigger, or keying it off a watcher of its own
  // again instead of the landed value. Nothing else writes the line, so the install stays
  // unlisted forever.
  it('registers the folder an install dropped in, off the Instance value alone', async () => {
    const { root, instance, invalidate, adoptions } = await wiredInstance();
    const before = instance.sequence;
    const sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    try {
      await writeFile(join(sourceFolder, 'Installed.esp'), 'plugin bytes');
      const outcome = await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder);
      expect(outcome).toMatchObject({ applied: true });
      expect(await modlistText(root)).not.toContain(MOD); // the installer wrote no line

      watcherFor('mods/**').fireCreate(join(root, 'mods', MOD, 'Installed.esp'));
      await pastSequence(instance, before);
      await adoptions[adoptions.length - 1];

      expect(await modlistText(root)).toContain(MOD);
      expect(invalidate).toHaveBeenCalled();
    } finally {
      await rm(sourceFolder, { recursive: true, force: true });
    }
  });

  // ADR-0015 invariant 1: the folders come off the value, so the command never lists mods/.
  // Rival this catches: a trigger that lists the directory itself and hands that instead.
  it('hands the command the value\'s own unlisted folders, not a listing of its own', async () => {
    const { root, instance, handed } = await wiredInstance();
    const before = instance.sequence;
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    watcherFor('mods/**').fireCreate(join(root, 'mods', 'Hand Extracted Mod'));
    const value = await pastSequence(instance, before);

    expect(handed[handed.length - 1]).toBe(value.unlistedFolders);
    expect(value.unlistedFolders).toEqual(['Hand Extracted Mod']);
  });

  // Rival this catches: invalidating on every landed value regardless of outcome, which would
  // storm the Mods tree on every unrelated recompute (a plugins.txt edit included).
  it('a further landed value once disk and modlist.txt agree changes nothing', async () => {
    const { root, instance, invalidate, adoptions } = await wiredInstance();
    const settled = await modlistText(root);
    const before = instance.sequence;

    watcherFor('profiles/*/plugins.txt').fireChange();
    await pastSequence(instance, before);
    await adoptions[adoptions.length - 1];

    expect(await modlistText(root)).toBe(settled);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

// Only `activeProfile` and `unlistedFolders` are read; the rest is unused filler cast through.
const FAKE_VALUE = { activeProfile: 'Default', unlistedFolders: [] } as unknown as InstanceValue;

function fakeInstance(): { subscribe: Instance['subscribe']; fire: () => void } {
  let subscriber: ((value: InstanceValue, seq: number) => void) | undefined;
  let seq = 0;
  return {
    subscribe: (cb: (value: InstanceValue, seq: number) => void) => {
      subscriber = cb;
      return { dispose: () => { subscriber = undefined; } };
    },
    fire: () => { seq += 1; subscriber?.(FAKE_VALUE, seq); },
  };
}

describe('registerModAdoption — outcome handling', () => {
  it('logs the command\'s own refusal instead of throwing out of the subscription', async () => {
    const instance = fakeInstance();
    const channel = { error: vi.fn() };
    const invalidate = vi.fn();
    const calls: Promise<ModAdoptionOutcome>[] = [];
    registerModAdoption(instance, () => {
      const run = Promise.resolve<ModAdoptionOutcome>({ applied: false, refusal: 'modlist.txt is locked' });
      calls.push(run);
      return run;
    }, invalidate, channel);

    expect(() => instance.fire()).not.toThrow();
    await calls[calls.length - 1];

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('modlist.txt is locked'));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('logs a thrown adoption error the same way', async () => {
    const instance = fakeInstance();
    const channel = { error: vi.fn() };
    const invalidate = vi.fn();
    const calls: Promise<ModAdoptionOutcome>[] = [];
    registerModAdoption(instance, () => {
      const run = Promise.reject(new Error('disk unplugged'));
      calls.push(run);
      return run;
    }, invalidate, channel);

    expect(() => instance.fire()).not.toThrow();
    await calls[calls.length - 1]!.catch(() => undefined);

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
