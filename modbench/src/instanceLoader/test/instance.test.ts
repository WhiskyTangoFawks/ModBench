import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import type { GameFolder, InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import { Instance, type InstanceValue } from '../instance';
import { adapterOver, STEADY_WINDOW } from '../../test/mo2/adapterOver';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const DATA_FOLDER = '/game/Data';

type ResolveGameFolder = () => Promise<GameFolder>;

const resolvesDataFolder: ResolveGameFolder = () =>
  Promise.resolve({ kind: 'found', root: dirname(DATA_FOLDER), dataFolder: DATA_FOLDER });
const resolvesNotFound: ResolveGameFolder = () => Promise.resolve(GAME_FOLDER_NOT_FOUND);

interface Hooks {
  resolveGameFolder?: ResolveGameFolder;
}

function countingSettings(adapter: InstanceAdapter, reads: { count: number }): InstanceAdapter {
  return { ...adapter, settings: () => { reads.count++; return adapter.settings(); } };
}

function realInstance(hooks: Hooks = {}): {
  root: string;
  instance: Instance;
  logs: string[];
  readFailureLines: string[];
  settingsReads: { count: number };
  setResolver: (resolve: ResolveGameFolder) => void;
} {
  const root = cloneCorpusFixture();
  roots.push(root);
  const logs: string[] = [];
  const readFailureLines: string[] = [];
  const settingsReads = { count: 0 };
  let resolve = hooks.resolveGameFolder ?? resolvesDataFolder;
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: countingSettings(adapterOver(root, { gameFolder: () => resolve() }), settingsReads),
    log: (msg) => logs.push(msg),
    logReadFailure: (line) => readFailureLines.push(line),
  });
  instances.push(instance);
  return {
    root, instance, logs, readFailureLines, settingsReads,
    setResolver: (next) => { resolve = next; },
  };
}

