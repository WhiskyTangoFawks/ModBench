import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from './test/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from './test/corpusFixture';
import { setEnabledInText } from './mo2/modlistText';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, type InstanceValue } from './instance';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const DATA_FOLDER = '/game/Data';

// `readModlist` counts recomputes: the Instance reads the modlist exactly once per recompute and
// hands the entries on, so its call count is the number of recomputes that started.
// `afterModlistRead` is how a test lands a write inside the Instance's own read window, which is
// the only deterministic way to reproduce a torn read of a real file.
interface Hooks { afterModlistRead?: () => Promise<void> }

async function realInstance(hooks: Hooks = {}): Promise<{ root: string; instance: Instance; readModlist: Mock; logs: string[] }> {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const mo2 = new Mo2ModlistSource(root);
  const readModlist = vi.fn(async () => {
    const entries = await mo2.readModlist();
    await hooks.afterModlistRead?.();
    return entries;
  });
  const logs: string[] = [];
  const instance = new Instance({
    instanceRoot: root,
    source: {
      readModlist,
      readPluginOrder: () => mo2.readPluginOrder(),
      readEnabledPlugins: () => mo2.readEnabledPlugins(),
    },
    dataFolder: () => Promise.resolve(DATA_FOLDER),
    log: (msg) => logs.push(msg),
  });
  instances.push(instance);
  return { root, instance, readModlist, logs };
}

const NONO = 'Ñoño\'s Retexture';

