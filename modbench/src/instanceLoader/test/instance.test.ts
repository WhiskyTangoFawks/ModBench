import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { watchers, fakeVscodeModule, type FakeWatcher } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from '../../test/mo2/corpusFixture';
import { setEnabledInText } from '../../mo2Codecs/modlistText';
import { setSelectedProfileInText } from '../../mo2Codecs/modOrganizerIni';
import type { GameDirectoryResolver } from '../../instanceAdapter/gameDirectory';
import { downloadsDirectoryResolver, type DownloadsDirectoryResolution } from '../../instanceAdapter/downloadsDirectory';
import { GAME_FOLDER_NOT_FOUND, resolvesNotFound } from '../../test/mo2/gameFolderNotFound';

vi.mock('vscode', () => fakeVscodeModule());
// Passthrough by default, so one test can divert a path to a synthetic non-ENOENT error:
// chmod-based permission denial is silently bypassed when the runner is root.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import { Instance, type InstanceValue } from '../instance';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

const DATA_FOLDER = '/game/Data';

// The Instance adapter's own answer is doubled: where the game is is its question, not the Instance's.
const resolvesDataFolder: GameDirectoryResolver = () =>
  Promise.resolve({ kind: 'found', root: dirname(DATA_FOLDER), dataFolder: DATA_FOLDER });

interface Hooks {
  resolveGameDirectory?: GameDirectoryResolver;
}