function signalledInstance(): {
  instance: Instance; signal: () => void; windowState: (state: WindowState) => void;
  listeners: ReadonlySet<unknown>; windowListeners: ReadonlySet<unknown>;
} {
  const root = cloneCorpusFixture();
  roots.push(root);
  const listeners = new Set<() => void>();
  const windowListeners = new Set<(state: WindowState) => void>();
  const window = {
    state: { focused: true, active: true },
    onDidChangeWindowState: (listener: (state: WindowState) => void) => {
      windowListeners.add(listener);
      return { dispose: () => { windowListeners.delete(listener); } };
    },
  };
  const instance = new Instance({
    adapter: {
      ...adapterOver(root, { gameFolder: resolvesDataFolder }),
      subscribe: (listener) => {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    },
    window,
    log: () => {}, logReadFailure: () => {},
  });
  instances.push(instance);
  return {
    instance,
    signal: () => { for (const listener of [...listeners]) listener(); },
    windowState: (state) => {
      window.state = state;
      for (const listener of [...windowListeners]) listener(state);
    },
    listeners,
    windowListeners,
  };
}

interface WindowState {
  focused: boolean;
  active: boolean;
}

const NONO = 'Ñoño\'s Retexture';

async function writeModFile(root: string, modName: string, relativePath: string, body: string): Promise<string> {
  const path = join(root, 'mods', modName, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

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

async function readUntilNoArmedReadIsLeft(instance: Instance): Promise<void> {
  await instance.refresh();
  await instance.refresh();
}

const fakeSettleClockLeavingSetImmediateReal = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

const SETTLE_WAIT_DEADLINE_MS = 5_000;

async function settleWaitArmed(): Promise<void> {
  const deadline = Date.now() + SETTLE_WAIT_DEADLINE_MS;
  while (vi.getTimerCount() === 0) {
    if (Date.now() >= deadline) throw new Error('no settle wait was armed on the fake clock');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const TIMED_OUT = Symbol('timed out waiting for a recompute');

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

async function rewriteOutsideModbench(path: string, from: string, to: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

const enableHarderVatsOutsideModbench = (root: string): Promise<void> =>
  rewriteOutsideModbench(join(root, DEFAULT_MODLIST), '-Harder VATS', '+Harder VATS');

const isEnabled = (value: InstanceValue, name: string) => value.mods.find((m) => m.name === name)?.enabled;

const listedDownloadsOf = (value: InstanceValue) => (value.downloads.kind === 'listed' ? value.downloads.rows : []);

describe('Instance — the value', () => {
  it('starts empty at sequence 0, before anything has been read', () => {
    const { instance } = realInstance();

    expect(instance.sequence).toBe(0);
    expect(instance.value.mods).toEqual([]);
    expect(instance.value.plugins).toEqual([]);
    expect(instance.value.files.size).toBe(0);
    expect(instance.value.filesByMod.size).toBe(0);
  });

  it('carries the mods in override order, with separators and enabled, after a refresh', async () => {
    const { instance } = realInstance();

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
    const { instance } = realInstance();

    await instance.refresh();

    const byName = new Map(instance.value.mods.map((m) => [m.name, m]));
    expect(byName.get('Unofficial Fallout 4 Patch')).toMatchObject({
      nexusId: '4598',
      version: '2.1.5.0',
      archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
    expect(byName.get('Harder VATS')).toEqual({ kind: 'mod', name: 'Harder VATS', enabled: false });
  });

  it('never carries meta fields on a separator entry, even when a same-named mod folder exists', async () => {
    const { root, instance } = realInstance();
    await writeModFile(root, 'Unassigned (Modlist Development)', 'meta.ini', '[General]\r\nmodid=555\r\nversion=9.9.9\r\n');

    await instance.refresh();

    expect(instance.value.mods.find((e) => e.name === 'Unassigned (Modlist Development)'))
      .toEqual({ kind: 'separator', name: 'Unassigned (Modlist Development)', enabled: false });
  });

  it('carries each mod whose folder holds a repository as tracked, and no other, the mod\'s folder alone saying whether track is offered', async () => {
    const { root, instance } = realInstance();
    await mkdir(join(root, 'mods', 'Harder VATS', '.git'), { recursive: true });

    await instance.refresh();

    expect([...instance.value.trackedMods]).toEqual(['Harder VATS']);
  });

  it('carries a folder under mods with no line for the active profile as a mod folder, never as a mod, so mod sync hears of it though the Mods tree renders `mods` alone', async () => {
    const { root, instance } = realInstance();
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    await instance.refresh();

    expect(instance.value.modFolders?.map((f) => f.name)).toContain('Hand Extracted Mod');
    expect(instance.value.mods.map((m) => m.name)).not.toContain('Hand Extracted Mod');
  });

  it('carries a mod folder that is a link to a folder, as MO2 lists it (modinfo.cpp, QDir::Dirs without NoSymLinks), and not a link to a file', async () => {
    const { root, instance } = realInstance();
    const target = await mkdtemp(join(tmpdir(), 'linked-mod-'));
    try {
      await symlink(target, join(root, 'mods', 'Linked Mod'), 'junction');
      await writeFile(join(target, 'readme.txt'), '');
      await symlink(join(target, 'readme.txt'), join(root, 'mods', 'Linked File'));

      await instance.refresh();

      expect(instance.value.modFolders?.map((f) => f.name)).toContain('Linked Mod');
      expect(instance.value.modFolders?.map((f) => f.name)).not.toContain('Linked File');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('skips a mod folder link whose target cannot be checked as MO2 does, without failing the recompute, and tells it once rather than on every watched change', async () => {
    const { root, instance, logs, readFailureLines } = realInstance();
    await mkdir(join(root, 'mods', 'Real Mod'));
    await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));

    await instance.refresh();
    await instance.refresh();

    expect(readFailureLines).toEqual([]);
    expect(instance.value.modFolders?.map((f) => f.name)).toContain('Real Mod');
    expect(instance.value.modFolders?.map((f) => f.name)).not.toContain('Loop');
    expect(logs.filter((line) => line.includes('Loop'))).toHaveLength(1);
  });

  it('never carries a stray file such as Thumbs.db directly under mods as a mod folder, only a directory being one', async () => {
    const { root, instance } = realInstance();
    await writeFile(join(root, 'mods', 'Thumbs.db'), '');

    await instance.refresh();

    expect(instance.value.modFolders?.map((f) => f.name)).not.toContain('Thumbs.db');
  });

  it('carries the winner of a path two enabled mods provide, and each listed mod\'s own files, a disabled mod\'s too', async () => {
    const { root, instance } = realInstance();
    const winner = await writeModFile(root, NONO, 'textures/shared.dds', 'winning');
    await writeModFile(root, 'Unofficial Fallout 4 Patch', 'textures/shared.dds', 'losing');
    await writeModFile(root, 'Harder VATS', 'textures/shared.dds', 'disabled');

    await instance.refresh();

    const entry = instance.value.files.get('textures/shared.dds');
    expect(entry?.winner).toBe(winner);
    expect(entry?.winnerOrigin).toEqual({ kind: 'mod', name: NONO });
    expect(entry?.providers).toEqual([{ kind: 'mod', name: NONO }, { kind: 'mod', name: 'Unofficial Fallout 4 Patch' }]);
    expect(instance.value.filesByMod.get('Harder VATS')?.map((f) => f.relativePath)).toEqual(['textures/shared.dds']);
    expect(instance.value.filesByMod.get('Tracked Patch Mod')?.map((f) => f.relativePath)).toEqual(['Tracked Patch Mod.esp']);
    expect(instance.value.foldersByMod.get('Harder VATS')?.map((f) => f.relativePath)).toEqual(['textures']);
  });

  it('carries every plugin — listed, unlisted and Data-folder — with origin, slot, enabled and winning', async () => {
    const { root, instance } = realInstance();

    await instance.refresh();

    expect(instance.value.plugins).toEqual([
      { name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true },
      { name: 'Tracked Patch Mod.esp', path: join(root, 'mods', 'Tracked Patch Mod', 'Tracked Patch Mod.esp'), origin: 'Tracked Patch Mod', slot: 1, enabled: true, winning: true },
      { name: 'Unofficial Fallout 4 Patch.esp', path: join(DATA_FOLDER, 'Unofficial Fallout 4 Patch.esp'), origin: 'Data', slot: 2, enabled: true, winning: true },
      { name: 'ccSBJFO4003-Grenade.esl', path: join(DATA_FOLDER, 'ccSBJFO4003-Grenade.esl'), origin: 'Data', slot: 3, enabled: true, winning: true },
      { name: 'NonAsciiRetexture - Addon.esl', path: join(root, 'mods', NONO, 'NonAsciiRetexture - Addon.esl'), origin: NONO, slot: null, enabled: false, winning: true },
    ]);
  });

  it('carries a disabled mod\'s own plugin, with no slot, not enabled, not winning, so the snapshot names plugins of disabled mods too', async () => {
    const { root, instance } = realInstance();
    const path = await writeModFile(root, 'Harder VATS', 'Harder VATS.esp', 'disabled mod plugin');

    await instance.refresh();

    expect(instance.value.plugins).toContainEqual(
      { name: 'Harder VATS.esp', path, origin: 'Harder VATS', slot: null, enabled: false, winning: false },
    );
  });

  it('sends the overridden plugin of a filename two enabled mods provide, at the same slot', async () => {
    const { root, instance } = realInstance();
    const overridden = await writeModFile(root, 'Unofficial Fallout 4 Patch', 'NonAsciiRetexture.esp', 'overridden plugin');

    await instance.refresh();

    expect(instance.value.plugins).toContainEqual(
      { name: 'NonAsciiRetexture.esp', path: overridden, origin: 'Unofficial Fallout 4 Patch', slot: 0, enabled: true, winning: false },
    );
  });
});

describe('Instance — the overwrite folder', () => {
  it('resolves a listed plugin to the overwrite plugin, sending the mod plugin as overridden', async () => {
    const { root, instance } = realInstance();
    const overwritePlugin = join(root, 'overwrite', 'NonAsciiRetexture.esp');
    await writeFile(overwritePlugin, 'overwrite-plugin');

    await instance.refresh();

    const plugins = instance.value.plugins.filter((p) => p.name === 'NonAsciiRetexture.esp');
    expect(plugins).toEqual([
      { name: 'NonAsciiRetexture.esp', path: overwritePlugin, origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: false },
    ]);
  });

  it('sends an unlisted plugin sitting in overwrite/ with no slot, winning-most', async () => {
    const { root, instance } = realInstance();
    await writeFile(join(root, 'overwrite', 'New.esp'), '');
    await writeFile(join(root, 'overwrite', 'notes.txt'), '');

    await instance.refresh();

    expect(instance.value.plugins.filter((p) => p.origin === 'overwrite')).toEqual([
      { name: 'New.esp', path: join(root, 'overwrite', 'New.esp'), origin: 'overwrite', slot: null, enabled: false, winning: true },
    ]);
  });

  it('falls through to mod resolution when there is no overwrite folder at all', async () => {
    const { root, instance } = realInstance();
    await rm(join(root, 'overwrite'), { recursive: true, force: true });

    await instance.refresh();

    expect(instance.value.plugins.find((p) => p.name === 'NonAsciiRetexture.esp'))
      .toEqual({ name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true });
  });

  it('never treats a directory under overwrite/ sharing a plugin\'s name as that plugin\'s file', async () => {
    const { root, instance } = realInstance();
    await mkdir(join(root, 'overwrite', 'NonAsciiRetexture.esp'), { recursive: true });

    await instance.refresh();

    expect(instance.value.plugins.filter((p) => p.name === 'NonAsciiRetexture.esp'))
      .toEqual([{ name: 'NonAsciiRetexture.esp', path: join(root, 'mods', NONO, 'NonAsciiRetexture.esp'), origin: NONO, slot: 0, enabled: true, winning: true }]);
  });
});

describe('Instance — built by watching', () => {
  it('listens for the adapter\'s signal and the window\'s state from construction, before any read, until disposed', () => {
    const { instance, listeners, windowListeners } = signalledInstance();
    expect(instance.sequence).toBe(0);
    expect([listeners.size, windowListeners.size]).toEqual([1, 1]);

    instance.dispose();

    expect([listeners.size, windowListeners.size]).toEqual([0, 0]);
  });

  it('recomputes once for a burst of the adapter\'s signals, a per-signal recompute landing five more', async () => {
    const { instance, signal } = signalledInstance();
    await instance.refresh();
    const before = instance.sequence;

    fakeSettleClockLeavingSetImmediateReal();
    try {
      for (let i = 0; i < 6; i++) signal();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    const oneRecomputeForTheBurstAndOneForThisRefresh = 2;
    expect(instance.sequence).toBe(before + oneRecomputeForTheBurstAndOneForThisRefresh);
  });

  it('recomputes when the window regains focus, and not when it loses it, focus being the one signal no watcher can lose', async () => {
    const { instance, windowState } = signalledInstance();
    await instance.refresh();
    const before = instance.sequence;

    fakeSettleClockLeavingSetImmediateReal();
    try {
      windowState({ focused: false, active: false });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
      expect(instance.sequence).toBe(before + 1);

      windowState({ focused: true, active: true });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
      expect(instance.sequence).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recomputes nothing while the window keeps its focus, `active` moving as VS Code reports a focused window going idle or coming back from idle', async () => {
    const { instance, windowState } = signalledInstance();
    await instance.refresh();
    const before = instance.sequence;

    fakeSettleClockLeavingSetImmediateReal();
    try {
      windowState({ focused: true, active: false });
      windowState({ focused: true, active: true });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(instance.sequence).toBe(before + 1);
  });

  it('settles the window regaining focus with the adapter\'s signals, into one recompute, the focus restarting the settle the signal began', async () => {
    const { instance, signal, windowState } = signalledInstance();
    await instance.refresh();
    windowState({ focused: false, active: false });
    const before = instance.sequence;

    const msWhereTheSignalsOwnSettleHasRunOut = 150;
    fakeSettleClockLeavingSetImmediateReal();
    try {
      signal();
      await vi.advanceTimersByTimeAsync(msWhereTheSignalsOwnSettleHasRunOut);
      windowState({ focused: true, active: true });
      await vi.advanceTimersByTimeAsync(msWhereTheSignalsOwnSettleHasRunOut);
      await instance.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(instance.sequence).toBe(before + 1);
  });

  it('a refresh mid-burst is the burst\'s recompute, not a second one', async () => {
    const { instance, signal } = signalledInstance();
    await instance.refresh();
    const before = instance.sequence;

    const msWhereAWaitLeftArmedWouldFire = 1000;
    vi.useFakeTimers();
    try {
      signal();
      await instance.refresh();
      await vi.advanceTimersByTimeAsync(msWhereAWaitLeftArmedWouldFire);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    expect(instance.sequence).toBe(before + 2);
  });

  it('catches a file written in the gap before the just-bound downloads watcher can arm, which fires no watcher event, only the adapter\'s signal on following the folder catching it', async () => {
    const { root, instance } = realInstance();
    fakeSettleClockLeavingSetImmediateReal();
    try {
      await instance.refresh();
      const before = instance.sequence;

      await writeFile(join(root, 'downloads', 'RaceCondition.7z'), 'bytes');
      const landing = pastSequence(instance, before);
      await vi.advanceTimersByTimeAsync(1000);

      const after = await landing;
      expect(after.downloads.kind === 'listed' && after.downloads.rows.some((d) => d.name === 'RaceCondition.7z')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lands mods and plugins even when download_directory names an untranslatable drive letter, losing only the downloads rows', async () => {
    const { root, instance } = realInstance();
    await instance.refresh();
    const before = instance.sequence;
    const iniPath = join(root, 'ModOrganizer.ini');
    const originalIni = await readFile(iniPath, 'utf8');

    await writeFile(iniPath, `${originalIni}download_directory=D:\\Games\\downloads\r\n`);
    await instance.refresh();

    expect(instance.sequence).toBeGreaterThan(before);
    expect(instance.readFailure).toBeUndefined();
    expect(instance.value.mods.length).toBeGreaterThan(0);
    expect(instance.value.downloads).toMatchObject({ kind: 'unresolved' });
    if (instance.value.downloads.kind !== 'unresolved') throw new Error('unreachable');
    expect(instance.value.downloads.reason).toMatch(/download_directory/);
  });

  it('lists, watches and exposes as paths.downloadsDir nothing from the default downloads/ folder while download_directory is unresolved, which downloads.md story 1 forbids', async () => {
    const { root, instance } = realInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'RealArchive.7z'), 'bytes');
    await instance.refresh();
    expect(listedDownloadsOf(instance.value)).toContainEqual(expect.objectContaining({ name: 'RealArchive.7z' }));
    const iniPath = join(root, 'ModOrganizer.ini');
    const originalIni = await readFile(iniPath, 'utf8');

    await writeFile(iniPath, `${originalIni}download_directory=D:\\Games\\downloads\r\n`);
    await instance.refresh();

    expect(instance.value.downloads).toMatchObject({ kind: 'unresolved' });
    expect(watchers.filter((w) => w.base === join(root, 'downloads') && !w.disposed)).toHaveLength(0);
    expect(instance.value.paths.downloadsDir).toBeUndefined();
  });

  it('yields the next value at a higher sequence when a file is rewritten outside Modbench', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    expect(isEnabled(instance.value, 'Harder VATS')).toBe(false);
    const before = instance.sequence;

    await enableHarderVatsOutsideModbench(root);
    watcherFor('profiles/*/modlist.txt').fireChange(join(root, DEFAULT_MODLIST));

    expect(isEnabled(await pastSequence(instance, before), 'Harder VATS')).toBe(true);
    expect(instance.sequence).toBeGreaterThan(before);
  });

});

describe('Instance — a value that survives a bad read', () => {
  it('keeps the previous value and logs when a file is half-written', async () => {
    const { root, instance, readFailureLines } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;

    await writeFile(join(root, 'ModOrganizer.ini'), '');
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
    expect(readFailureLines[0]).toContain('ModOrganizer.ini');
  });

  it('keeps the value when a mod\'s meta.ini is present but unreadable — never silently "no metadata"', async () => {
    const { root, instance, readFailureLines } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;

    await rm(join(root, 'mods', 'Harder VATS', 'meta.ini'), { force: true });
    await mkdir(join(root, 'mods', 'Harder VATS', 'meta.ini'));
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
  });

  it('keeps the value when a folder inside overwrite/ is unreadable, simulated through a mocked readdir as chmod denial is bypassed when the runner is root — never silently a smaller count', async () => {
    const { root, instance, readFailureLines } = realInstance();
    const nested = join(root, 'overwrite', 'SKSE');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'skse.log'), '');
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;

    const { readdir: actualReaddir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockImplementation(async (path, ...rest) => {
      if (String(path) === nested) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return actualReaddir(path, ...rest);
    });
    try {
      await instance.refresh();
    } finally {
      vi.mocked(readdir).mockImplementation(actualReaddir);
    }

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
  });

  it('reports a failed first read to failure subscribers, so a tree can settle on an error node instead of a spinner that never ends, holds the sequence at 0, and lands the next successful read at sequence 1', async () => {
    const { root, instance } = realInstance();
    const ini = join(root, 'ModOrganizer.ini');
    const complete = await readFile(ini, 'utf8');
    await writeFile(ini, '');
    const failures: (string | undefined)[] = [];
    const landed: number[] = [];
    instance.onReadFailure(() => failures.push(instance.readFailure));
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

  it('answers a refresh with its own read\'s failure, never an earlier one\'s, and with none once that read lands', async () => {
    const { root, instance } = realInstance();
    const ini = join(root, 'ModOrganizer.ini');
    const complete = await readFile(ini, 'utf8');
    await writeFile(ini, '');

    const failed = await instance.refresh();

    expect(failed).toContain('ModOrganizer.ini');
    expect(failed).toBe(instance.readFailure);

    await writeFile(ini, complete);

    expect(await instance.refresh()).toBeUndefined();
  });

  it('reports a failure after a value has landed, keeping that value', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;
    const failures: (string | undefined)[] = [];
    instance.onReadFailure(() => failures.push(instance.readFailure));

    await writeFile(join(root, 'ModOrganizer.ini'), '');
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(failures).toHaveLength(1);
    expect(instance.readFailure).toBe(failures[0]);
  });

  it('keeps the mods when modlist.txt reads as empty mid-write, waiting to re-read before believing it, and logs', async () => {
    const { root, instance, logs } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const before = instance.value.mods;
    const path = join(root, DEFAULT_MODLIST);
    const complete = await readFile(path, 'utf8');

    fakeSettleClockLeavingSetImmediateReal();
    try {
      await writeFile(path, '');
      const recompute = instance.refresh();
      await settleWaitArmed();
      await writeFile(path, complete);
      await vi.advanceTimersByTimeAsync(1000);
      await recompute;
    } finally {
      vi.useRealTimers();
    }

    expect(instance.value.mods).toEqual(before);
    expect(logs.filter((m) => m.includes('mid-write'))).toHaveLength(1);
  });

  it('publishes an empty mod list once the re-read agrees, since zero mods is legal', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const before = instance.sequence;

    await writeFile(join(root, DEFAULT_MODLIST), '');
    await instance.refresh();

    expect(instance.value.mods).toEqual([]);
    expect([...instance.value.files].map((entry) => entry.relativePath)).toEqual(['F4SE/Plugins/SomePlugin.log']);
    expect(instance.value.filesByMod.size).toBe(0);
    expect(instance.sequence).toBe(before + 1);
  });

  it('keeps recomputing after a subscriber throws', async () => {
    const { instance, logs } = realInstance();
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
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const before = instance.sequence;

    await enableHarderVatsOutsideModbench(root);
    expect(isEnabled(instance.value, 'Harder VATS')).toBe(false);

    await instance.refresh();

    expect(isEnabled(instance.value, 'Harder VATS')).toBe(true);
    expect(instance.sequence).toBe(before + 1);
  });
});

const switchToSecondaryOutsideModbench = (root: string): Promise<void> => rewriteOutsideModbench(
  join(root, 'ModOrganizer.ini'), 'selected_profile=@ByteArray(Default)', 'selected_profile=@ByteArray(Secondary)',
);

describe('Instance — downloads, profile and game directory', () => {
  it('carries downloads with status and hidden, the active profile, the resolved game directory and release, from one value', async () => {
    const { instance } = realInstance();

    await instance.refresh();

    expect(listedDownloadsOf(instance.value)).toContainEqual(
      expect.objectContaining({
        name: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
        status: 'Installed',
        excluded: false,
      }),
    );
    expect(instance.value.activeProfile).toBe('Default');
    expect(instance.value.gameName).toBe('Fallout 4');
    expect(instance.value.gameRelease).toBe('Fallout4');
    expect(instance.value.nexusSlug).toBe('fallout4');
    expect(instance.value.gameFolder).toEqual({ kind: 'found', root: dirname(DATA_FOLDER), dataFolder: DATA_FOLDER });
  });

  it('drops a download\u2019s Installed row once the mod that named it is gone, sidecar claim and all', async () => {
    const { root, instance } = realInstance();
    const archive = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
    const statusOf = () => listedDownloadsOf(instance.value).find((d) => d.name === archive)?.status;
    await instance.refresh();
    expect(statusOf()).toBe('Installed');

    await rm(join(root, 'mods', 'Unofficial Fallout 4 Patch'), { recursive: true, force: true });
    await instance.refresh();

    expect(statusOf()).toBe('Uninstalled');
  });

  it('reads a download as Installed from a mod folder with no line in the active profile\u2019s modlist', async () => {
    const { root, instance } = realInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'Off-Profile-1.7z'), 'archive bytes');
    await writeModFile(root, 'Off Profile Mod', 'meta.ini', '[General]\r\ninstallationFile=Off-Profile-1.7z\r\n');

    await instance.refresh();

    expect(instance.value.mods.map((m) => m.name)).not.toContain('Off Profile Mod');
    expect(instance.value.modFolders?.map((f) => f.name)).toContain('Off Profile Mod');
    const download = listedDownloadsOf(instance.value).find((d) => d.name === 'Off-Profile-1.7z');
    expect(download?.status).toBe('Installed');
  });

  it('keeps the value when an off-profile mod\'s meta.ini is present but unreadable, only ENOENT reading as empty', async () => {
    const { root, instance, readFailureLines } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;

    await mkdir(join(root, 'mods', 'Off Profile Mod', 'meta.ini'), { recursive: true });
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
  });

  it('reflects a profile switch made outside Modbench in the next value', async () => {
    const { root, instance } = realInstance();
    await instance.refresh();
    expect(instance.value.activeProfile).toBe('Default');

    await switchToSecondaryOutsideModbench(root);
    await instance.refresh();

    expect(instance.value.activeProfile).toBe('Secondary');
  });

  it('follows a profile switch on its own watcher, with no refresh asked for, as a switch rewrites only ModOrganizer.ini', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const before = instance.sequence;

    await switchToSecondaryOutsideModbench(root);
    watcherFor('ModOrganizer.ini').fireChange();

    const landed = await pastSequenceWithin(instance, before, 2000);
    expect(landed).not.toBe(TIMED_OUT);
    expect(instance.value.activeProfile).toBe('Secondary');
  });

  it('yields a value with no downloads, rather than a failure, when downloads/ is absent', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    expect(listedDownloadsOf(instance.value).length).toBeGreaterThan(0);
    const before = instance.sequence;

    await rm(join(root, 'downloads'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.downloads).toEqual({ kind: 'listed', rows: [] });
  });

  it('yields a value whose mod folders are unknown, rather than a failure, when mods/ is absent, as absent is not empty and mod sync would drop every line against an empty list', async () => {
    const { root, instance } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    expect(instance.value.modFolders?.length).toBeGreaterThan(0);
    const before = instance.sequence;

    await rm(join(root, 'mods'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.modFolders).toBeUndefined();
  });

  it('lands a value carrying the game folder not found, with each place looked, rather than a failure', async () => {
    const { instance, setResolver, readFailureLines } = realInstance();
    await instance.refresh();
    expect(instance.value.gameFolder.kind).toBe('found');
    const before = instance.sequence;

    setResolver(resolvesNotFound);
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.readFailure).toBeUndefined();
    expect(readFailureLines).toEqual([]);
    expect(instance.value.gameFolder).toEqual(GAME_FOLDER_NOT_FOUND);
    expect(instance.value.mods.length).toBeGreaterThan(0);
  });

  it('fails the read, keeping the last value, when the configuration names no game, rather than reading as the game folder not found', async () => {
    const { root, instance, readFailureLines } = realInstance();
    await readUntilNoArmedReadIsLeft(instance);
    const before = instance.sequence;
    const ini = join(root, 'ModOrganizer.ini');
    await writeFile(ini, (await readFile(ini, 'utf8')).replace(/gameName=.*\r?\n/, ''));

    await instance.refresh();

    expect(instance.sequence).toBe(before);
    expect(instance.readFailure).toMatch(/gameName/);
    expect(readFailureLines).toHaveLength(1);
  });

  it('keeps every plugins.txt line as a row when the game directory is unresolved, Data-only rows line-only with no path rather than a guess or a drop, a mod-provided row keeping its real path', async () => {
    const { instance, setResolver } = realInstance();
    await instance.refresh();
    const withGameDirectory = instance.value.plugins;
    const dataOnlyBefore = withGameDirectory.find((p) => p.name === 'Unofficial Fallout 4 Patch.esp');
    expect(dataOnlyBefore?.origin).toBe('Data');
    expect(dataOnlyBefore?.path).toEqual(expect.any(String));
    const modProvidedBefore = withGameDirectory.find((p) => p.name === 'NonAsciiRetexture.esp');
    expect(modProvidedBefore?.path).toEqual(expect.any(String));

    setResolver(resolvesNotFound);
    await instance.refresh();

    const modProvided = instance.value.plugins.find((p) => p.name === 'NonAsciiRetexture.esp');
    expect(modProvided).toEqual(modProvidedBefore);
    const dataOnly = instance.value.plugins.find((p) => p.name === 'Unofficial Fallout 4 Patch.esp');
    expect(dataOnly).toBeDefined();
    expect(dataOnly?.slot).toBe(dataOnlyBefore?.slot);
    expect(dataOnly?.enabled).toBe(dataOnlyBefore?.enabled);
    expect(dataOnly?.origin).toBe('Data');
    expect(dataOnly?.path).toBeUndefined();
  });

  it('recomputes with the game directory the resolver now answers, yielding a new value and sequence', async () => {
    const { root, instance, setResolver } = realInstance();
    await instance.refresh();
    const before = instance.sequence;
    const explicitDir = join(root, 'ExplicitGame');
    setResolver(() => Promise.resolve({ kind: 'found', root: explicitDir, dataFolder: join(explicitDir, 'Data') }));

    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.gameFolder).toEqual({ kind: 'found', root: explicitDir, dataFolder: join(explicitDir, 'Data') });
  });

  it('reads the settings once per recompute, landing one value built from one read rather than from two', async () => {
    const { instance, settingsReads } = realInstance();

    await instance.refresh();

    expect(settingsReads.count).toBe(1);
  });

  it('builds one value from one generation of the ini, even when it is rewritten mid-recompute', async () => {
    const { root, instance, setResolver } = realInstance();
    await instance.refresh();
    const beforeName = instance.value.gameName;
    const ini = join(root, 'ModOrganizer.ini');
    setResolver(async () => {
      const text = await readFile(ini, 'utf8');
      await writeFile(ini, text.replace(/gameName=.*/, 'gameName=Rewritten Mid Recompute'));
      return GAME_FOLDER_NOT_FOUND;
    });

    await instance.refresh();

    expect(instance.value.gameName).toBe(beforeName);
    setResolver(resolvesNotFound);
    await instance.refresh();
    expect(instance.value.gameName).toBe('Rewritten Mid Recompute');
  });

  it('carries the paths a view renders: overwrite/, downloads/ and each listed mod’s own folder, where it has one', async () => {
    const { root, instance } = realInstance();

    await instance.refresh();

    const { paths, mods } = instance.value;
    expect(paths.overwriteDir).toBe(join(root, 'overwrite'));
    expect(paths.downloadsDir).toBe(join(root, 'downloads'));
    const first = present(mods.find((m) => m.kind === 'mod'), 'the fixture\'s first mod');
    expect(paths.modDirs.get(first.name)).toBe(join(root, 'mods', first.name));
    const modListedWithNoFolderUnderMods = '[NODELETE] Radfall';
    expect(paths.modDirs.has(modListedWithNoFolderUnderMods)).toBe(false);
    expect(paths.modDirs.size).toBe(mods.filter((m) => m.kind === 'mod').length - 1);
  });

  it('names the mod manager and its mod-order file as the adapter does rather than as the value spells them, before the first read too', () => {
    const adapter = { ...adapterOver('/an/instance', { gameFolder: resolvesNotFound }), names: { manager: 'Another Manager', modOrderFile: 'order.txt' } };
    const instance = new Instance({ window: STEADY_WINDOW, adapter, log: () => {}, logReadFailure: () => {} });
    instances.push(instance);

    expect(instance.value.managerNames).toEqual({ manager: 'Another Manager', modOrderFile: 'order.txt' });
  });

  it('names no folder before the first read lands, the adapter alone knowing where the instance keeps its folders', () => {
    const instance = new Instance({
      window: STEADY_WINDOW,
      adapter: adapterOver('/an/instance', { gameFolder: resolvesNotFound }),
      log: () => {}, logReadFailure: () => {},
    });
    instances.push(instance);

    expect(instance.sequence).toBe(0);
    expect(instance.value.paths).toEqual({ overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map() });
  });
});

async function minimalInstanceWithoutCorpusMasters(): Promise<{
  root: string; instance: Instance; logs: string[]; readFailureLines: string[];
  setResolver: (resolve: ResolveGameFolder) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), 'medit-instance-status-'));
  roots.push(root);
  await mkdir(join(root, 'profiles', 'Default'), { recursive: true });
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\ngameName=Fallout 4\n');
  await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '+Consumer\n');
  await writeFile(join(root, 'profiles', 'Default', 'plugins.txt'), '');
  await mkdir(join(root, 'mods', 'Consumer'), { recursive: true });
  const logs: string[] = [];
  const readFailureLines: string[] = [];
  let resolve: ResolveGameFolder = resolvesNotFound;
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: () => resolve() }),
    log: (msg) => logs.push(msg),
    logReadFailure: (line) => readFailureLines.push(line),
  });
  instances.push(instance);
  return { root, instance, logs, readFailureLines, setResolver: (next) => { resolve = next; } };
}

