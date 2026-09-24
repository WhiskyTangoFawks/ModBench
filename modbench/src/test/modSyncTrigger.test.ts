// The installer writes no modlist line and a hand-deleted folder leaves its line behind; a landed
// Instance value is what runs the mod sync that settles both.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { registerModSync } from '../modSyncTrigger';
import { syncMods, type ModSyncResult } from '../modlist/modlist';
import { installFromFolder } from '../install/install';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../test/mo2/corpusFixture';
import type { GameDirectoryResolver } from '../instanceAdapter/gameDirectory';
import { downloadsDirectoryResolver } from '../instanceAdapter/downloadsDirectory';
import { modsDir } from '../instanceAdapter/layout';
import { present } from '../ports/present';

const MOD = 'Freshly Installed Mod';
const DATA_FOLDER = '/game/Data';
const resolvesDataFolder: GameDirectoryResolver = () =>
  Promise.resolve({ kind: 'found', root: '/game', dataFolder: DATA_FOLDER });

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
  return present(found[0], 'the sole watcher registered for this glob');
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

const channelDouble = () => ({ error: vi.fn(), info: vi.fn() });

async function wiredInstance(): Promise<{
  root: string;
  instance: Instance;
  channel: ReturnType<typeof channelDouble>;
  syncs: Promise<ModSyncResult>[];
  handed: (readonly string[] | undefined)[];
}> {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: resolvesDataFolder,
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
    log: () => {},
    logReadFailure: () => {},
  });
  instances.push(instance);
  const channel = channelDouble();
  const syncs: Promise<ModSyncResult>[] = [];
  // What the trigger handed the command, so a test can hold it against the value's own field.
  const handed: (readonly string[] | undefined)[] = [];
  registerModSync(instance, (profile, modFolders) => {
    handed.push(modFolders);
    const run = syncMods(root, profile, modFolders);
    syncs.push(run);
    return run;
  }, channel);
  // The fixture ships "DragIn Manual Extract" unlisted and "[NODELETE] Radfall" folderless;
  // settle both before a test takes its own baseline, or the fixture's mismatch reads as the
  // test's effect.
  await instance.refresh();
  await syncs[syncs.length - 1];
  channel.info.mockClear();
  return { root, instance, channel, syncs, handed };
}

describe('registerModSync — driven by the Instance value', () => {
  // Rival: dropping the sync trigger, or keying it off a watcher of its own instead of the landed
  // value. Nothing else writes the line, so the install stays unlisted forever.
  it('adds a line for the folder an install dropped in, off the Instance value alone', async () => {
    const { root, instance, syncs } = await wiredInstance();
    const before = instance.sequence;
    const sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    try {
      await writeFile(join(sourceFolder, 'Installed.esp'), 'plugin bytes');
      const outcome = await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: 'Fallout 4' });
      expect(outcome).toMatchObject({ applied: true });
      expect(await modlistText(root)).not.toContain(MOD); // the installer wrote no line

      watcherFor('mods/**').fireCreate(join(root, 'mods', MOD, 'Installed.esp'));
      await pastSequence(instance, before);
      await syncs[syncs.length - 1];

      expect(await modlistText(root)).toContain(MOD);
    } finally {
      await rm(sourceFolder, { recursive: true, force: true });
    }
  });

  it('drops the line of a folder deleted by hand, off the Instance value alone', async () => {
    const { root, instance, syncs } = await wiredInstance();
    const before = instance.sequence;
    await rm(join(root, 'mods', 'Harder VATS'), { recursive: true, force: true });

    watcherFor('mods/**').fireDelete(join(root, 'mods', 'Harder VATS'));
    await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(await modlistText(root)).not.toContain('Harder VATS');
  });

  // Rival: the value reading a missing mods/ as no folders, which empties modlist.txt.
  it('leaves modlist.txt as it is, and says why in one Output line, when mods/ goes missing', async () => {
    const { root, instance, channel, syncs } = await wiredInstance();
    const settled = await modlistText(root);
    const before = instance.sequence;
    await rm(modsDir(root), { recursive: true, force: true });

    watcherFor('mods/**').fireDelete(modsDir(root));
    await pastSequence(instance, before);
    await syncs[syncs.length - 1];

    expect(await modlistText(root)).toBe(settled);
    expect(channel.error).toHaveBeenCalledTimes(1);
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining(modsDir(root)));
  });

  // The folders come off the value, so the command never lists mods/.
  // Rival: a trigger that lists the directory itself and hands that instead.
  it('hands the command the value\'s own mod folders, not a listing of its own', async () => {
    const { root, instance, handed } = await wiredInstance();
    const before = instance.sequence;
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    watcherFor('mods/**').fireCreate(join(root, 'mods', 'Hand Extracted Mod'));
    const value = await pastSequence(instance, before);

    expect(handed[handed.length - 1]).toBe(value.modFolders);
    expect(value.modFolders).toContain('Hand Extracted Mod');
  });

  // Rival: a sync that writes on every landed value, which a plugins.txt edit would turn into a
  // modlist.txt write and a loop.
  it('a further landed value once disk and modlist.txt agree writes nothing and logs nothing', async () => {
    const { root, instance, channel, syncs } = await wiredInstance();
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

const FAKE_VALUE: InstanceValue = instanceValueFixture({ activeProfile: 'Default', modFolders: [] });

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

function firedOnce(outcome: () => Promise<ModSyncResult>): { channel: ReturnType<typeof channelDouble>; run: () => Promise<unknown> } {
  const instance = fakeInstance();
  const channel = channelDouble();
  const calls: Promise<ModSyncResult>[] = [];
  registerModSync(instance, () => {
    const run = outcome();
    calls.push(run);
    return run;
  }, channel);
  expect(() => instance.fire()).not.toThrow();
  return { channel, run: () => present(calls[calls.length - 1], 'the sync the fire triggered').catch(() => undefined) };
}

describe('registerModSync — outcome handling', () => {
  it('logs the lines it added and dropped, one Output line each way', async () => {
    const { channel, run } = firedOnce(() => Promise.resolve<ModSyncResult>(
      { applied: true, added: ['New Mod'], dropped: ['Gone Mod'] }));
    await run();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New Mod'));
    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone Mod'));
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('logs the command\'s own refusal instead of throwing out of the subscription', async () => {
    const { channel, run } = firedOnce(() => Promise.resolve<ModSyncResult>(
      { applied: false, refusal: 'modlist.txt is locked' }));
    await run();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('modlist.txt is locked'));
  });

  it('logs a thrown sync error the same way', async () => {
    const { channel, run } = firedOnce(() => Promise.reject(new Error('disk unplugged')));
    await run();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
  });
});
