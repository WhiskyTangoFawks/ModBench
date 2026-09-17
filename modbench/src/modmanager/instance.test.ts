import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from './test/fakeVscodeWatcher';
import { present } from '../ports/present';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from './test/corpusFixture';
import { setEnabledInText } from '../mo2Codecs/modlistText';
import { setSelectedProfileInText } from '../mo2Codecs/modOrganizerIni';
import type { ConfigLike, DetectPaths, DetectWinePrefix } from './gameDirectory';
import type { ConfigChangeEvent } from './gameDirectory';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance, loadOrderSnapshotOf, type InstanceValue } from './instance';
import type { LoadOrderPlugin } from './loadOrderSnapshot';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const DATA_FOLDER = '/game/Data';

// The fixture's own `gamePath` resolves to a path absent on the test machine, so every test's
// game directory resolves through this autodetect fallback instead.
const autodetectsDataFolder: DetectPaths = () => Promise.resolve({ dataFolder: DATA_FOLDER, pluginsTxt: DATA_FOLDER });

function fakeConfig(explicit: string | undefined): ConfigLike {
  return { get: (key) => (key === 'mods.gameDirectory' ? explicit : undefined) };
}

// A hand-rolled double for vscode's ConfigurationChangeEvent subscription.
function fakeOnConfigChange() {
  let listener: ((e: ConfigChangeEvent) => void) | undefined;
  return {
    subscribe: (l: (e: ConfigChangeEvent) => void) => {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
    fire: (section: string) => listener?.({ affectsConfiguration: (s) => s === section }),
  };
}

const noDetectWinePrefix: DetectWinePrefix = () => Promise.resolve(null);

interface Hooks {
  detectPaths?: DetectPaths;
}

async function realInstance(hooks: Hooks = {}): Promise<{
  root: string;
  instance: Instance;
  logs: string[];
  onConfigChange: ReturnType<typeof fakeOnConfigChange>;
  setGameDirectorySetting: (explicit: string | undefined) => void;
  setDetectPaths: (detect: DetectPaths) => void;
}> {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const logs: string[] = [];
  let gameDirectorySetting: string | undefined;
  let detectPaths = hooks.detectPaths ?? autodetectsDataFolder;
  const onConfigChange = fakeOnConfigChange();
  const instance = new Instance({
    instanceRoot: root,
    config: () => fakeConfig(gameDirectorySetting),
    detectPaths: () => detectPaths(),
    detectWinePrefix: noDetectWinePrefix,
    onConfigChange: onConfigChange.subscribe,
    log: (msg) => logs.push(msg),
  });
  instances.push(instance);
  return {
    root, instance, logs, onConfigChange,
    setGameDirectorySetting: (explicit) => { gameDirectorySetting = explicit; },
    setDetectPaths: (detect) => { detectPaths = detect; },
  };
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

const TIMED_OUT = Symbol('timed out waiting for a recompute');

// A missing trigger must fail on an explicit assertion, not the test runner's own timeout.
function pastSequenceWithin(instance: Instance, sequence: number, ms: number): Promise<InstanceValue | typeof TIMED_OUT> {
  return Promise.race([
    pastSequence(instance, sequence),
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
}

const watcherFor = (glob: string): FakeWatcher => {
  const found = watchers.filter((w) => w.pattern === glob);
  expect(found).toHaveLength(1);
  return present(found[0], `the sole watcher for ${glob}`);
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

  it('joins each mod\'s meta.ini onto its entry, and leaves an absent or empty-valued one undefined', async () => {
    const { instance } = await realInstance();

    await instance.refresh();

    const byName = new Map(instance.value.mods.map((m) => [m.name, m]));
    expect(byName.get('Unofficial Fallout 4 Patch')).toMatchObject({
      nexusId: '4598',
      version: '2.1.5.0',
      archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
    // "Harder VATS" ships modid=0 with blank version/installationFile.
    expect(byName.get('Harder VATS')).toEqual({ kind: 'mod', name: 'Harder VATS', enabled: false });
  });

  // A real mod folder can share a separator's bare display name; the separator entry must never
  // pick up that folder's meta.ini fields.
  it('never carries meta fields on a separator entry, even when a same-named mod folder exists', async () => {
    const { root, instance } = await realInstance();
    await writeModFile(root, 'Unassigned (Modlist Development)', 'meta.ini', '[General]\r\nmodid=555\r\nversion=9.9.9\r\n');

    await instance.refresh();

    expect(instance.value.mods.find((e) => e.name === 'Unassigned (Modlist Development)'))
      .toEqual({ kind: 'separator', name: 'Unassigned (Modlist Development)', enabled: false });
  });

  // The Mods tree renders `mods` alone, so a folder with no line reaches the value on a field
  // of its own or the adoption command never hears of it.
  it('carries a folder under mods with no line for the active profile as unlisted, never as a mod', async () => {
    const { root, instance } = await realInstance();
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    await instance.refresh();

    // The fixture ships "DragIn Manual Extract" unlisted; sorted, so the batch is deterministic.
    expect(instance.value.unlistedFolders).toEqual(['DragIn Manual Extract', 'Hand Extracted Mod']);
    expect(instance.value.mods.map((m) => m.name)).not.toContain('Hand Extracted Mod');
  });

  // The other half of the same split: a folder the active profile lists is the mods list's alone.
  it('never carries a folder the active profile lists as unlisted', async () => {
    const { instance } = await realInstance();

    await instance.refresh();

    expect(instance.value.mods.map((m) => m.name)).toContain('Harder VATS');
    expect(instance.value.unlistedFolders).not.toContain('Harder VATS');
    // overwrite/ is no mod, and a separator's on-disk form is a marker folder, not a mod folder.
    expect(instance.value.unlistedFolders).not.toContain('overwrite');
    expect(instance.value.unlistedFolders).not.toContain('Unassigned (Modlist Development)_separator');
  });

  // Only a directory can be a mod folder: a stray archive or Thumbs.db dropped into mods/ must
  // never earn a modlist line.
  it('never carries a stray file directly under mods as an unlisted folder', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'mods', 'Thumbs.db'), '');

    await instance.refresh();

    expect(instance.value.unlistedFolders).toEqual(['DragIn Manual Extract']);
  });

  // The profile the ini names is the one the field answers for: a switch must move a folder
  // between the two lists, never leave it answered from the profile the user left.
  it('answers the unlisted folders for the active profile, not a remembered one', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(instance.value.unlistedFolders).toEqual(['DragIn Manual Extract']);

    await switchProfileOutsideModbench(root, 'Secondary');
    await instance.refresh();

    // Secondary lists only the Unofficial Patch and Harder VATS, so every other folder is
    // unlisted under it — "ENBoost - 12k" among them, which Default does list.
    expect(instance.value.unlistedFolders).toContain('ENBoost - 12k');
    expect(instance.value.unlistedFolders).not.toContain('Harder VATS');
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
      ['ModOrganizer.ini', 'downloads/**', 'mods/**', 'overwrite/**', 'profiles/*/modlist.txt', 'profiles/*/plugins.txt'],
    );
  });

  it('disposes every watcher it owns', async () => {
    const { instance } = await realInstance();

    instance.dispose();

    expect(watchers.map((w) => w.disposed)).toEqual([true, true, true, true, true, true]);
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
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    watcherFor('mods/**').fireCreate(join(root, 'mods', 'Tracked Patch Mod', 'textures', 'a.dds'));
    watcherFor('mods/**').fireChange(join(root, 'mods', 'Tracked Patch Mod', 'textures', 'b.dds'));
    watcherFor('profiles/*/modlist.txt').fireChange(join(root, DEFAULT_MODLIST));
    watcherFor('profiles/*/plugins.txt').fireChange(join(root, DEFAULT_PLUGINS));
    watcherFor('overwrite/**').fireCreate(join(root, 'overwrite', 'stray.esp'));
    watcherFor('downloads/**').fireCreate(join(root, 'downloads', 'New.7z'));

    await pastSequence(instance, before);
    // Chains behind anything the burst still had queued, so a per-event recompute would be
    // counted here rather than landing after the assertion.
    await instance.refresh();

    // The burst's one recompute, plus this refresh — a per-event recompute would land six more.
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
    const failureLogs = logs.filter((m) => m.includes('recompute failed'));
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0]).toContain('ModOrganizer.ini');
  });

  it('keeps the value when a mod\'s meta.ini is present but unreadable — never silently "no metadata"', async () => {
    const { root, instance, logs } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await rm(join(root, 'mods', 'Harder VATS', 'meta.ini'), { force: true });
    await mkdir(join(root, 'mods', 'Harder VATS', 'meta.ini')); // present but unreadable (EISDIR)
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(logs.filter((m) => m.includes('recompute failed'))).toHaveLength(1);
  });

  // The failure a tree hears about before anything has landed, so its first render can settle on
  // an error node instead of a spinner that never ends (ADR-0019).
  it('reports a failed first read to failure subscribers, holds the sequence at 0, and lands the next successful read at sequence 1', async () => {
    const { root, instance } = await realInstance();
    const ini = join(root, 'ModOrganizer.ini');
    const complete = await readFile(ini, 'utf8');
    await writeFile(ini, ''); // unreadable before anything has landed
    const failures: string[] = [];
    const landed: number[] = [];
    instance.onReadFailure((reason) => failures.push(reason));
    instance.subscribe((_value, sequence) => landed.push(sequence));

    await instance.refresh();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ModOrganizer.ini');
    expect(instance.readFailure).toBe(failures[0]);
    expect(landed).toEqual([]);
    expect(instance.sequence).toBe(0);

    await writeFile(ini, complete);
    await instance.refresh();

    expect(landed).toEqual([1]);
    expect(instance.readFailure).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('reports a failure after a value has landed, keeping that value', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const failures: string[] = [];
    instance.onReadFailure((reason) => failures.push(reason));

    await writeFile(join(root, 'ModOrganizer.ini'), '');
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(1);
    expect(failures).toHaveLength(1);
    expect(instance.readFailure).toBe(failures[0]);
  });

  it('keeps the mods when modlist.txt reads as empty mid-write, and logs', async () => {
    const { root, instance, logs } = await realInstance();
    await instance.refresh();
    const before = instance.value.mods;
    const path = join(root, DEFAULT_MODLIST);
    const complete = await readFile(path, 'utf8');

    await writeFile(path, ''); // MO2 has truncated the file and not yet written it
    const recompute = instance.refresh();
    // Inside the Instance's own 200 ms settle: the first read has already seen the truncation,
    // and the write completes before the re-read that decides whether to believe it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(path, complete);
    await recompute;

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

// Simulates MO2, xEdit or the user rewriting ModOrganizer.ini's own selected_profile — the
// Instance only ever reads it.
async function switchProfileOutsideModbench(root: string, profile: string): Promise<void> {
  const path = join(root, 'ModOrganizer.ini');
  await writeFile(path, setSelectedProfileInText(await readFile(path, 'utf8'), profile));
}

describe('Instance — downloads, profile, game directory and deploy state', () => {
  it('carries downloads with status and hidden, the active profile, the resolved game directory and release, and deploy state, from one value', async () => {
    const { root, instance } = await realInstance();

    await instance.refresh();

    expect(instance.value.downloads).toContainEqual(
      expect.objectContaining({
        name: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
        status: 'Installed',
        hidden: false,
      }),
    );
    expect(instance.value.activeProfile).toBe('Default');
    expect(instance.value.gameRelease).toBe('Fallout 4');
    expect(instance.value.gameDirectory).toEqual({ root: dirname(DATA_FOLDER), dataFolder: DATA_FOLDER });
    expect(instance.value.deployed).toBe(false);

    await writeFile(join(root, 'mods', '.medit-manifest.json'), JSON.stringify({ links: [], preExisting: [] }));
    await instance.refresh();

    expect(instance.value.deployed).toBe(true);
  });

  // The fixture's sidecar claims `installed=true`, and only the Unofficial Patch mod's own
  // meta.ini makes that claim true. Rival: reading Status off the sidecar alone.
  it('drops a download\u2019s Installed row once the mod that named it is gone, sidecar claim and all', async () => {
    const { root, instance } = await realInstance();
    const archive = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
    const statusOf = () => instance.value.downloads.find((d) => d.name === archive)?.status;
    await instance.refresh();
    expect(statusOf()).toBe('Installed');

    await rm(join(root, 'mods', 'Unofficial Fallout 4 Patch'), { recursive: true, force: true });
    await instance.refresh();

    expect(statusOf()).toBe('Downloaded');
  });

  it('reflects a profile switch made outside Modbench in the next value', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(instance.value.activeProfile).toBe('Default');

    await switchProfileOutsideModbench(root, 'Secondary');
    await instance.refresh();

    expect(instance.value.activeProfile).toBe('Secondary');
  });

  // A switch rewrites ModOrganizer.ini and nothing else, so without a watcher on that file the
  // value keeps naming the old profile until some unrelated file happens to change.
  it('follows a profile switch on its own watcher, with no refresh asked for', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    await switchProfileOutsideModbench(root, 'Secondary');
    watcherFor('ModOrganizer.ini').fireChange();

    const landed = await pastSequenceWithin(instance, before, 2000);
    expect(landed).not.toBe(TIMED_OUT);
    expect(instance.value.activeProfile).toBe('Secondary');
  });

  // The empty value before any read already has `downloads: []`, so the assertion alone cannot
  // tell a tolerated absence from a swallowed throw that never landed a new value at all — the
  // sequence bump is what proves the recompute actually completed.
  it('yields a value with no downloads, rather than a failure, when downloads/ is absent', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(instance.value.downloads.length).toBeGreaterThan(0); // the fixture starts with one
    const before = instance.sequence;

    await rm(join(root, 'downloads'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.downloads).toEqual([]);
  });

  // A workspace before its first install has no mods/ at all. The sequence bump is what proves
  // the recompute landed rather than a swallowed failure, as the downloads case above.
  it('yields a value with no unlisted folders, rather than a failure, when mods/ is absent', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(instance.value.unlistedFolders.length).toBeGreaterThan(0); // the fixture starts with one
    const before = instance.sequence;

    await rm(join(root, 'mods'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.unlistedFolders).toEqual([]);
  });

  // Same reasoning as the downloads case above: `deployed: false` is also the empty value's own
  // default, so the sequence bump is what proves this recompute — not a caught failure — landed.
  it('yields a value with deployed false, rather than a failure, when the manifest is absent', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'mods', '.medit-manifest.json'), JSON.stringify({ links: [], preExisting: [] }));
    await instance.refresh();
    expect(instance.value.deployed).toBe(true);
    const before = instance.sequence;

    await rm(join(root, 'mods', '.medit-manifest.json'), { force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.deployed).toBe(false);
  });

  // Same reasoning again: the empty value already has `gameDirectory: undefined`, so a prior
  // resolved refresh plus the sequence bump prove tolerance rather than a swallowed failure.
  it('yields a value with no game directory, rather than a failure, when nothing resolves', async () => {
    const { instance, setDetectPaths } = await realInstance();
    await instance.refresh();
    expect(instance.value.gameDirectory).toBeDefined();
    const before = instance.sequence;

    setDetectPaths(() => Promise.resolve(null));
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.gameDirectory).toBeUndefined();
  });

  // A mod- or overwrite-provided row keeps its real path; a listed name only Data/ could provide
  // still gets a row — existence, slot and enabled come from plugins.txt alone — with `path:
  // undefined` rather than a guess or a drop.
  it('keeps every plugins.txt line as a row when the game directory is unresolved, Data-only rows line-only', async () => {
    const { instance, setDetectPaths } = await realInstance();
    await instance.refresh();
    const withGameDirectory = instance.value.plugins;
    // Sanity: the fixture has at least one Data-folder-only listed plugin today, so its path is
    // resolved through the game directory this test is about to take away.
    const dataOnlyBefore = withGameDirectory.find((p) => p.name === 'Unofficial Fallout 4 Patch.esp');
    expect(dataOnlyBefore?.origin).toBe('Data');
    expect(dataOnlyBefore?.path).toEqual(expect.any(String));
    const modProvidedBefore = withGameDirectory.find((p) => p.name === 'NonAsciiRetexture.esp');
    expect(modProvidedBefore?.path).toEqual(expect.any(String));

    setDetectPaths(() => Promise.resolve(null));
    await instance.refresh();

    const modProvided = instance.value.plugins.find((p) => p.name === 'NonAsciiRetexture.esp');
    expect(modProvided).toEqual(modProvidedBefore); // unaffected — a mod winner needs no game directory
    const dataOnly = instance.value.plugins.find((p) => p.name === 'Unofficial Fallout 4 Patch.esp');
    expect(dataOnly).toBeDefined(); // the row survives — this is the bug this test guards
    expect(dataOnly?.slot).toBe(dataOnlyBefore?.slot);
    expect(dataOnly?.enabled).toBe(dataOnlyBefore?.enabled);
    expect(dataOnly?.origin).toBe('Data');
    expect(dataOnly?.path).toBeUndefined(); // no Data/ to resolve it against — not a guess
  });

  it('recomputes with a new game directory when the setting changes, yielding a new value and sequence', async () => {
    const { root, instance, onConfigChange, setGameDirectorySetting } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;
    const explicitDir = join(root, 'ExplicitGame');
    await mkdir(join(explicitDir, 'Data'), { recursive: true });
    setGameDirectorySetting(explicitDir);

    onConfigChange.fire('modbench.mods.gameDirectory');
    const value = await pastSequenceWithin(instance, before, 2000);

    expect(value).not.toBe(TIMED_OUT);
    if (value === TIMED_OUT) throw new Error('expected a landed recompute, not a timeout');
    expect(instance.sequence).toBe(before + 1);
    expect(value.gameDirectory).toEqual({ root: explicitDir, dataFolder: join(explicitDir, 'Data') });
  });

  it('does not recompute for a config change affecting an unrelated setting', async () => {
    const { instance, onConfigChange } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;

    vi.useFakeTimers();
    try {
      onConfigChange.fire('modbench.mods.language');
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }

    expect(instance.sequence).toBe(before);
  });
});