async function writeModFile(root: string, modName: string, relativePath: string, body: string): Promise<string> {
  const path = join(root, 'mods', modName, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

// How a test learns a recompute landed: no sleep and no poll — the value that arrives past
// `sequence`, or the current one when it is already past.
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

const watcherFor = (glob: string): FakeWatcher => {
  const found = watchers.filter((w) => w.pattern === glob);
  expect(found).toHaveLength(1);
  return found[0];
};

// MO2, xEdit or the user rewriting the file, with Modbench none the wiser.
async function enableOutsideModbench(root: string, modName: string): Promise<void> {
  const path = join(root, DEFAULT_MODLIST);
  await writeFile(path, setEnabledInText(await readFile(path, 'utf8'), modName, true));
}

const isEnabled = (value: InstanceValue, name: string) => value.mods.find((m) => m.name === name)?.enabled;

describe('Instance — the value', () => {
  it('starts empty at sequence 0, before anything has been read', async () => {
    const { instance } = await realInstance();

    expect(instance.sequence).toBe(0);
    expect(instance.value.mods).toEqual([]);
    expect(instance.value.plugins).toEqual([]);
    expect(instance.value.files.size).toBe(0);
    expect(instance.value.filesByMod.size).toBe(0);
  });

  it('carries the mods in override order, with separators and enabled, after a refresh', async () => {
    const { instance } = await realInstance();

    await instance.refresh();

    expect(instance.sequence).toBe(1);
    expect(instance.value.mods.map((m) => [m.kind, m.name, m.enabled])).toEqual([
      ['mod', 'Ñoño\'s Retexture', true],
      ['mod', 'Tracked Patch Mod', true],
      ['mod', 'SKK Fast Start new game (Fallout 4)', true],
      ['separator', 'Unassigned (Modlist Development)', false],
      ['mod', '[NODELETE] Radfall', true],
      ['mod', 'Unofficial Fallout 4 Patch', true],
      ['separator', 'Radfall - All-In-One Survival Overhaul', false],
      ['mod', 'ENBoost - 12k', true],
      ['mod', 'Harder VATS', false],
      ['mod', 'Cracked and Smudged Pip-Boy Screen', true],
    ]);
  });

  it('carries the winner of a path two enabled mods provide, and each enabled mod\'s own files', async () => {
    const { root, instance } = await realInstance();
    const winner = await writeModFile(root, NONO, 'textures/shared.dds', 'winning');
    await writeModFile(root, 'Unofficial Fallout 4 Patch', 'textures/shared.dds', 'losing');
    await writeModFile(root, 'Harder VATS', 'textures/shared.dds', 'disabled');

    await instance.refresh();

    const entry = instance.value.files.get('textures/shared.dds');
    expect(entry?.winner).toBe(winner);
    expect(entry?.winnerMod).toBe(NONO);
    // "Harder VATS" is disabled, so it is not even a contender.
    expect(entry?.providers).toEqual([NONO, 'Unofficial Fallout 4 Patch']);
    expect(instance.value.filesByMod.get('Harder VATS')).toBeUndefined();
    expect(instance.value.filesByMod.get('Tracked Patch Mod')?.map((f) => f.relativePath)).toEqual(['Tracked Patch Mod.esp']);
  });

  it('carries every plugin copy — listed, unlisted and Data-folder — with origin, slot, enabled and winning', async () => {
    const { root, instance } = await realInstance();

    await instance.refresh();

    expect(instance.value.plugins).toEqual([
      { name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true },
      { name: 'Tracked Patch Mod.esp', path: join(root, 'mods', 'Tracked Patch Mod', 'Tracked Patch Mod.esp'), origin: 'Tracked Patch Mod', slot: 1, enabled: true, winning: true },
      { name: 'Unofficial Fallout 4 Patch.esp', path: join(DATA_FOLDER, 'Unofficial Fallout 4 Patch.esp'), origin: 'Data', slot: 2, enabled: true, winning: true },
      { name: 'ccSBJFO4003-Grenade.esl', path: join(DATA_FOLDER, 'ccSBJFO4003-Grenade.esl'), origin: 'Data', slot: 3, enabled: true, winning: true },
      { name: 'NonAsciiRetexture - Addon.esl', path: join(root, 'mods', NONO, 'NonAsciiRetexture - Addon.esl'), origin: NONO, slot: null, enabled: false, winning: true },
    ]);
  });

  it('sends the losing copy of a plugin two enabled mods provide, at the same slot', async () => {
    const { root, instance } = await realInstance();
    const losing = await writeModFile(root, 'Unofficial Fallout 4 Patch', 'NonAsciiRetexture.esp', 'losing copy');

    await instance.refresh();

    expect(instance.value.plugins).toContainEqual(
      { name: 'NonAsciiRetexture.esp', path: losing, origin: 'Unofficial Fallout 4 Patch', slot: 0, enabled: true, winning: false },
    );
  });
});

describe('Instance — the overwrite folder', () => {
  it('resolves a listed plugin to the overwrite copy, sending the mod copy as losing', async () => {
    const { root, instance } = await realInstance();
    const overwriteCopy = join(root, 'overwrite', 'NonAsciiRetexture.esp');
    await writeFile(overwriteCopy, 'overwrite-copy');

    await instance.refresh();

    const copies = instance.value.plugins.filter((p) => p.name === 'NonAsciiRetexture.esp');
    expect(copies).toEqual([
      { name: 'NonAsciiRetexture.esp', path: overwriteCopy, origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: false },
    ]);
  });

  it('sends an unlisted plugin sitting in overwrite/ with no slot, winning-most', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'overwrite', 'New.esp'), '');
    await writeFile(join(root, 'overwrite', 'notes.txt'), '');

    await instance.refresh();

    expect(instance.value.plugins.filter((p) => p.origin === 'overwrite')).toEqual([
      { name: 'New.esp', path: join(root, 'overwrite', 'New.esp'), origin: 'overwrite', slot: null, enabled: false, winning: true },
    ]);
  });

  it('falls through to mod resolution when there is no overwrite folder at all', async () => {
    const { root, instance } = await realInstance();
    await rm(join(root, 'overwrite'), { recursive: true, force: true });

    await instance.refresh();

    expect(instance.value.plugins.find((p) => p.name === 'NonAsciiRetexture.esp'))
      .toEqual({ name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true });
  });

  it('never treats a directory under overwrite/ sharing a plugin\'s name as that plugin\'s file', async () => {
    const { root, instance } = await realInstance();
    await mkdir(join(root, 'overwrite', 'NonAsciiRetexture.esp'), { recursive: true });

    await instance.refresh();

    expect(instance.value.plugins.filter((p) => p.name === 'NonAsciiRetexture.esp'))
      .toEqual([{ name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true }]);
  });
});