describe('Instance — Overwrite\'s files', () => {
  it('carries each file and folder under the overwrite/ folder, recursive, by the path in it and where it sits', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
    await instance.refresh();
    expect(instance.value.overwriteFiles).toEqual([]);

    await mkdir(join(root, 'overwrite', 'F4SE'), { recursive: true });
    await writeFile(join(root, 'overwrite', 'F4SE', 'plugin.log'), 'x');
    await instance.refresh();

    const log = join(root, 'overwrite', 'F4SE', 'plugin.log');
    expect(instance.value.overwriteFiles).toEqual([{ relativePath: 'F4SE/plugin.log', path: log, sourcePath: log, excluded: false }]);
    expect(instance.value.overwriteFolders).toEqual([{ relativePath: 'F4SE', path: join(root, 'overwrite', 'F4SE'), excluded: false }]);
  });
});

describe('Instance — listing mods/, on a profile listing no mod folder so only its own failure can fail the read', () => {
  const separatorOnly = async (root: string): Promise<void> => {
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '-Section_separator\n');
  };

  it('keeps the value when mods/ is present but cannot be listed, as only ENOENT is "no mods/ yet" and any other failure must not read as every folder having its line', async () => {
    const { root, instance, readFailureLines } = await minimalInstanceWithoutCorpusMasters();
    await separatorOnly(root);
    await readUntilNoArmedReadIsLeft(instance);
    const value = instance.value;
    const before = instance.sequence;

    await rm(join(root, 'mods'), { recursive: true, force: true });
    await writeFile(join(root, 'mods'), 'not a directory');
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(instance.readFailure).toBeDefined();
    expect(readFailureLines).toHaveLength(1);
  });

  it('lands a value whose mod folders are unknown when mods/ is absent entirely, ENOENT alone being tolerated', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
    await separatorOnly(root);
    await rm(join(root, 'mods'), { recursive: true, force: true });

    await instance.refresh();

    expect(instance.sequence).toBe(1);
    expect(instance.value.modFolders).toBeUndefined();
  });
});