// A bespoke minimal instance (not the corpus clone), so a mod's declared masters are exactly
// what the test wrote — real xEdit-produced corpus bytes carry unknown master lists of their own.
async function minimalInstance(): Promise<{
  root: string; instance: Instance; logs: string[]; setDetectPaths: (detect: DetectPaths) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), 'medit-instance-status-'));
  roots.push(root);
  await mkdir(join(root, 'profiles', 'Default'), { recursive: true });
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\ngameName=Fallout 4\n');
  await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '+Consumer\n');
  await writeFile(join(root, 'profiles', 'Default', 'plugins.txt'), '');
  await mkdir(join(root, 'mods', 'Consumer'), { recursive: true });
  const logs: string[] = [];
  let detectPaths: DetectPaths = () => Promise.resolve(null);
  const instance = new Instance({
    instanceRoot: root,
    config: () => fakeConfig(undefined),
    detectPaths: () => detectPaths(),
    detectWinePrefix: noDetectWinePrefix,
    onConfigChange: fakeOnConfigChange().subscribe,
    log: (msg) => logs.push(msg),
  });
  instances.push(instance);
  return { root, instance, logs, setDetectPaths: (detect) => { detectPaths = detect; } };
}

describe('Instance — per-mod status and the overwrite count', () => {
  // The value carries no verdict about a plugin's declared masters at all: that fact is the
  // backend's, reported per plugin on the Plugins rows (ADR-0016).
  it('has no status kind derived from a plugin file, whatever the plugin declares', async () => {
    const { root, instance } = await minimalInstance();
    await writeFile(join(root, 'mods', 'Consumer', 'Child.esp'), 'TES4 masters: NoSuchMaster.esm');

    await instance.refresh();

    expect(instance.value.modStatuses.get('Consumer')).toEqual({
      status: { kind: 'ok' },
      conflictLines: [],
    });
  });

  it('carries the overwrite/ folder\'s file count, recursive', async () => {
    const { root, instance } = await minimalInstance();
    await instance.refresh();
    expect(instance.value.overwriteFileCount).toBe(0);

    await mkdir(join(root, 'overwrite', 'F4SE'), { recursive: true });
    await writeFile(join(root, 'overwrite', 'F4SE', 'plugin.log'), 'x');
    await instance.refresh();

    expect(instance.value.overwriteFileCount).toBe(1);
  });
});

