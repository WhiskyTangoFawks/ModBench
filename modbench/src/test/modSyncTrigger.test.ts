import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from '../instanceLoader/instance';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { registerModSync } from '../modSyncTrigger';
import { modSyncOver, type ModSyncResult } from '../modlist/modlist';
import type { ModFolder } from '../instanceAdapter/instanceAdapter';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../test/mo2/corpusFixture';
import { accessTo, adapterOver, STEADY_WINDOW } from './mo2/adapterOver';
import { present } from '../ports/present';

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

const watcherFor = (glob: string): FakeWatcher => {
  const found = watchers.filter((w) => w.pattern === glob);
  expect(found).toHaveLength(1);
  return present(found[0], 'the sole watcher registered for this glob');
};

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
  const trigger = registerModSync(instance, (value) => {
    handed.push(value.modFolders);
    const run = modSyncOver(accessTo(root))(value);
    syncs.push(run);
    return run;
  }, channel);
  await instance.refresh();
  await trigger.settled();
  channel.info.mockClear();
  return { root, instance, channel, syncs, handed };
}

describe('registerModSync — driven by the Instance value', () => {
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

const FAKE_VALUE: InstanceValue = instanceValueFixture({ activeProfile: 'Default', modFolders: [] });

function fakeInstance(value = FAKE_VALUE): Pick<Instance, 'subscribe' | 'value'> & { fire: () => void } {
  let subscriber: ((value: InstanceValue, seq: number) => void) | undefined;
  let seq = 0;
  return {
    value,
    subscribe: (cb: (value: InstanceValue, seq: number) => void) => {
      subscriber = cb;
      return { dispose: () => { subscriber = undefined; } };
    },
    fire: () => { seq += 1; subscriber?.(value, seq); },
  };
}

function fired(...outcomes: (() => Promise<ModSyncResult>)[]) {
  const instance = fakeInstance();
  const channel = channelDouble();
  const messageChanged = vi.fn();
  const calls: Promise<ModSyncResult>[] = [];
  const trigger = registerModSync(instance, () => {
    const run = present(outcomes[calls.length], 'an outcome for this fire')();
    calls.push(run);
    return run;
  }, channel);
  trigger.onMessageChanged(messageChanged);
  const fire = async (): Promise<void> => {
    expect(() => instance.fire()).not.toThrow();
    await trigger.settled();
  };
  return { channel, messageChanged, trigger, fire };
}

const refused = (refusal: string) => () => Promise.resolve<ModSyncResult>({ applied: false, refusal });
const landed = () => Promise.resolve<ModSyncResult>({ applied: true, added: [], dropped: [] });

describe('registerModSync — settled', () => {
  it('resolves once every run begun has written its Output', async () => {
    const instance = fakeInstance();
    const channel = channelDouble();
    let answer = (): void => {};
    const answered = new Promise<ModSyncResult>((resolve) => {
      answer = () => resolve({ applied: true, added: ['New Mod'], dropped: [] });
    });
    const trigger = registerModSync(instance, () => answered, channel);

    instance.fire();
    const settled = trigger.settled();
    answer();
    await settled;

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New Mod'));
  });
});

describe('registerModSync — outcome handling', () => {
  it('logs the lines it added and dropped, one Output line each way', async () => {
    const { channel, fire } = fired(() => Promise.resolve<ModSyncResult>(
      { applied: true, added: ['New Mod'], dropped: ['Gone Mod'] }));
    await fire();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('New Mod'));
    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone Mod'));
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('says the command\'s own refusal in the Output and the message line', async () => {
    const { channel, trigger, messageChanged, fire } = fired(refused('/instance/mods does not exist'));
    await fire();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('/instance/mods does not exist'));
    expect(trigger.message()).toBe('modlist.txt is not synced: /instance/mods does not exist.');
    expect(messageChanged).toHaveBeenCalledTimes(1);
  });

  it('names the file mod order is kept in as the value names it', async () => {
    const instance = fakeInstance(instanceValueFixture({ managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt' } }));
    const channel = channelDouble();
    const trigger = registerModSync(instance, () => Promise.resolve<ModSyncResult>(
      { applied: true, added: ['New Mod'], dropped: [] }), channel);
    instance.fire();
    await trigger.settled();

    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('1 order.txt line(s)'));
  });

  it('says a thrown sync error the same way', async () => {
    const { channel, trigger, fire } = fired(() => Promise.reject(new Error('disk unplugged')));
    await fire();

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('disk unplugged'));
    expect(trigger.message()).toContain('disk unplugged');
  });

  it('reports the same refusal once, however many values repeat it', async () => {
    const { channel, messageChanged, fire } = fired(refused('gone'), refused('gone'), refused('gone'));
    await fire();
    await fire();
    await fire();

    expect(channel.error).toHaveBeenCalledTimes(1);
    expect(messageChanged).toHaveBeenCalledTimes(1);
  });

  it('reports again when the reason changes', async () => {
    const { channel, trigger, fire } = fired(refused('first cause'), refused('second cause'));
    await fire();
    await fire();

    expect(channel.error).toHaveBeenCalledTimes(2);
    expect(channel.error).toHaveBeenLastCalledWith(expect.stringContaining('second cause'));
    expect(trigger.message()).toContain('second cause');
  });

  it('clears the message line when the command next lands, and reports a recurrence again', async () => {
    const { channel, trigger, messageChanged, fire } = fired(refused('gone'), landed, refused('gone'));
    await fire();
    await fire();

    expect(trigger.message()).toBeUndefined();
    expect(messageChanged).toHaveBeenCalledTimes(2);

    await fire();
    expect(channel.error).toHaveBeenCalledTimes(2);
    expect(trigger.message()).toContain('gone');
  });

  it('the latest value decides the message line, whichever run answers last', async () => {
    let answerOlder!: (outcome: ModSyncResult) => void;
    const older = new Promise<ModSyncResult>((resolve) => { answerOlder = resolve; });
    const { trigger, fire } = fired(() => older, refused('gone'));
    const newerSaid = new Promise<void>((resolve) => {
      const listening = trigger.onMessageChanged(() => { listening.dispose(); resolve(); });
    });
    const olderFire = fire();
    const newerFire = fire();
    await newerSaid;
    answerOlder({ applied: true, added: [], dropped: [] });
    await Promise.all([olderFire, newerFire]);

    expect(trigger.message()).toContain('gone');
  });

  it('a landed run with no failure before it leaves the message line alone', async () => {
    const { trigger, messageChanged, fire } = fired(landed);
    await fire();

    expect(trigger.message()).toBeUndefined();
    expect(messageChanged).not.toHaveBeenCalled();
  });
});