describe('Instance — what a command is handed instead of probing for it', () => {
  it('lists every profile directory and no stray file beside them', async () => {
    const { root, instance } = realInstance();
    await writeFile(join(root, 'profiles', 'stray.txt'), 'not a profile');

    await instance.refresh();

    expect([...instance.value.profiles].sort()).toEqual(['Default', 'Secondary']);
  });

  it('names every folder under mods/, listed or not', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
    await mkdir(join(root, 'mods', 'Unlisted Folder'), { recursive: true });

    await instance.refresh();

    expect(present(instance.value.modFolders, 'the listed mods/ folders').map((f) => f.name).sort()).toEqual(['Consumer', 'Unlisted Folder']);
  });

  it('carries the folder of a listed mod whose line names it in another case, as the mod manager matches names by its own rule rather than by exact name', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '+consumer\n');

    await instance.refresh();

    expect(instance.value.paths.modDirs.get('consumer')).toBe(join(root, 'mods', 'Consumer'));
  });

  it("carries the game Data folder's root plugins, case-folded, and nothing below it", async () => {
    const { root, instance, setResolver } = await minimalInstanceWithoutCorpusMasters();
    const dataFolder = join(root, 'Game', 'Data');
    await mkdir(join(dataFolder, 'Textures'), { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.ESM'), '');
    await writeFile(join(dataFolder, 'Fallout4.ba2'), '');
    await writeFile(join(dataFolder, 'Hidden.esp.mohidden'), '');
    await writeFile(join(dataFolder, 'Textures', 'Nested.esp'), '');
    setResolver(() => Promise.resolve({ kind: 'found', root: dirname(dataFolder), dataFolder }));

    await instance.refresh();

    const listed = instance.value.dataFolderPlugins;
    expect(listed.kind).toBe('listed');
    expect([...(listed.kind === 'listed' ? listed.names : [])].sort()).toEqual(['fallout4.esm']);
  });

  it('tells an unresolved game directory from a folder that resolved and could not be read, an unreadable folder not being an empty set that would prune every plugins.txt line', async () => {
    const { instance, logs, setResolver } = await minimalInstanceWithoutCorpusMasters();

    await instance.refresh();
    expect(instance.value.dataFolderPlugins).toEqual({ kind: 'unresolved' });

    setResolver(() => Promise.resolve({ kind: 'found', root: '/nowhere', dataFolder: '/nowhere/Data' }));
    await instance.refresh();

    expect(instance.value.dataFolderPlugins).toMatchObject({ kind: 'unreadable' });
    expect(instance.sequence).toBe(2);
    expect(logs.filter((m) => m.includes('Data folder could not be listed'))).toHaveLength(1);
  });

  it('carries the plugins the game loads with no line: its masters from the per-release table, then its Creation Club plugins from the game folder\'s list, each only where the game can load it from', async () => {
    const { root, instance, setResolver } = await minimalInstanceWithoutCorpusMasters();
    const gameRoot = join(root, 'Game');
    const dataFolder = join(gameRoot, 'Data');
    await mkdir(dataFolder, { recursive: true });
    for (const name of ['DLCRobot.esm', 'Fallout4.esm', 'ccListed.esl']) await writeFile(join(dataFolder, name), '');
    await writeFile(join(gameRoot, 'Fallout4.ccc'), 'ccMissing.esl\r\nccListed.esl\r\n');
    setResolver(() => Promise.resolve({ kind: 'found', root: gameRoot, dataFolder }));

    await instance.refresh();

    expect(instance.value.pluginsLoadedWithNoLine).toEqual(
      ['Fallout4.esm', 'DLCRobot.esm', 'ccListed.esl'].map((name) => ({ name, origin: 'Data' })));
  });

  it('carries a game master an enabled mod provides where the game folder holds none', async () => {
    const { root, instance, setResolver } = await minimalInstanceWithoutCorpusMasters();
    const dataFolder = join(root, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(root, 'mods', 'Consumer', 'DLCCoast.esm'), '');
    setResolver(() => Promise.resolve({ kind: 'found', root: dirname(dataFolder), dataFolder }));

    await instance.refresh();

    expect(instance.value.pluginsLoadedWithNoLine).toEqual([{ name: 'DLCCoast.esm', origin: 'Consumer' }]);
  });

  it('carries no answer while the game folder is not found', async () => {
    const { instance } = await minimalInstanceWithoutCorpusMasters();

    await instance.refresh();

    expect(instance.value.pluginsLoadedWithNoLine).toBeUndefined();
  });
});