// A profile listing no mod folder isolates the mods/ listing: nothing else in the recompute
// opens a path under it, so only its own failure can fail the read.
describe('Instance — listing mods/', () => {
  const separatorOnly = async (root: string): Promise<void> => {
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '-Section_separator\n');
  };

  // Only ENOENT is "no mods/ yet". A listing that fails for any other reason must not read as
  // "every folder has its line": the value stands until a read succeeds (ADR-0015).
  it('keeps the value when mods/ is present but cannot be listed', async () => {
    const { root, instance, logs } = await minimalInstance();
    await separatorOnly(root);
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await rm(join(root, 'mods'), { recursive: true, force: true });
    await writeFile(join(root, 'mods'), 'not a directory'); // present but unlistable (ENOTDIR)
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(instance.readFailure).toBeDefined();
    expect(logs.filter((m) => m.includes('recompute failed'))).toHaveLength(1);
  });

  // The other half, on the same isolated tree: ENOENT alone is tolerated, and the value lands.
  it('lands a value with no unlisted folders when mods/ is absent entirely', async () => {
    const { root, instance } = await minimalInstance();
    await separatorOnly(root);
    await rm(join(root, 'mods'), { recursive: true, force: true });

    await instance.refresh();

    expect(instance.sequence).toBe(1);
    expect(instance.value.unlistedFolders).toEqual([]);
  });
});