describe('Instance — built by watching', () => {
  it('owns a watcher for every MO2 file the value is read from', async () => {
    await realInstance();

    expect(watchers.map((w) => w.pattern).sort()).toEqual(
      ['mods/**', 'overwrite/**', 'profiles/*/modlist.txt', 'profiles/*/plugins.txt'],
    );
  });

  it('disposes every watcher it owns', async () => {
    const { instance } = await realInstance();

    instance.dispose();

    expect(watchers.map((w) => w.disposed)).toEqual([true, true, true, true]);
  });

  it('yields the next value at a higher sequence when a file is rewritten outside Modbench', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(isEnabled(instance.value, 'Harder VATS')).toBe(false);
    const before = instance.sequence;

    await enableOutsideModbench(root, 'Harder VATS');
    watcherFor('profiles/*/modlist.txt').fireChange(join(root, DEFAULT_MODLIST));

    expect(isEnabled(await pastSequence(instance, before), 'Harder VATS')).toBe(true);
    expect(instance.sequence).toBeGreaterThan(before);
  });

  it('recomputes once for a burst of events across every watcher', async () => {
    const { root, instance, readModlist } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;
    readModlist.mockClear();

    watcherFor('mods/**').fireCreate(join(root, 'mods', 'Tracked Patch Mod', 'textures', 'a.dds'));
    watcherFor('mods/**').fireChange(join(root, 'mods', 'Tracked Patch Mod', 'textures', 'b.dds'));
    watcherFor('profiles/*/modlist.txt').fireChange(join(root, DEFAULT_MODLIST));
    watcherFor('profiles/*/plugins.txt').fireChange(join(root, DEFAULT_PLUGINS));
    watcherFor('overwrite/**').fireCreate(join(root, 'overwrite', 'stray.esp'));

    await pastSequence(instance, before);
    // Chains behind anything the burst still had queued, so a per-event recompute would be
    // counted here rather than landing after the assertion.
    await instance.refresh();

    expect(readModlist).toHaveBeenCalledTimes(2); // the burst's one recompute, plus this refresh
    expect(instance.sequence).toBe(before + 2);
  });

  it('a refresh mid-burst is the burst\'s recompute, not a second one', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    vi.useFakeTimers();
    try {
      watcherFor('mods/**').fireChange(join(root, 'mods', 'Tracked Patch Mod', 'textures', 'a.dds'));
      await vi.advanceTimersByTimeAsync(1); // the watcher's own hop, which arms the Instance's wait
      await instance.refresh();
      await vi.advanceTimersByTimeAsync(1000); // a wait left armed would fire here
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    expect(instance.sequence).toBe(before + 2);
  });

  it('never recomputes for a write inside a tracked mod\'s git internals', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    vi.useFakeTimers();
    try {
      watcherFor('mods/**').fireChange(join(root, 'mods', 'Tracked Patch Mod', '.git', 'objects', 'ab', 'cdef'));
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1); // the refresh, and nothing the event caused
  });
});

describe('Instance — a value that survives a bad read', () => {
  it('keeps the previous value and logs when a file is half-written', async () => {
    const { root, instance, logs } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await writeFile(join(root, 'ModOrganizer.ini'), ''); // MO2 mid-rewrite
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(logs.filter((m) => m.includes('recompute failed'))).toHaveLength(1);
    expect(logs[0]).toContain('ModOrganizer.ini');
  });

  it('keeps the mods when modlist.txt reads as empty mid-write, and logs', async () => {
    const hooks: Hooks = {};
    const { root, instance, logs } = await realInstance(hooks);
    await instance.refresh();
    const before = instance.value.mods;
    const path = join(root, DEFAULT_MODLIST);
    const complete = await readFile(path, 'utf8');

    await writeFile(path, ''); // MO2 has truncated the file and not yet written it
    hooks.afterModlistRead = async () => {
      hooks.afterModlistRead = undefined;
      await writeFile(path, complete); // the write completes before the Instance re-reads
    };
    await instance.refresh();

    expect(instance.value.mods).toEqual(before);
    expect(logs.filter((m) => m.includes('mid-write'))).toHaveLength(1);
  });

  it('publishes an empty mod list once the re-read agrees, since zero mods is legal', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    await writeFile(join(root, DEFAULT_MODLIST), ''); // every mod really is gone
    await instance.refresh();

    expect(instance.value.mods).toEqual([]);
    expect(instance.value.files.size).toBe(0);
    expect(instance.sequence).toBe(before + 1);
  });

  it('keeps recomputing after a subscriber throws', async () => {
    const { instance, logs } = await realInstance();
    const seen: number[] = [];
    instance.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    instance.subscribe((_value, sequence) => seen.push(sequence));

    await instance.refresh();
    await instance.refresh();

    expect(seen).toEqual([1, 2]);
    expect(logs.filter((m) => m.includes('subscriber threw'))).toHaveLength(2);
  });

  it('corrects the value on refresh after a watcher event that never arrived', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    await enableOutsideModbench(root, 'Harder VATS');
    expect(isEnabled(instance.value, 'Harder VATS')).toBe(false); // the event was suppressed

    await instance.refresh();

    expect(isEnabled(instance.value, 'Harder VATS')).toBe(true);
    expect(instance.sequence).toBe(before + 1);
  });
});