async function realInstance(hooks: Hooks = {}): Promise<{
  root: string;
  instance: Instance;
  logs: string[];
  readFailureLines: string[];
  iniTextsResolved: string[];
  setResolver: (resolve: GameDirectoryResolver) => void;
}> {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const logs: string[] = [];
  const readFailureLines: string[] = [];
  const iniTextsResolved: string[] = [];
  let resolve = hooks.resolveGameDirectory ?? resolvesDataFolder;
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: (iniText) => {
      iniTextsResolved.push(iniText);
      return resolve(iniText);
    },
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
    log: (msg) => logs.push(msg),
    logReadFailure: (line) => readFailureLines.push(line),
  });
  instances.push(instance);
  return {
    root, instance, logs, readFailureLines, iniTextsResolved,
    setResolver: (next) => { resolve = next; },
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

// Downloads' own watcher is based at the resolved folder itself (glob `**`), never a fixed
// instance-relative glob, so it is found by base rather than by `watcherFor`'s glob lookup.
const downloadsWatcherFor = (instance: Instance): FakeWatcher => {
  const dir = instance.value.paths.downloadsDir;
  const found = watchers.filter((w) => w.base === dir && w.pattern === '**');
  expect(found).toHaveLength(1);
  return present(found[0], `the sole downloads watcher for ${dir}`);
};

// MO2, xEdit or the user rewriting the file, with Modbench none the wiser.
async function enableOutsideModbench(root: string, modName: string): Promise<void> {
  const path = join(root, DEFAULT_MODLIST);
  await writeFile(path, setEnabledInText(await readFile(path, 'utf8'), modName, true));
}

const isEnabled = (value: InstanceValue, name: string) => value.mods.find((m) => m.name === name)?.enabled;

// Every existing test builds a real, resolvable instance root, so its downloads are always
// listed; only the dedicated unresolved tests above name that kind directly.
const downloadsOf = (value: InstanceValue) => (value.downloads.kind === 'listed' ? value.downloads.rows : []);

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
  // of its own or mod sync never hears of it.
  it('carries a folder under mods with no line for the active profile as a mod folder, never as a mod', async () => {
    const { root, instance } = await realInstance();
    await mkdir(join(root, 'mods', 'Hand Extracted Mod'), { recursive: true });

    await instance.refresh();

    expect(instance.value.modFolders).toContain('Hand Extracted Mod');
    expect(instance.value.mods.map((m) => m.name)).not.toContain('Hand Extracted Mod');
  });

  // MO2 lists a linked mod folder as a mod (modinfo.cpp, QDir::Dirs without NoSymLinks). Rival: only
  // a real directory counts, so mod sync never hears of a symlinked mod.
  it('carries a mod folder that is a link to a folder, and not a link to a file', async () => {
    const { root, instance } = await realInstance();
    const target = await mkdtemp(join(tmpdir(), 'linked-mod-'));
    try {
      await symlink(target, join(root, 'mods', 'Linked Mod'), 'junction');
      await writeFile(join(target, 'readme.txt'), '');
      await symlink(join(target, 'readme.txt'), join(root, 'mods', 'Linked File'));

      await instance.refresh();

      expect(instance.value.modFolders).toContain('Linked Mod');
      expect(instance.value.modFolders).not.toContain('Linked File');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  // MO2 skips a link it cannot follow. Rivals: failing the whole recompute on it, which stalls the
  // instance; or a line per recompute, which every watched change would repeat.
  it('skips a mod folder link whose target cannot be checked, and tells it once', async () => {
    const { root, instance, logs, readFailureLines } = await realInstance();
    await mkdir(join(root, 'mods', 'Real Mod'));
    await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));

    await instance.refresh();
    await instance.refresh();

    expect(readFailureLines).toEqual([]);
    expect(instance.value.modFolders).toContain('Real Mod');
    expect(instance.value.modFolders).not.toContain('Loop');
    expect(logs.filter((line) => line.includes('Loop'))).toHaveLength(1);
  });

  // Only a directory can be a mod folder: a stray archive or Thumbs.db dropped into mods/ must
  // never earn a modlist line.
  it('never carries a stray file directly under mods as a mod folder', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'mods', 'Thumbs.db'), '');

    await instance.refresh();

    expect(instance.value.modFolders).not.toContain('Thumbs.db');
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
  it('owns a watcher for every MO2 file fixed at the instance root, before any read has landed', async () => {
    await realInstance();

    expect(watchers.map((w) => w.pattern).sort()).toEqual(
      ['ModOrganizer.ini', 'mods/**', 'overwrite/**', 'profiles/*/modlist.txt', 'profiles/*/plugins.txt'],
    );
  });

  // Downloads' own watcher cannot exist before its base is known — resolving it is an async read
  // of ModOrganizer.ini — so it joins the rest only once the first recompute lands.
  it('adds the downloads watcher, based at the resolved folder, once the first read lands', async () => {
    const { root, instance } = await realInstance();

    await instance.refresh();

    expect(downloadsWatcherFor(instance).base).toBe(join(root, 'downloads'));
  });

  it('disposes every watcher it owns, the downloads one included', async () => {
    const { instance } = await realInstance();
    await instance.refresh();

    instance.dispose();

    expect(watchers.map((w) => w.disposed)).toEqual([true, true, true, true, true, true]);
  });

  // A watcher just bound is not yet armed at the OS level; a file landing in that gap fires no
  // watcher event (never fired here) — only the rebind's own follow-up recompute can catch it.
  it('catches a file written in the gap before the just-bound downloads watcher can arm', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh(); // binds the downloads watcher for the first time
    const before = instance.sequence;

    await writeFile(join(root, 'downloads', 'RaceCondition.7z'), 'bytes');

    const after = await pastSequence(instance, before);
    expect(after.downloads.kind === 'listed' && after.downloads.rows.some((d) => d.name === 'RaceCondition.7z')).toBe(true);
  });

  it('a rebind that lands after dispose() creates no orphan downloads watcher', async () => {
    const root = await cloneCorpusFixture();
    roots.push(root);
    let resolveDownloadsDir: ((resolution: DownloadsDirectoryResolution) => void) | undefined;
    const pending = new Promise<DownloadsDirectoryResolution>((resolve) => { resolveDownloadsDir = resolve; });
    const instance = new Instance({
      instanceRoot: root,
      resolveGameDirectory: resolvesDataFolder,
      resolveDownloadsDirectory: () => pending,
      log: () => {}, logReadFailure: () => {},
    });
    instances.push(instance);

    const refreshed = instance.refresh(); // recompute begins, blocked on the pending resolver
    instance.dispose();
    present(resolveDownloadsDir, 'the captured resolver')({ kind: 'resolved', downloadsDir: join(root, 'downloads') });
    await refreshed;

    expect(watchers.some((w) => !w.disposed)).toBe(false);
  });

  // download_directory itself can move — the settings-file watcher is what notices the ini
  // rewrite — so the watcher aimed at the old folder must not linger once a newer one replaces it.
  it('rebinds the downloads watcher to the newly resolved folder when download_directory moves, disposing the old one', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    const originalWatcher = downloadsWatcherFor(instance);
    const iniPath = join(root, 'ModOrganizer.ini');
    const originalIni = await readFile(iniPath, 'utf8');

    await writeFile(iniPath, `${originalIni}download_directory=MovedDownloads\r\n`);
    await instance.refresh();

    expect(instance.value.paths.downloadsDir).toBe(join(root, 'MovedDownloads'));
    expect(originalWatcher.disposed).toBe(true);
    expect(downloadsWatcherFor(instance).base).toBe(join(root, 'MovedDownloads'));
  });

  // An untranslatable download_directory must not fail the whole recompute — Mods and Plugins do
  // not depend on downloads/, so a folder Modbench cannot resolve loses only the downloads rows.
  it('lands mods and plugins even when download_directory names an untranslatable drive letter', async () => {
    const { root, instance } = await realInstance();
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

  // Rival: falling back to the default downloads/ folder's own contents, which downloads.md,
  // story 1 forbids — nothing there may leak into rows, or be watched, while unresolved.
  it('lists and watches nothing from the default downloads/ folder while download_directory is unresolved', async () => {
    const { root, instance } = await realInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'RealArchive.7z'), 'bytes');
    await instance.refresh();
    expect(downloadsOf(instance.value)).toContainEqual(expect.objectContaining({ name: 'RealArchive.7z' }));
    const iniPath = join(root, 'ModOrganizer.ini');
    const originalIni = await readFile(iniPath, 'utf8');

    await writeFile(iniPath, `${originalIni}download_directory=D:\\Games\\downloads\r\n`);
    await instance.refresh();

    expect(instance.value.downloads).toMatchObject({ kind: 'unresolved' });
    expect(watchers.filter((w) => w.base === join(root, 'downloads') && !w.disposed)).toHaveLength(0);
    // paths.downloadsDir reaches uninstall, install and the Explorer dimming independently of
    // the Downloads view's own rows, so it must carry no default-folder guess either.
    expect(instance.value.paths.downloadsDir).toBeUndefined();
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
    downloadsWatcherFor(instance).fireCreate(join(root, 'downloads', 'New.7z'));

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
    const { root, instance, readFailureLines } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await writeFile(join(root, 'ModOrganizer.ini'), ''); // MO2 mid-rewrite
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
    expect(readFailureLines[0]).toContain('ModOrganizer.ini');
  });

  it('keeps the value when a mod\'s meta.ini is present but unreadable — never silently "no metadata"', async () => {
    const { root, instance, readFailureLines } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await rm(join(root, 'mods', 'Harder VATS', 'meta.ini'), { force: true });
    await mkdir(join(root, 'mods', 'Harder VATS', 'meta.ini')); // present but unreadable (EISDIR)
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
  });

  it('keeps the value when a folder inside overwrite/ is unreadable — never silently a smaller count', async () => {
    const { root, instance, readFailureLines } = await realInstance();
    const nested = join(root, 'overwrite', 'SKSE');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'skse.log'), '');
    await instance.refresh();
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

  // The failure a tree hears about before anything has landed, so its first render can settle on
  // an error node instead of a spinner that never ends (ADR-0019).
  it('reports a failed first read to failure subscribers, holds the sequence at 0, and lands the next successful read at sequence 1', async () => {
    const { root, instance } = await realInstance();
    const ini = join(root, 'ModOrganizer.ini');
    const complete = await readFile(ini, 'utf8');
    await writeFile(ini, ''); // unreadable before anything has landed
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

  // A gesture that asked for the read reports on that read, never an earlier one's failure.
  it('answers a refresh with its own read\'s failure, and with none once that read lands', async () => {
    const { root, instance } = await realInstance();
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
    const { root, instance } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const failures: (string | undefined)[] = [];
    instance.onReadFailure(() => failures.push(instance.readFailure));

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

describe('Instance — downloads, profile and game directory', () => {
  it('carries downloads with status and hidden, the active profile, the resolved game directory and release, from one value', async () => {
    const { instance } = await realInstance();

    await instance.refresh();

    expect(downloadsOf(instance.value)).toContainEqual(
      expect.objectContaining({
        name: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
        status: 'Installed',
        excluded: false,
      }),
    );
    expect(instance.value.activeProfile).toBe('Default');
    expect(instance.value.gameRelease).toBe('Fallout 4');
    expect(instance.value.nexusSlug).toBe('fallout4');
    expect(instance.value.gameFolder).toEqual({ kind: 'found', root: dirname(DATA_FOLDER), dataFolder: DATA_FOLDER });
  });

  it('carries no deployed state, whether or not a deploy manifest sits under mods/', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'mods', '.medit-manifest.json'), JSON.stringify({ links: [], preExisting: [] }));

    await instance.refresh();

    expect(instance.value).not.toHaveProperty('deployed');
  });

  // The fixture's sidecar claims `installed=true`, and only the Unofficial Patch mod's own
  // meta.ini makes that claim true. Rival: reading Status off the sidecar alone.
  it('drops a download\u2019s Installed row once the mod that named it is gone, sidecar claim and all', async () => {
    const { root, instance } = await realInstance();
    const archive = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
    const statusOf = () => downloadsOf(instance.value).find((d) => d.name === archive)?.status;
    await instance.refresh();
    expect(statusOf()).toBe('Installed');

    await rm(join(root, 'mods', 'Unofficial Fallout 4 Patch'), { recursive: true, force: true });
    await instance.refresh();

    expect(statusOf()).toBe('Uninstalled');
  });

  it('reads a download as Installed from a mod folder with no line in the active profile\u2019s modlist', async () => {
    const { root, instance } = await realInstance();
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'Off-Profile-1.7z'), 'archive bytes');
    await writeModFile(root, 'Off Profile Mod', 'meta.ini', '[General]\r\ninstallationFile=Off-Profile-1.7z\r\n');

    await instance.refresh();

    expect(instance.value.mods.map((m) => m.name)).not.toContain('Off Profile Mod');
    expect(instance.value.modFolders).toContain('Off Profile Mod');
    const download = downloadsOf(instance.value).find((d) => d.name === 'Off-Profile-1.7z');
    expect(download?.status).toBe('Installed');
  });

  // Same rule as the active-profile "Harder VATS" case above: only ENOENT reads as empty, so an
  // off-profile folder's own unreadable meta.ini still fails the whole recompute.
  it('keeps the value when an off-profile mod\'s meta.ini is present but unreadable', async () => {
    const { root, instance, readFailureLines } = await realInstance();
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;

    await mkdir(join(root, 'mods', 'Off Profile Mod', 'meta.ini'), { recursive: true }); // present but unreadable (EISDIR)
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(readFailureLines).toHaveLength(1);
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

  // The empty value already has empty `downloads`, so the assertion alone cannot tell a
  // tolerated absence from a swallowed throw — the sequence bump proves the recompute landed.
  it('yields a value with no downloads, rather than a failure, when downloads/ is absent', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(downloadsOf(instance.value).length).toBeGreaterThan(0); // the fixture starts with one
    const before = instance.sequence;

    await rm(join(root, 'downloads'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.downloads).toEqual({ kind: 'listed', rows: [] });
  });

  // A workspace before its first install has no mods/, and the sequence bump proves the
  // recompute landed. Absent is not empty: mod sync would drop every line against an empty list.
  it('yields a value whose mod folders are unknown, rather than a failure, when mods/ is absent', async () => {
    const { root, instance } = await realInstance();
    await instance.refresh();
    expect(instance.value.modFolders?.length).toBeGreaterThan(0);
    const before = instance.sequence;

    await rm(join(root, 'mods'), { recursive: true, force: true });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.modFolders).toBeUndefined();
  });

  // The empty value already reads as not found, so a prior found refresh plus the sequence bump
  // prove a landed value rather than a swallowed failure.
  it('lands a value carrying the game folder not found, with each place looked, rather than a failure', async () => {
    const { instance, setResolver, readFailureLines } = await realInstance();
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

  // Rival: a configuration naming no game read as the game folder not found, which a missing
  // gameName also leaves Steam nothing to go on for.
  it('fails the read, keeping the last value, when the configuration names no game', async () => {
    const { root, instance, readFailureLines } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;
    const ini = join(root, 'ModOrganizer.ini');
    await writeFile(ini, (await readFile(ini, 'utf8')).replace(/gameName=.*\r?\n/, ''));

    await instance.refresh();

    expect(instance.sequence).toBe(before);
    expect(instance.readFailure).toMatch(/gameName/);
    expect(readFailureLines).toHaveLength(1);
  });

  // A mod- or overwrite-provided row keeps its real path; a listed name only Data/ could provide
  // still gets a row — existence, slot and enabled come from plugins.txt alone — with `path:
  // undefined` rather than a guess or a drop.
  it('keeps every plugins.txt line as a row when the game directory is unresolved, Data-only rows line-only', async () => {
    const { instance, setResolver } = await realInstance();
    await instance.refresh();
    const withGameDirectory = instance.value.plugins;
    // Sanity: the fixture has at least one Data-folder-only listed plugin today, so its path is
    // resolved through the game directory this test is about to take away.
    const dataOnlyBefore = withGameDirectory.find((p) => p.name === 'Unofficial Fallout 4 Patch.esp');
    expect(dataOnlyBefore?.origin).toBe('Data');
    expect(dataOnlyBefore?.path).toEqual(expect.any(String));
    const modProvidedBefore = withGameDirectory.find((p) => p.name === 'NonAsciiRetexture.esp');
    expect(modProvidedBefore?.path).toEqual(expect.any(String));

    setResolver(resolvesNotFound);
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

  it('recomputes with the game directory the resolver now answers, yielding a new value and sequence', async () => {
    const { root, instance, setResolver } = await realInstance();
    await instance.refresh();
    const before = instance.sequence;
    const explicitDir = join(root, 'ExplicitGame');
    setResolver(() => Promise.resolve({ kind: 'found', root: explicitDir, dataFolder: join(explicitDir, 'Data') }));

    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.gameFolder).toEqual({ kind: 'found', root: explicitDir, dataFolder: join(explicitDir, 'Data') });
  });

  // The Instance's whole input: the instance directory it was given, and the resolver's answer
  // for the ini text this recompute read.
  it('hands the resolver this recompute’s own ini text, once', async () => {
    const { root, instance, iniTextsResolved } = await realInstance();

    await instance.refresh();

    expect(iniTextsResolved).toHaveLength(1);
    expect(present(iniTextsResolved[0], 'the ini text handed to the resolver'))
      .toBe(await readFile(join(root, 'ModOrganizer.ini'), 'utf8'));
  });

  // Rival: re-reading the ini for the game release, landing one value holding two generations
  // of the file. The resolver fires mid-recompute, after the read this value is built from.
  it('builds one value from one generation of the ini, even when it is rewritten mid-recompute', async () => {
    const { root, instance, setResolver } = await realInstance();
    await instance.refresh();
    const beforeRelease = instance.value.gameRelease;
    const ini = join(root, 'ModOrganizer.ini');
    setResolver(async () => {
      const text = await readFile(ini, 'utf8');
      await writeFile(ini, text.replace(/gameName=.*/, 'gameName=Rewritten Mid Recompute'));
      return GAME_FOLDER_NOT_FOUND;
    });

    await instance.refresh();

    expect(instance.value.gameRelease).toBe(beforeRelease);
    // Positive control: the rewrite is real, and the next recompute does read it.
    setResolver(resolvesNotFound);
    await instance.refresh();
    expect(instance.value.gameRelease).toBe('Rewritten Mid Recompute');
  });

  it('carries the paths a view renders: overwrite/, downloads/ and each listed mod’s own folder', async () => {
    const { root, instance } = await realInstance();

    await instance.refresh();

    const { paths, mods } = instance.value;
    expect(paths.overwriteDir).toBe(join(root, 'overwrite'));
    expect(paths.downloadsDir).toBe(join(root, 'downloads'));
    const first = present(mods.find((m) => m.kind === 'mod'), 'the fixture\'s first mod');
    expect(paths.modDirs.get(first.name)).toBe(join(root, 'mods', first.name));
    expect(paths.modDirs.size).toBe(mods.filter((m) => m.kind === 'mod').length);
  });

  // Rival: paths filled only once a read lands, which would leave a view constructed at
  // activation joining its own. downloadsDir needs a read first, so it carries no guess.
  it('carries those paths from sequence 0, before any read has landed', () => {
    const instance = new Instance({
      instanceRoot: '/an/instance', resolveGameDirectory: resolvesNotFound,
      resolveDownloadsDirectory: downloadsDirectoryResolver(), log: () => {}, logReadFailure: () => {},
    });
    instances.push(instance);

    expect(instance.sequence).toBe(0);
    expect(instance.value.paths.overwriteDir).toBe(join('/an/instance', 'overwrite'));
    expect(instance.value.paths.downloadsDir).toBeUndefined();
  });
});

// A bespoke minimal instance (not the corpus clone), so a mod's declared masters are exactly
// what the test wrote — real xEdit-produced corpus bytes carry unknown master lists of their own.
async function minimalInstance(): Promise<{
  root: string; instance: Instance; logs: string[]; readFailureLines: string[];
  setResolver: (resolve: GameDirectoryResolver) => void;
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
  let resolve: GameDirectoryResolver = resolvesNotFound;
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: (iniText) => resolve(iniText),
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
    log: (msg) => logs.push(msg),
    logReadFailure: (line) => readFailureLines.push(line),
  });
  instances.push(instance);
  return { root, instance, logs, readFailureLines, setResolver: (next) => { resolve = next; } };
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
    const { root, instance, readFailureLines } = await minimalInstance();
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
    expect(readFailureLines).toHaveLength(1);
  });

  // The other half, on the same isolated tree: ENOENT alone is tolerated, and the value lands.
  it('lands a value whose mod folders are unknown when mods/ is absent entirely', async () => {
    const { root, instance } = await minimalInstance();
    await separatorOnly(root);
    await rm(join(root, 'mods'), { recursive: true, force: true });

    await instance.refresh();

    expect(instance.sequence).toBe(1);
    expect(instance.value.modFolders).toBeUndefined();
  });
});