describe('Instance — the sidecar file id and meta.ini installedFiles', () => {
  it('carries a download row\'s fileID from its sidecar and a mod\'s installedFiles pairs from meta.ini', async () => {
    const { root, instance } = await minimalInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'Consumer-1-2-3.7z'), 'archive bytes');
    await writeFile(
      join(root, 'downloads', 'Consumer-1-2-3.7z.meta'),
      '[General]\r\nmodID=1000\r\nfileID=2000\r\ninstalled=true\r\n',
    );
    await writeFile(
      join(root, 'mods', 'Consumer', 'meta.ini'),
      '[General]\r\ngameName=Fallout4\r\nmodid=1000\r\n[installedFiles]\r\n1\\modid=1000\r\n1\\fileid=2000\r\nsize=1\r\n',
    );

    await instance.refresh();

    const download = instance.value.downloads.find((d) => d.name === 'Consumer-1-2-3.7z');
    expect(download?.fileID).toBe('2000');

    const mod = instance.value.mods.find((m) => m.name === 'Consumer');
    expect(mod).toMatchObject({ installedFiles: [{ modid: '1000', fileid: '2000' }] });
  });

  it('carries no fileID on a download row whose sidecar has none, and no installedFiles on a mod with no meta.ini section', async () => {
    const { root, instance } = await minimalInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'Plain-1.7z'), 'archive bytes');
    await writeFile(join(root, 'downloads', 'Plain-1.7z.meta'), '[General]\r\nmodID=1000\r\n');
    await writeFile(join(root, 'mods', 'Consumer', 'meta.ini'), '[General]\r\ngameName=Fallout4\r\n');

    await instance.refresh();

    const download = instance.value.downloads.find((d) => d.name === 'Plain-1.7z');
    expect(download?.fileID).toBeUndefined();

    const mod = instance.value.mods.find((m) => m.name === 'Consumer');
    expect(mod).toMatchObject({ installedFiles: undefined });
  });
});