describe('Instance — the sidecar file id and meta.ini installedFiles', () => {
  it('carries a download row\'s fileID from its sidecar and a mod\'s installedFiles pairs from meta.ini', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
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

    const download = listedDownloadsOf(instance.value).find((d) => d.name === 'Consumer-1-2-3.7z');
    expect(download?.fileID).toBe('2000');

    const mod = instance.value.mods.find((m) => m.name === 'Consumer');
    expect(mod).toMatchObject({ installedFiles: [{ modid: '1000', fileid: '2000' }] });
  });

  it('carries no fileID on a download row whose sidecar has none, and no installedFiles on a mod with no meta.ini section', async () => {
    const { root, instance } = await minimalInstanceWithoutCorpusMasters();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'Plain-1.7z'), 'archive bytes');
    await writeFile(join(root, 'downloads', 'Plain-1.7z.meta'), '[General]\r\nmodID=1000\r\n');
    await writeFile(join(root, 'mods', 'Consumer', 'meta.ini'), '[General]\r\ngameName=Fallout4\r\n');

    await instance.refresh();

    const download = listedDownloadsOf(instance.value).find((d) => d.name === 'Plain-1.7z');
    expect(download?.fileID).toBeUndefined();

    const mod = instance.value.mods.find((m) => m.name === 'Consumer');
    expect(mod).toMatchObject({ installedFiles: undefined });
  });
});