describe('Instance — what a command is handed instead of probing for it', () => {
  it('lists every profile directory and no stray file beside them', async () => {
    const { root, instance } = await realInstance();
    await writeFile(join(root, 'profiles', 'stray.txt'), 'not a profile');

    await instance.refresh();

    expect([...instance.value.profiles].sort()).toEqual(['Default', 'Secondary']);
  });

  it('names every folder under mods/, listed or not', async () => {
    const { root, instance } = await minimalInstance();
    await mkdir(join(root, 'mods', 'Unlisted Folder'), { recursive: true });

    await instance.refresh();

    expect([...present(instance.value.modFolders, 'the listed mods/ folders')].sort()).toEqual(['Consumer', 'Unlisted Folder']);
  });

  it("carries the game Data folder's root plugins, case-folded, and nothing below it", async () => {
    const { root, instance, setResolver } = await minimalInstance();
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

  // A folder nobody could read is its own answer, not an empty one: pruning plugins.txt against
  // an empty set would delete every line, and the command refuses on this instead.
  it('tells an unresolved game directory from a folder that resolved and could not be read', async () => {
    const { instance, logs, setResolver } = await minimalInstance();

    await instance.refresh();
    expect(instance.value.dataFolderPlugins).toEqual({ kind: 'unresolved' });

    setResolver(() => Promise.resolve({ kind: 'found', root: '/nowhere', dataFolder: '/nowhere/Data' }));
    await instance.refresh();

    expect(instance.value.dataFolderPlugins).toMatchObject({ kind: 'unreadable' });
    expect(instance.sequence).toBe(2);
    expect(logs.filter((m) => m.includes('Data folder could not be listed'))).toHaveLength(1);
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

    const download = downloadsOf(instance.value).find((d) => d.name === 'Consumer-1-2-3.7z');
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

    const download = downloadsOf(instance.value).find((d) => d.name === 'Plain-1.7z');
    expect(download?.fileID).toBeUndefined();

    const mod = instance.value.mods.find((m) => m.name === 'Consumer');
    expect(mod).toMatchObject({ installedFiles: undefined });
  });
});