// ADR-0013: the snapshot the sync PUTs, read straight from the value rather than a fresh walk.
describe('loadOrderSnapshotOf', () => {
  const GAME_DIRECTORY = { root: '/game', dataFolder: '/game/Data' };
  const resolved: LoadOrderPlugin = { name: 'a.esp', path: '/mods/A/a.esp', origin: 'ModA', slot: 0, enabled: true, winning: true };
  const unresolved = { name: 'b.esp', path: undefined, origin: 'Data', slot: 1, enabled: true, winning: true };

  it('is undefined — no put at all — when the game directory has not resolved', () => {
    expect(loadOrderSnapshotOf({ plugins: [resolved], gameDirectory: undefined })).toBeUndefined();
  });

  it('carries the game directory\'s dataFolder and every resolved plugin once it has', () => {
    expect(loadOrderSnapshotOf({ plugins: [resolved], gameDirectory: GAME_DIRECTORY }))
      .toEqual({ dataFolder: '/game/Data', plugins: [resolved] });
  });

  // Rival: casting the union blind and sending `path: undefined` to the backend.
  it('omits a line-only row rather than sending it with path: undefined', () => {
    const snapshot = loadOrderSnapshotOf({ plugins: [resolved, unresolved], gameDirectory: GAME_DIRECTORY });
    expect(snapshot?.plugins).toEqual([resolved]);
  });
});
