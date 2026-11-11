import { GAME_FOLDER_SETTING_ID } from '../../test/gameFolderSetting';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type {
  DataFolderArchives, DataFolderPlugins, GameFolder, InstanceAdapter, InstanceReading, Mod,
  OriginFiles, Separator, PublisherTag, ProgramVersions, Reread,
} from '../../instanceAdapter/instanceAdapter';
import { downloadedFilesOf, fakeInstanceAdapter, fileIn, modFoldersIn, modFoldersOf, readingFixture, repositoriesOf } from '../../test/fakeInstanceAdapter';
import { leveledLog } from '../../test/leveledLog';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { Instance, instanceMessages, type InstanceValue } from '../instance';
import { factsOf } from '../instanceFacts';
import { modOrigin } from '../fileConflictIndex';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { writeManifestIn } from '../../manifestAdapter/manifestAdapter';

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

interface WindowState {
  focused: boolean;
}

const mod = (name: string, enabled = true, meta: Partial<Mod> = {}): Mod => ({ kind: 'mod', name, enabled, ...meta });
const separator = (name: string): Separator => ({ kind: 'separator', name, enabled: false });

const filesOfMod = (name: string, ...relativePaths: string[]): OriginFiles =>
  ({ origin: name, folder: `/instance/mods/${name}`, files: relativePaths.map((path) => fileIn(`/instance/mods/${name}`, path)), folders: [], notes: [] });

const GAME_FOLDER: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const inDataFolder = (...names: string[]): DataFolderPlugins => ({ kind: 'listed', names: new Set(names) });
const GAME_FOUND: Partial<InstanceReading> = {
  gameFolder: GAME_FOLDER,
  dataFolderPlugins: inDataFolder(),
  dataFolderArchives: { kind: 'listed', archives: [], stringsFiles: [] } satisfies DataFolderArchives,
};

function loader(overrides: Partial<InstanceReading> = {}, wrap: (adapter: InstanceAdapter) => InstanceAdapter = (adapter) => adapter) {
  const fake = fakeInstanceAdapter(readingFixture(overrides));
  const medit = new InMemoryMEditClient();
  const log = leveledLog();
  const windowListeners = new Set<(state: WindowState) => void>();
  const window = {
    state: { focused: true },
    onDidChangeWindowState: (listener: (state: WindowState) => void) => {
      windowListeners.add(listener);
      return { dispose: () => { windowListeners.delete(listener); } };
    },
  };
  const instance = new Instance({
    adapter: wrap(fake.adapter),
    gameFolderSettingId: GAME_FOLDER_SETTING_ID,
    window,
    log,
    medit,
  });
  instances.push(instance);
  return {
    instance, fake, medit, logs: log.lines.info, warnings: log.lines.warn, errorLines: log.lines.error, windowListeners,
    windowState: (state: WindowState) => {
      window.state = state;
      for (const listener of [...windowListeners]) listener(state);
    },
  };
}

function handedStringsFiles(snapshot: InstanceValue['loadOrderSnapshot']): { path: string; stamp: string }[] {
  return snapshot !== undefined && 'plugins' in snapshot ? snapshot.plugins.flatMap((plugin) => plugin.stringsFiles) : [];
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

const fakeClockLeavingSetImmediateReal = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
};

const SETTLE_MS = 200;
const LONG_QUIET_MS = 60_000;
const CHECK: Reread = { named: [], disk: true };
const reread = (...named: string[]): Reread => ({ named, disk: false });

const listedRows = (value: InstanceValue) => (value.downloadedFiles.kind === 'listed' ? value.downloadedFiles.rows : []);

const NONO = 'Ñoño\'s Retexture';
const PATCH = 'Unofficial Fallout 4 Patch';

describe('Instance — the value', () => {
  it('hands the first value once read, and the held one without another read once it has landed', async () => {
    const { instance, fake } = loader({ mods: [mod('A')] });

    const first = await instance.landed();
    const again = await instance.landed();

    expect(instance.sequence).toBe(1);
    expect(first.mods).toEqual([mod('A')]);
    expect(again).toBe(first);
    expect(fake.readings).toBe(1);
  });

  it('starts empty at sequence 0, before anything has been read', () => {
    const { instance } = loader({ mods: [mod('A')] });

    expect(instance.sequence).toBe(0);
    expect(instance.value.mods).toEqual([]);
    expect(instance.value.plugins).toEqual([]);
    expect([...instance.value.files]).toEqual([]);
    expect(instance.value.filesByMod.size).toBe(0);
  });

  it('carries the reading\'s mods, mod folders, profiles, game and game folder as one value, a mod folder with no line a folder and never a mod', async () => {
    const mods = [mod(NONO), separator('Section'), mod('Harder VATS', false)];
    const { instance } = loader({
      mods, modFolders: modFoldersOf(NONO, 'Hand Extracted Mod'), profile: 'Secondary', profiles: ['Default', 'Secondary'],
      gameName: 'Fallout 4', gameRelease: 'Fallout4', gameFolder: GAME_FOLDER, programVersions: { kind: 'unknownGame' }, gameFolderLinks: 4,
    });

    await instance.refresh();

    const { value } = instance;
    expect(value.mods).toEqual(mods);
    expect(value.modFolders?.map((f) => f.name)).toEqual([NONO, 'Hand Extracted Mod']);
    expect(value.activeProfile).toBe('Secondary');
    expect(value.profiles).toEqual(['Default', 'Secondary']);
    expect(value.gameName).toBe('Fallout 4');
    expect(value.gameFolder).toEqual(GAME_FOLDER);
    expect(value.programVersions).toEqual({ kind: 'unknownGame' });
    expect(value.gameFolderLinks).toBe(4);
  });

  it.each([['Starfield', true], ['Fallout4', false]])('carries whether the game loads a blueprint plugin last: %s, %s', async (gameRelease, answer) => {
    const { instance } = loader({ gameRelease });

    await instance.refresh();

    expect(instance.value.blueprintLoadsLast).toBe(answer);
  });

  it('carries whether the instance holds a repository', async () => {
    const { instance } = loader({ holdsRepository: true });

    await instance.refresh();

    expect(instance.value.holdsRepository).toBe(true);
  });

  it('says on the message line that the mod manager overwrites the user\'s changes while it runs, before the last good read, and nothing once it stops', async () => {
    const { instance, fake } = loader({ managerRunning: { kind: 'running' } });
    const beforeRead = instanceMessages(instance);
    await instance.refresh();
    const running = instanceMessages(instance);
    fake.failReading('EACCES modlist.txt');
    await instance.refresh();
    const beside = instanceMessages(instance);
    fake.failReading(undefined);
    fake.read({ managerRunning: { kind: 'notRunning' } });
    await instance.refresh();

    const warning = 'Fake manager is running, and overwrites your changes when it launches a program or exits.';
    expect([beforeRead, running, beside, instanceMessages(instance)]).toEqual([
      [undefined, undefined],
      [warning, undefined],
      [warning, 'Showing the last good read: EACCES modlist.txt'],
      [undefined, undefined],
    ]);
  });

  it('says on the message line, and once in the Output until the reason changes, that it cannot tell whether the mod manager is running', async () => {
    const { instance, fake, warnings } = loader({ managerRunning: { kind: 'unknown', reason: 'tasklist exited with code 1' } });
    await instance.refresh();
    await instance.refresh();
    const message = instanceMessages(instance);
    fake.read({ managerRunning: { kind: 'unknown', reason: 'tasklist timed out' } });
    await instance.refresh();
    await instance.refresh();
    fake.read({ managerRunning: { kind: 'notRunning' } });
    await instance.refresh();

    expect([message, instanceMessages(instance)]).toEqual([['Cannot tell whether Fake manager is running: tasklist exited with code 1.', undefined], [undefined, undefined]]);
    expect(warnings).toEqual([
      '[instance] Cannot tell whether Fake manager is running: tasklist exited with code 1.',
      '[instance] Cannot tell whether Fake manager is running: tasklist timed out.',
    ]);
  });

  it('carries each mod a repository builds as a source mod, with that repository as its source folder, and each repository alone as a source mod', async () => {
    const { instance } = loader({
      mods: [mod('Harder VATS'), mod('[NODELETE] Radfall'), mod('Plain')],
      sourceModFolders: repositoriesOf(
        { 'Harder VATS': '/source/Harder VATS', '[nodelete] radfall': '/source/Renamed From', 'Cloned And Unlisted': '/source/Cloned And Unlisted' },
      ),
    });

    await instance.refresh();

    expect([...instance.value.listedSourceMods].sort()).toEqual(['Harder VATS', '[NODELETE] Radfall']);
    expect([...instance.value.sourceMods].sort()).toEqual(['Cloned And Unlisted', 'Harder VATS', '[NODELETE] Radfall']);
    expect(instance.value.paths.sourceDirs.get('[NODELETE] Radfall')).toBe('/source/Renamed From');
    expect(instance.value.paths.sourceDirs.get('Cloned And Unlisted')).toBe('/source/Cloned And Unlisted');
  });

  it('tells which mod folder builds from no repository, as its manifest cannot be read', async () => {
    const mods = await mkdtemp(join(tmpdir(), 'loader-source-mods-'));
    await mkdir(join(mods, 'Harder VATS'));
    await writeFile(join(mods, 'Harder VATS', 'Harder VATS.manifest.json'), '{');
    const { instance, logs } = loader({ mods: [mod('Harder VATS')], modFolders: modFoldersIn(mods, 'Harder VATS') });

    await instance.refresh().finally(() => rm(mods, { recursive: true }));

    expect(logs).toContain(`[instance] ${join(mods, 'Harder VATS')} builds from no repository, as its manifest is not valid JSON at line 1: Expected property name or '}' in JSON at position 1.`);
  });

  it('carries no source folder for a mod named as a renamed repository\'s folder still is, that repository being the source of the mod its build names', async () => {
    const { instance } = loader({ mods: [mod('Harder VATS')], sourceModFolders: repositoriesOf({ 'Harder VATS Renamed': '/source/Harder VATS' }) });

    await instance.refresh();

    expect(instance.value.listedSourceMods.has('Harder VATS')).toBe(false);
    expect(instance.value.paths.sourceDirs.has('Harder VATS')).toBe(false);
    expect(instance.value.paths.sourceDirs.get('Harder VATS Renamed')).toBe('/source/Harder VATS');
  });

  it('tells once, until it changes or clears, each note of the reading', async () => {
    const note = 'a file was removed mid-read';
    const noted = { runtimeOutput: { ...readingFixture().runtimeOutput, notes: [note] } };
    const { instance, logs, fake } = loader(noted);
    const told = (): number => logs.filter((line) => line.includes(note)).length;

    await instance.refresh();
    await instance.refresh();
    expect(told()).toBe(1);

    fake.read({ runtimeOutput: readingFixture().runtimeOutput });
    await instance.refresh();
    fake.read(noted);
    await instance.refresh();
    expect(told()).toBe(2);
  });

  it('tells once rather than on every watched change that a link cannot be followed, without failing the recompute', async () => {
    const { instance, logs, errorLines } = loader({ modFolders: modFoldersOf('Real Mod'), linkNotes: ['/inst/mods/Loop is a link Modbench cannot follow, so it is not read: too many levels'] });

    await instance.refresh();
    await instance.refresh();

    expect(errorLines).toEqual([]);
    expect(instance.sequence).toBe(2);
    expect(logs.filter((line) => line.includes('Loop'))).toEqual(['[instance] /inst/mods/Loop is a link Modbench cannot follow, so it is not read: too many levels']);
  });

  it('names the mod a note on its files belongs to', async () => {
    const note = 'broken link "/instance/mods/A/x.dds", skipped';
    const { instance, logs } = loader({ mods: [mod('A')], modFiles: new Map([['A', { ...filesOfMod('A', 'a.dds'), notes: [note] }]]) });

    await instance.refresh();

    expect(logs).toEqual([`[instance] A: ${note}`]);
  });

  it('carries the winner of a path two enabled mods provide, and each listed mod\'s own files and folders, a disabled mod\'s too', async () => {
    const folder = { relativePath: 'textures', path: '/instance/mods/Harder VATS/textures', includedPath: 'textures', excluded: false };
    const { instance } = loader({
      mods: [mod(NONO), mod(PATCH), mod('Harder VATS', false)],
      modFiles: new Map([
        [NONO, filesOfMod(NONO, 'textures/shared.dds')],
        [PATCH, filesOfMod(PATCH, 'textures/shared.dds')],
        ['Harder VATS', { ...filesOfMod('Harder VATS', 'textures/shared.dds'), folders: [folder] }],
      ]),
    });

    await instance.refresh();

    const entry = instance.value.files.get('textures/shared.dds');
    expect(entry?.winner).toBe(`/instance/mods/${NONO}/textures/shared.dds`);
    expect(entry?.providers).toEqual([{ kind: 'mod', name: NONO }, { kind: 'mod', name: PATCH }]);
    expect(instance.value.filesByMod.get('Harder VATS')?.map((f) => f.relativePath)).toEqual(['textures/shared.dds']);
    expect(instance.value.foldersByMod.get('Harder VATS')).toEqual([folder]);
  });

  it('carries every plugin — listed, unlisted and Data-folder — with origin, line, enabled and winning, a disabled mod\'s own plugin too', async () => {
    const { instance } = loader({
      ...GAME_FOUND,
      dataFolderPlugins: inDataFolder('Unofficial Fallout 4 Patch.esp'),
      mods: [mod(NONO), mod('Harder VATS', false)],
      pluginOrder: [{ name: 'NonAsciiRetexture.esp', enabled: true }, { name: 'Unofficial Fallout 4 Patch.esp', enabled: true }],
      modFiles: new Map([
        [NONO, filesOfMod(NONO, 'NonAsciiRetexture.esp', 'NonAsciiRetexture - Addon.esl')],
        ['Harder VATS', filesOfMod('Harder VATS', 'Harder VATS.esp')],
      ]),
    });

    await instance.refresh();

    expect(instance.value.plugins).toEqual([
      { name: 'NonAsciiRetexture.esp', path: `/instance/mods/${NONO}/NonAsciiRetexture.esp`, origin: NONO, line: 0, enabled: true, winning: true },
      { name: 'Unofficial Fallout 4 Patch.esp', path: join('/game/Data', 'Unofficial Fallout 4 Patch.esp'), origin: 'Data/', line: 1, enabled: true, winning: true },
      { name: 'NonAsciiRetexture - Addon.esl', path: `/instance/mods/${NONO}/NonAsciiRetexture - Addon.esl`, origin: NONO, line: null, enabled: false, winning: true },
      { name: 'Harder VATS.esp', path: '/instance/mods/Harder VATS/Harder VATS.esp', origin: 'Harder VATS', line: null, enabled: false, winning: false },
    ]);
  });
});

describe('Instance — redraw', () => {
  it('tells the views that listen to a redraw, and runs no subscriber of the value and reads nothing', async () => {
    const { instance, fake } = loader();
    await instance.landed();
    const subscriber = vi.fn();
    const view = vi.fn();
    instance.subscribe(subscriber);
    instance.onRedraw(view);
    const readsBefore = fake.calls.length;

    instance.redraw();

    expect({ view: view.mock.calls.length, subscriber: subscriber.mock.calls.length, reads: fake.calls.length - readsBefore }).toEqual({ view: 1, subscriber: 0, reads: 0 });
  });

  it('tells a view that stopped listening nothing', () => {
    const { instance } = loader();
    const view = vi.fn();
    instance.onRedraw(view).dispose();

    instance.redraw();

    expect(view).not.toHaveBeenCalled();
  });
});

describe('Instance — built by watching', () => {
  it('listens for the adapter\'s signal and the window\'s state from construction, before any read, until disposed', () => {
    const { instance, fake, windowListeners } = loader();
    expect(instance.sequence).toBe(0);
    expect([fake.subscribers, windowListeners.size]).toEqual([1, 1]);

    instance.dispose();

    expect([fake.subscribers, windowListeners.size]).toEqual([0, 0]);
  });

  it('reads again what a burst of events names, in one re-read once the burst settles', async () => {
    const { instance, fake } = loader();
    await instance.refresh();

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
      fake.changed('/instance/mods/B/meta.ini');
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
      expect(fake.rereads).toEqual([CHECK]);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }

    expect(fake.rereads).toEqual([CHECK, reread('/instance/mods/A/a.esp', '/instance/mods/B/meta.ini')]);
    expect(instance.sequence).toBe(2);
  });

  it('checks the disk no more after the re-read of what a change names, however long the events stay quiet', async () => {
    const { instance, fake } = loader();
    await instance.refresh();

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(LONG_QUIET_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(fake.rereads).toEqual([CHECK, reread('/instance/mods/A/a.esp')]);
  });

  it('hands each subscriber what the value was read again for: the paths the events named, or the check of the disk', async () => {
    const { instance, fake } = loader();
    const landedFor: Reread[] = [];
    instance.subscribe((_value, _sequence, landed) => { landedFor.push(landed); });

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    expect(landedFor).toEqual([reread('/instance/mods/A/a.esp'), CHECK]);
  });

  it('checks the disk with no path to read again when the adapter hears a change it cannot name', async () => {
    const { instance, fake } = loader();
    await instance.refresh();

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed();
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(fake.rereads).toEqual([CHECK, CHECK]);
  });

  it('may be late from the first event until its re-read has landed, and tells the views at each change', async () => {
    const { instance, fake } = loader();
    await instance.refresh();
    const told: boolean[] = [];
    instance.onMayBeLate(() => { told.push(instance.mayBeLate); });
    const late: boolean[] = [];

    fakeClockLeavingSetImmediateReal();
    try {
      late.push(instance.mayBeLate);
      fake.changed('/instance/mods/A/a.esp');
      fake.changed('/instance/mods/A/b.esp');
      late.push(instance.mayBeLate);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      late.push(instance.mayBeLate);
    } finally {
      vi.useRealTimers();
    }

    expect({ late, told }).toEqual({ late: [false, true, false], told: [true, false] });
  });

  it('may be late still when an event arrives while a re-read reads', async () => {
    let release!: () => void;
    let readHeld: Promise<void> = Promise.resolve();
    const { instance, fake } = loader({}, (adapter) => ({
      ...adapter,
      reading: async (asked) => {
        await readHeld;
        return adapter.reading(asked);
      },
    }));
    await instance.refresh();

    fakeClockLeavingSetImmediateReal();
    try {
      readHeld = new Promise<void>((resolve) => { release = resolve; });
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      fake.changed('/instance/mods/A/b.esp');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(instance.mayBeLate).toBe(true);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(instance.mayBeLate).toBe(false);
  });

  it('is not late for a refresh asked while a read runs, as no change was heard', async () => {
    let release!: () => void;
    let readHeld: Promise<void> = Promise.resolve();
    const { instance } = loader({}, (adapter) => ({
      ...adapter,
      reading: async (asked) => {
        await readHeld;
        return adapter.reading(asked);
      },
    }));
    await instance.refresh();
    readHeld = new Promise<void>((resolve) => { release = resolve; });
    const reading = instance.refresh();
    const waiting = instance.refresh();
    const told = vi.fn();
    instance.onMayBeLate(told);

    release();
    await Promise.all([reading, waiting]);

    expect(told).not.toHaveBeenCalled();
  });

  it('is not late for a re-read whose read failed, which the message line says', async () => {
    const { instance, fake } = loader();
    await instance.refresh();
    fake.failReading('disk gone');

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(instance.mayBeLate).toBe(false);
  });

  it('is not late for a check the window focus asked for', async () => {
    const { instance, windowState } = loader();
    await instance.refresh();
    windowState({ focused: false });
    const told = vi.fn();
    instance.onMayBeLate(told);

    windowState({ focused: true });
    await pastSequence(instance, 1);

    expect(told).not.toHaveBeenCalled();
  });

  it('checks the disk at once when the window regains focus, and not when it loses it or keeps it', async () => {
    const { instance, fake, windowState } = loader();
    await instance.refresh();

    windowState({ focused: true });
    windowState({ focused: false });
    await instance.refresh();
    expect(fake.rereads).toEqual([CHECK, CHECK]);

    windowState({ focused: true });
    await pastSequence(instance, 2);

    expect(fake.rereads).toEqual([CHECK, CHECK, CHECK]);
  });

  it('adds no check when the window regains focus while a check already waits', async () => {
    let release!: () => void;
    let readHeld: Promise<void> = Promise.resolve();
    const { instance, fake, windowState } = loader({}, (adapter) => ({
      ...adapter,
      reading: async (asked) => {
        await readHeld;
        return adapter.reading(asked);
      },
    }));
    await instance.refresh();
    windowState({ focused: false });
    readHeld = new Promise<void>((resolve) => { release = resolve; });
    const reading = instance.refresh();
    const waiting = instance.refresh();

    windowState({ focused: true });
    release();
    await Promise.all([reading, waiting]);

    expect(fake.rereads).toEqual([CHECK, CHECK, CHECK]);
  });

  it('finishes a re-read in progress, and folds the events heard during it into one more', async () => {
    let release!: () => void;
    let readHeld: Promise<void> = Promise.resolve();
    const { instance, fake } = loader({}, (adapter) => ({
      ...adapter,
      reading: async (asked) => {
        await readHeld;
        return adapter.reading(asked);
      },
    }));
    await instance.refresh();
    const landed: number[] = [];
    instance.subscribe((_value, sequence) => { landed.push(sequence); });

    fakeClockLeavingSetImmediateReal();
    try {
      readHeld = new Promise<void>((resolve) => { release = resolve; });
      fake.changed('/instance/mods/A/a.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      fake.changed('/instance/mods/A/b.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      fake.changed('/instance/mods/A/c.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      fake.changed('/instance/mods/A/d.esp');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect(landed).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }

    expect(landed).toEqual([2, 3]);
    expect(fake.rereads).toEqual([CHECK, reread('/instance/mods/A/a.esp'), reread('/instance/mods/A/b.esp', '/instance/mods/A/c.esp', '/instance/mods/A/d.esp')]);
  });

  it('settles a refresh asked during a stream of events once the read in flight and one more have run', async () => {
    const READ_MS = 1_200;
    const { instance, fake } = loader({}, (adapter) => ({
      ...adapter,
      reading: async (asked) => {
        await new Promise((resolve) => setTimeout(resolve, READ_MS));
        return adapter.reading(asked);
      },
    }));
    fakeClockLeavingSetImmediateReal();
    try {
      const first = instance.refresh();
      await vi.advanceTimersByTimeAsync(READ_MS);
      await first;
      const stream = setInterval(() => { fake.changed('/instance/overwrite/again.txt'); }, SETTLE_MS * 1.5);
      await vi.advanceTimersByTimeAsync(3 * READ_MS + SETTLE_MS / 2);
      const readsBefore = fake.readings;
      let settled = false;
      void instance.refresh().then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(2 * READ_MS);
      clearInterval(stream);

      expect(readsBefore).toBeGreaterThan(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the check a burst waits on when refreshed mid-burst, reading what the burst named, and leaves no wait armed', async () => {
    const { instance, fake } = loader();
    await instance.refresh();

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed('/instance/mods/A/a.esp');
      await instance.refresh();
      await vi.advanceTimersByTimeAsync(LONG_QUIET_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(fake.rereads).toEqual([CHECK, { named: ['/instance/mods/A/a.esp'], disk: true }]);
  });

  it('tells each change the check on window focus found that no event named, and none a refresh found', async () => {
    const { instance, fake, logs, windowState } = loader();
    await instance.refresh();
    fake.read({ unheardChanges: ['/instance/mods/A/textures'] });
    await instance.refresh();
    expect(logs).toEqual([]);
    windowState({ focused: false });

    windowState({ focused: true });
    await pastSequence(instance, 2);

    expect(logs).toEqual(['[instance] The check of the disk found a change no event named: /instance/mods/A/textures']);
  });

  it('tells each change the check after a change with no path found, as that change named none', async () => {
    const { instance, fake, logs } = loader();
    await instance.refresh();
    fake.read({ unheardChanges: ['/instance/mods/A/textures'] });

    fakeClockLeavingSetImmediateReal();
    try {
      fake.changed();
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(logs).toEqual(['[instance] The check of the disk found a change no event named: /instance/mods/A/textures']);
  });

  it('yields the next value at a higher sequence when the adapter signals a change', async () => {
    const { instance, fake } = loader({ mods: [mod('Harder VATS', false)] });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ mods: [mod('Harder VATS', true)] });
    fake.changed();

    const landed = await pastSequence(instance, before);
    expect(landed.mods).toEqual([mod('Harder VATS', true)]);
  });

  it('corrects the value on refresh after a change the adapter never signalled, a profile switch included', async () => {
    const { instance, fake } = loader({ mods: [mod('Harder VATS', false)], profile: 'Default' });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ mods: [mod('Harder VATS', true)], profile: 'Secondary' });
    expect(instance.value.mods).toEqual([mod('Harder VATS', false)]);
    await instance.refresh();

    expect(instance.value.mods).toEqual([mod('Harder VATS', true)]);
    expect(instance.value.activeProfile).toBe('Secondary');
    expect(instance.sequence).toBe(before + 1);
  });
});

describe('Instance — a write that changes several files', () => {
  it('lands no value read inside it, and lands the refresh after it', async () => {
    const { instance } = loader();
    await instance.refresh();
    const before = instance.sequence;

    await instance.quiet(async () => {
      await instance.refresh();
      expect(instance.sequence).toBe(before);
    });

    expect(instance.sequence).toBe(before + 1);
  });

  it('reports only the failure of the read after it, not of one inside it that fails on a file the write is half-way through', async () => {
    const { instance, fake, errorLines } = loader();
    await instance.refresh();
    const heard = vi.fn();
    instance.onReadFailure(heard);

    await instance.quiet(async () => {
      fake.failReading('ModOrganizer.ini is empty');
      await instance.refresh();
    });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(errorLines).toHaveLength(1);
  });
});

describe('Instance — a value that survives a bad read', () => {
  it('keeps the previous value, logs, and reports the failure to failure subscribers when the reading fails after a value has landed', async () => {
    const { instance, fake, errorLines } = loader({ mods: [mod('A')] });
    await instance.refresh();
    const value = instance.value;
    const before = instance.sequence;
    const failures: (string | undefined)[] = [];
    instance.onReadFailure(() => failures.push(instance.readFailure));

    fake.failReading('ModOrganizer.ini is half-written');
    await instance.refresh();

    expect(instance.value).toBe(value);
    expect(instance.sequence).toBe(before);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('ModOrganizer.ini');
    expect(failures).toEqual(['ModOrganizer.ini is half-written']);
    expect(instance.readFailure).toBe(failures[0]);
  });

  it('reports a failed first read to failure subscribers, so a tree can settle on an error node, holds the sequence at 0, and lands the next successful read at sequence 1', async () => {
    const { instance, fake } = loader({ mods: [mod('A')] });
    fake.failReading('ModOrganizer.ini is empty');
    const failures: (string | undefined)[] = [];
    const landed: number[] = [];
    instance.onReadFailure(() => failures.push(instance.readFailure));
    instance.subscribe((_value, sequence) => { landed.push(sequence); });

    await instance.refresh();

    expect(failures).toEqual(['ModOrganizer.ini is empty']);
    expect(landed).toEqual([]);
    expect(instance.sequence).toBe(0);

    fake.failReading(undefined);
    await instance.refresh();

    expect(landed).toEqual([1]);
    expect(instance.readFailure).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('publishes an empty mod list, since zero mods is legal', async () => {
    const { instance, fake } = loader({ mods: [mod('A')], modFiles: new Map([['A', filesOfMod('A', 'a.dds')]]) });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ mods: [], modFiles: new Map() });
    await instance.refresh();

    expect(instance.value.mods).toEqual([]);
    expect(instance.value.filesByMod.size).toBe(0);
    expect(instance.sequence).toBe(before + 1);
  });

  it('keeps the file conflict index across a refresh that changed no listing, and builds it again when a listing changed', async () => {
    const modFiles = new Map([['A', filesOfMod('A', 'a.dds')]]);
    const { instance, fake } = loader({ mods: [mod('A')], modFiles });
    await instance.refresh();
    const first = instance.value.files;

    fake.read({ modFiles: new Map(modFiles) });
    await instance.refresh();
    const unchanged = instance.value.files;
    fake.read({ modFiles: new Map([['A', filesOfMod('A', 'a.dds')]]) });
    await instance.refresh();

    expect(unchanged).toBe(first);
    expect(instance.value.files).not.toBe(first);
  });

  it('keeps recomputing after a subscriber throws', async () => {
    const { instance } = loader();
    const seen: number[] = [];
    const thrown: (string | undefined)[] = [];
    instance.onListenerOutcome(({ threw }) => thrown.push(threw));
    instance.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    instance.subscribe((_value, sequence) => { seen.push(sequence); });

    await instance.refresh();
    await instance.refresh();

    expect(seen).toEqual([1, 2]);
    expect(thrown).toEqual(['subscriber exploded', undefined, 'subscriber exploded', undefined]);
  });

  it('settles a refresh once the subscribers it handed the value to have settled', async () => {
    const { instance } = loader();
    let finish!: () => void;
    const finished: string[] = [];
    instance.subscribe(() => new Promise<void>((resolve) => { finish = resolve; }));
    instance.subscribe(() => { finished.push('another subscriber'); });

    const refreshed = instance.refresh().then(() => finished.push('refresh'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toEqual(['another subscriber']);
    finish();
    await refreshed;

    expect(finished).toEqual(['another subscriber', 'refresh']);
  });

  it('recomputes again while a subscriber has not settled, and holds only its own refresh', async () => {
    const { instance } = loader();
    const heard: number[] = [];
    instance.subscribe((_value, sequence) => {
      heard.push(sequence);
      return sequence === 1 ? new Promise<void>(() => undefined) : undefined;
    });

    void instance.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.refresh();

    expect(heard).toEqual([1, 2]);
  });

  it('tells of a subscriber whose promise rejects, and keeps recomputing', async () => {
    const { instance } = loader();
    const thrown: (string | undefined)[] = [];
    instance.onListenerOutcome(({ threw }) => thrown.push(threw));
    instance.subscribe(() => Promise.reject(new Error('derivation exploded')));

    await instance.refresh();
    await instance.refresh();

    expect(thrown).toEqual(['derivation exploded', 'derivation exploded']);
  });

  it('tells of a read-failure listener that throws, as one that follows a failed read', async () => {
    const { instance, fake } = loader();
    const outcomes: { during: string; threw: string | undefined }[] = [];
    instance.onListenerOutcome(({ during, threw }) => outcomes.push({ during, threw }));
    instance.onReadFailure(() => { throw new Error('failure listener exploded'); });
    fake.failReading('unreadable');

    await instance.refresh();

    expect(outcomes).toEqual([{ during: 'read-failure', threw: 'failure listener exploded' }]);
  });
});

describe('Instance — downloads', () => {
  const DOWNLOADED_FILE_NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

  it('carries the downloaded files as rows, and the folder they are listed from', async () => {
    const { instance } = loader({ downloadedFiles: downloadedFilesOf(DOWNLOADED_FILE_NAME) });

    await instance.refresh();

    expect(listedRows(instance.value).map((row) => row.name)).toEqual([DOWNLOADED_FILE_NAME]);
    expect(instance.value.paths.downloadsDir).toBe('/downloads');
  });

  it('reads a downloaded file as Installed from the meta of a mod folder, one with no line in the mod order too, and drops it once the folder is gone', async () => {
    const { instance, fake } = loader({
      mods: [mod(PATCH)],
      downloadedFiles: downloadedFilesOf(DOWNLOADED_FILE_NAME, 'Off-Profile-1.7z'),
      folderMeta: new Map([[PATCH, { installationFileName: DOWNLOADED_FILE_NAME }], ['Off Profile Mod', { installationFileName: 'Off-Profile-1.7z' }]]),
    });
    await instance.refresh();
    expect(listedRows(instance.value).map((row) => [row.name, row.status])).toEqual([[DOWNLOADED_FILE_NAME, 'Installed'], ['Off-Profile-1.7z', 'Installed']]);

    fake.read({ folderMeta: new Map() });
    await instance.refresh();

    expect(listedRows(instance.value).map((row) => row.status)).toEqual(['Downloaded', 'Downloaded']);
  });

  it('yields a value with no downloaded files, rather than a failure, when the downloads folder is absent', async () => {
    const { instance, fake } = loader({ downloadedFiles: downloadedFilesOf(DOWNLOADED_FILE_NAME) });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files: undefined } });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.downloadedFiles).toEqual({ kind: 'listed', rows: [] });
  });

  it('lands mods and plugins when the downloads folder is unresolved, losing only the rows and the folder', async () => {
    const reason = 'download_directory names a drive letter this machine cannot translate';
    const { instance } = loader({ mods: [mod('A')], downloadedFiles: { kind: 'unresolved', reason } });

    await instance.refresh();

    expect(instance.readFailure).toBeUndefined();
    expect(instance.value.mods).toEqual([mod('A')]);
    expect(instance.value.downloadedFiles).toEqual({ kind: 'unresolved', reason });
    expect(instance.value.paths.downloadsDir).toBeUndefined();
  });
});

describe('Instance — game folder and the archives the game loads', () => {
  const SUPPLIED = join('/game/Data', 'Fallout4 - Interface.ba2');

  it('hands the snapshot the archives the INIs list, and tells once, until it changes, the INIs it did not find', async () => {
    const note = 'The profile Default keeps no game INIs of its own';
    const { instance, warnings, logs } = loader({
      ...GAME_FOUND,
      archiveList: ['Fallout4 - Interface.ba2'],
      archiveListNotes: [note],
      dataFolderArchives: { kind: 'listed', archives: ['Fallout4 - Interface.ba2'], stringsFiles: [] },
    });

    await instance.refresh();
    await instance.refresh();

    expect(instance.value.loadOrderSnapshot).toMatchObject({ listedArchives: [{ path: SUPPLIED }] });
    expect(warnings).toEqual([`[instance] ${note}`]);
    expect(logs).toEqual([]);
  });

  it('warns of each line the reading left out as a repeat', async () => {
    const note = 'plugins.txt lists the plugin A.esp on more than one line; the first line holds';
    const { instance, warnings } = loader({ ...GAME_FOUND, orderNotes: [note] });

    await instance.refresh();

    expect(warnings).toEqual([`[instance] ${note}`]);
  });

  it('warns once, until it changes, of each change the watch cannot hear', async () => {
    const note = 'Modbench hears no change inside a folder whose watch failed: EACCES: permission denied';
    const { instance, warnings } = loader({ ...GAME_FOUND, watchNotes: [note] });

    await instance.refresh();
    await instance.refresh();

    expect(warnings).toEqual([`[instance] ${note}`]);
  });

  it('tells once, until it changes, each archive the INIs list that nothing holds', async () => {
    const { instance, logs } = loader({
      ...GAME_FOUND,
      archiveList: ['Fallout4 - Interface.ba2', 'Gone.ba2'],
      dataFolderArchives: { kind: 'listed', archives: ['Fallout4 - Interface.ba2'], stringsFiles: [] },
    });

    await instance.refresh();
    await instance.refresh();

    expect(logs).toEqual(['[instance] The game\'s INIs list the archive Gone.ba2, which no mod, Overwrite or game folder holds.']);
  });

  it('hands a mod\'s plugin the new stamp of a strings file rewritten beside it, at the next read', async () => {
    const stringsFile = '/instance/mods/Patch Mod/Strings/Patch Mod_en.STRINGS';
    let modifiedNs = 1n;
    const { instance } = loader({
      ...GAME_FOUND,
      mods: [mod('Patch Mod')],
      pluginOrder: [{ name: 'Patch Mod.esp', enabled: true }],
      modFolders: modFoldersOf('Patch Mod'),
      modFiles: new Map([['Patch Mod', filesOfMod('Patch Mod', 'Patch Mod.esp', 'Strings/Patch Mod_en.STRINGS')]]),
    }, (adapter) => ({ ...adapter, fileStamp: (path) => Promise.resolve({ kind: 'read', answer: { size: 5n, modifiedNs: path === stringsFile ? modifiedNs : 0n } }) }));
    await instance.refresh();
    const before = handedStringsFiles(instance.value.loadOrderSnapshot);

    modifiedNs = 2n;
    await instance.refresh();

    const after = handedStringsFiles(instance.value.loadOrderSnapshot);
    expect([before, after]).toEqual([[{ path: stringsFile, stamp: '5/1' }], [{ path: stringsFile, stamp: '5/2' }]]);
  });

  it('lands a value carrying the game folder not found, rather than a failure, and back again when it is found', async () => {
    const { instance, fake, errorLines } = loader({ mods: [mod('A')], gameFolder: GAME_FOLDER });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ gameFolder: GAME_FOLDER_NOT_FOUND });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.readFailure).toBeUndefined();
    expect(errorLines).toEqual([]);
    expect(instance.value.gameFolder).toEqual(GAME_FOLDER_NOT_FOUND);
    expect(instance.value.mods).toEqual([mod('A')]);

    fake.read({ gameFolder: GAME_FOLDER });
    await instance.refresh();

    expect(instance.value.gameFolder).toEqual(GAME_FOLDER);
  });

  it('carries the paths a view renders: overwrite/, downloads/ and each listed mod\'s own folder, matched as the manager matches names, where it has one', async () => {
    const { instance } = loader({
      mods: [mod('compiledPlugin'), mod('Radfall'), separator('Section')],
      modFolders: modFoldersOf('CompiledPlugin'),
      runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [], folders: [], notes: [] },
    });

    await instance.refresh();

    const { paths } = instance.value;
    expect(paths.overwriteDir).toBe('/overwrite');
    expect(paths.downloadsDir).toBe('/downloads');
    expect(paths.modDirs).toEqual(new Map([['compiledPlugin', '/instance/mods/CompiledPlugin']]));
  });

  it('carries a source folder for each source mod alone, one with no mod folder too, and hands it to the facts', async () => {
    const { instance } = loader({ mods: [mod('Radfall')], sourceModFolders: repositoriesOf({ Radfall: '/source/Radfall' }) });

    await instance.refresh();

    const { paths } = instance.value;
    expect(paths.modDirs.has('Radfall')).toBe(false);
    expect(paths.sourceDirs).toEqual(new Map([['Radfall', '/source/Radfall']]));
    expect(factsOf(instance).sourceDirs()).toBe(paths.sourceDirs);
  });

  it('names the mod manager and its mod-order file as the adapter does rather than as the value spells them, before the first read too', () => {
    const names = { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' };
    const { instance } = loader({}, (adapter) => ({ ...adapter, names }));

    expect(instance.value.managerNames).toEqual(names);
  });

  it('names no folder before the first read lands, the adapter alone knowing where the instance keeps its folders', () => {
    const { instance } = loader();

    expect(instance.sequence).toBe(0);
    expect(instance.value.paths).toEqual({ overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs: new Map() });
  });
});

describe('Instance — Overwrite\'s files', () => {
  it('carries each file and folder under the overwrite/ folder, by the path in it and where it sits', async () => {
    const log = fileIn('/overwrite', 'F4SE/plugin.log');
    const folder = { relativePath: 'F4SE', path: '/overwrite/F4SE', includedPath: 'F4SE', excluded: false };
    const { instance, fake } = loader();
    await instance.refresh();
    expect(instance.value.overwriteFiles).toEqual([]);

    fake.read({ runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [log], folders: [folder], notes: [] } });
    await instance.refresh();

    expect(instance.value.overwriteFiles).toEqual([log]);
    expect(instance.value.overwriteFolders).toEqual([folder]);
  });
});

describe('Instance — the mod folders, the game folder\'s plugins and the load order snapshot the value carries', () => {
  it('carries mod folders unknown, rather than a failure, when there is no folder for mods at all, absent not being empty', async () => {
    const { instance, fake } = loader({ modFolders: modFoldersOf('A') });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ modFolders: undefined });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.modFolders).toBeUndefined();
  });

  it('tells once while it stands that the Data folder could not be listed', async () => {
    const { instance, warnings } = loader({ gameFolder: GAME_FOLDER, dataFolderPlugins: { kind: 'unreadable', reason: 'EACCES' } });

    await instance.refresh();
    await instance.refresh();

    expect(instance.value.dataFolderPlugins).toEqual({ kind: 'unreadable', reason: 'EACCES' });
    expect(warnings).toEqual(['[instance] the game\'s Data folder could not be listed: EACCES']);
  });

  it('tells once while it stands that a folder below the Data folder\'s root could not be listed', async () => {
    const { instance, warnings } = loader({ gameFolder: GAME_FOLDER, dataFolderFiles: { kind: 'unreadable', reason: 'EACCES' } });

    await instance.refresh();
    await instance.refresh();

    expect(warnings).toEqual(['[instance] the game\'s Data folder could not be listed whole: EACCES']);
  });

  it('tells one warning, not two, when the Data folder cannot be listed at all', async () => {
    const unreadable = { kind: 'unreadable', reason: 'EACCES' } as const;
    const { instance, warnings } = loader({ gameFolder: GAME_FOLDER, dataFolderPlugins: unreadable, dataFolderFiles: unreadable });

    await instance.refresh();

    expect(warnings).toEqual(['[instance] the game\'s Data folder could not be listed: EACCES']);
  });

  it.each<[string, ProgramVersions, string[]]>([
    ['a game program the game folder lacks', { kind: 'found', game: { kind: 'notFound', program: 'Fallout4.exe' }, extender: { kind: 'read', version: '1' } },
      ['[instance] the game\'s version: Fallout4.exe is not in the game folder']],
    ['a loader that is unreadable', { kind: 'found', game: { kind: 'read', version: '1' }, extender: { kind: 'unreadable', program: 'f4se_loader.exe', why: 'EACCES' } },
      ['[instance] the script extender\'s version: f4se_loader.exe cannot be read: EACCES']],
    ['a loader that is no program', { kind: 'found', game: { kind: 'read', version: '1' }, extender: { kind: 'notAProgram', program: 'f4se_loader.exe' } },
      ['[instance] the script extender\'s version: f4se_loader.exe is not a Windows program']],
    ['a loader the game folder lacks, which is an answer', { kind: 'found', game: { kind: 'read', version: '1' }, extender: { kind: 'notFound', program: 'f4se_loader.exe' } }, []],
  ])('tells once while it stands of %s', async (_, programVersions, lines) => {
    const { instance, warnings } = loader({ gameFolder: GAME_FOLDER, programVersions });

    await instance.refresh();
    await instance.refresh();

    expect(warnings).toEqual(lines);
  });

  it('carries the publisher tags the adapter declares before any read, and the publisher\'s configuration once read', async () => {
    const tag: PublisherTag = { name: 'Include', badge: 'IN', marksPaths: true };
    const configuration = { kind: 'read', covering: (): readonly PublisherTag[] => [tag], listed: (): readonly PublisherTag[] => [], pathProblems: [], unshippable: { file: '', reason: () => undefined } } as const;
    const { instance } = loader({ publisherConfiguration: configuration }, (adapter) => ({ ...adapter, publisherTags: [tag] }));
    const before = { tags: instance.value.publisherTags, configuration: instance.value.publisherConfiguration };

    await instance.refresh();

    expect([before, { tags: instance.value.publisherTags, configuration: instance.value.publisherConfiguration }])
      .toEqual([{ tags: [tag], configuration: { kind: 'none' } }, { tags: [tag], configuration }]);
  });

  it('tells once while it stands that the publisher\'s configuration could not be read', async () => {
    const { instance, warnings } = loader({ publisherConfiguration: { kind: 'unreadable', reason: 'compiler_settings.json is not JSON' } });

    await instance.refresh();
    await instance.refresh();

    expect(warnings).toEqual(['[instance] no publisher tag shows: compiler_settings.json is not JSON']);
  });

  it('carries the plugins the game loads with no line: its masters from the per-release table, then its Creation Club plugins, each only where the game can load it from', async () => {
    const { instance } = loader({
      gameFolder: GAME_FOLDER,
      gameRelease: 'Fallout4',
      dataFolderPlugins: inDataFolder('DLCRobot.esm', 'Fallout4.esm', 'ccListed.esl'),
      creationClubList: ['ccMissing.esl', 'ccListed.esl'],
    });

    await instance.refresh();

    expect(instance.value.pluginsLoadedWithNoLine).toEqual(
      ['Fallout4.esm', 'DLCRobot.esm', 'ccListed.esl'].map((name) => ({ name, origin: 'Data/', path: join('/game/Data', name) })));
  });

  it('carries the load order snapshot put load order sends, keyed on the game folder it was derived from, each mod with its folder and a source mod with its source folder', async () => {
    const { instance } = loader({
      ...GAME_FOUND, gameRelease: 'Fallout4', mods: [mod('Consumer')], modFolders: modFoldersOf('Consumer'),
      modFiles: new Map([['Consumer', filesOfMod('Consumer', 'DLCCoast.esm')]]),
      sourceModFolders: repositoriesOf({ Consumer: '/source/Consumer Source' }),
    });

    await instance.refresh();

    expect(instance.value.loadOrderSnapshot).toMatchObject({
      dataFolder: '/game/Data',
      plugins: [{
        name: 'DLCCoast.esm',
        provider: { kind: 'Mod', mod: 'Consumer', folder: '/instance/mods/Consumer', sourceFolder: '/source/Consumer Source' },
      }],
      loadedWithNoLine: [{ name: 'DLCCoast.esm', origin: 'Consumer' }],
      active: [{ name: 'DLCCoast.esm', origin: 'Consumer' }],
    });
  });

  it('carries no answer and no snapshot while the game folder is not found', async () => {
    const { instance } = loader({ mods: [mod('Consumer')] });

    await instance.refresh();

    expect(instance.value.gameFolder.kind).toBe('notFound');
    expect(instance.value.pluginsLoadedWithNoLine).toBeUndefined();
    expect(instance.value.loadOrderSnapshot).toBeUndefined();
    expect(instance.hasLoadOrderToHand).toBe(false);
  });

  it('has a load order to hand before the first read lands, and once it carries a snapshot', async () => {
    const { instance } = loader({
      ...GAME_FOUND, gameRelease: 'Fallout4', mods: [mod('Consumer')], modFolders: modFoldersOf('Consumer'),
      modFiles: new Map([['Consumer', filesOfMod('Consumer', 'DLCCoast.esm')]]),
    });
    expect(instance.hasLoadOrderToHand).toBe(true);

    await instance.refresh();

    expect(instance.hasLoadOrderToHand).toBe(true);
  });
});

describe('Instance — what each flagged plugin could have held before its flags', () => {
  const FLAGS = { Small: true };
  const COPY = 'AAAAAAAAAAA=';
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function flaggedLoader(flagsOf: Record<string, typeof FLAGS> = { 'Mod.esp': FLAGS }, holdsRepository = true) {
    const mods = await mkdtemp(join(tmpdir(), 'loader-flagged-'));
    dirs.push(mods);
    const folder = join(mods, 'A');
    await mkdir(folder);
    await writeManifestIn(folder, { packages: [], exclude: [], ignore: [], flags: new Map(Object.entries(flagsOf)), files: new Map(Object.keys(flagsOf).map((path) => [path, COPY])) });
    let stamp = 1n;
    const made = loader(
      { mods: [mod('A')], modFolders: modFoldersIn(mods, 'A'), modFiles: new Map([['A', { origin: 'A', folder, files: [fileIn(folder, 'Mod.esp'), fileIn(folder, 'Other.esp')], folders: [], notes: [] }]]), holdsRepository },
      (adapter) => ({ ...adapter, fileStamp: () => Promise.resolve({ kind: 'read', answer: { size: 1n, modifiedNs: stamp } }) }),
    );
    return { ...made, plugin: join(folder, 'Mod.esp'), touch: () => { stamp += 1n; } };
  }

  const asked = (medit: InMemoryMEditClient) => medit.calls.filter((call) => call.method === 'getFlaggedPluginHashes').map((call) => call.args);

  it('carries what mEdit says each plugin file its mod\'s manifest flags could have held, by the path it is read from', async () => {
    const { instance, medit, plugin } = await flaggedLoader();
    medit.setQueryAnswer('getFlaggedPluginHashes', [{ path: plugin, hashes: [COPY, 'BBBBBBBBBBA='] }]);

    await instance.refresh();

    expect(asked(medit)).toEqual([['Fallout4', [{ path: plugin, flags: FLAGS }]]]);
    expect(instance.value.flaggedHashes).toEqual(new Map([[plugin, { kind: 'read', answer: [COPY, 'BBBBBBBBBBA='] }]]));
  });

  it('holds a file mEdit could not read unreadable, with why', async () => {
    const { instance, medit, plugin } = await flaggedLoader();
    medit.setQueryAnswer('getFlaggedPluginHashes', [{ path: plugin, hashes: [], unreadable: 'EACCES' }]);

    await instance.refresh();

    expect(instance.value.flaggedHashes.get(plugin)).toEqual({ kind: 'unreadable', reason: 'EACCES' });
  });

  it('asks mEdit again only for a file whose stamp changed since it answered', async () => {
    const { instance, medit, plugin, touch } = await flaggedLoader();
    medit.setQueryAnswerOnce('getFlaggedPluginHashes', [{ path: plugin, hashes: ['old'] }]);
    medit.setQueryAnswerOnce('getFlaggedPluginHashes', [{ path: plugin, hashes: ['new'] }]);
    await instance.refresh();
    await instance.refresh();
    touch();
    await instance.refresh();

    expect(asked(medit)).toHaveLength(2);
    expect(instance.value.flaggedHashes.get(plugin)).toEqual({ kind: 'read', answer: ['new'] });
  });

  it('holds a file unanswered while mEdit cannot be reached, and asks again once mEdit runs', async () => {
    const { instance, medit, plugin } = await flaggedLoader();
    medit.setQueryFailureOnce('getFlaggedPluginHashes', { failed: 'unreachable' });
    medit.setQueryAnswerOnce('getFlaggedPluginHashes', [{ path: plugin, hashes: [COPY] }]);
    await instance.refresh();
    const unreached = instance.value.flaggedHashes.get(plugin);

    medit.setStatus('running');
    const reached = (await pastSequence(instance, 1)).flaggedHashes.get(plugin);

    expect([unreached, reached]).toEqual([{ kind: 'unanswered' }, { kind: 'read', answer: [COPY] }]);
  });

  it.each([
    ['a mod whose manifest flags no plugin it holds', { 'Gone.esp': FLAGS }, true],
    ['an instance that holds no repository', { 'Mod.esp': FLAGS }, false],
  ])('asks mEdit nothing for %s', async (_what, flagsOf, holdsRepository) => {
    const { instance, medit } = await flaggedLoader(flagsOf, holdsRepository);

    await instance.refresh();

    expect([asked(medit), instance.value.flaggedHashes.size]).toEqual([[], 0]);
  });
});

describe('Instance — what each archive holds', () => {
  const MOD_ARCHIVE = '/instance/mods/A/A - Main.ba2';
  const OVERWRITE_ARCHIVE = '/overwrite/B.ba2';
  const ARCHIVES_HELD: Partial<InstanceReading> = {
    mods: [mod('A')],
    modFiles: new Map([['A', filesOfMod('A', 'A.esp', 'A - Main.ba2', 'meshes/Not At The Root.ba2')]]),
    runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [fileIn('/overwrite', 'B.ba2')], folders: [], notes: [] },
  };
  const holding = (archive: string, ...files: string[]) => ({ archive, files, unreadable: null });
  const asked = (medit: InMemoryMEditClient) => medit.calls.filter((call) => call.method === 'getArchiveContents').map((call) => call.args);

  it('carries what mEdit says each archive at the root of a mod or Overwrite holds, by the path it is read from', async () => {
    const { instance, medit } = loader(ARCHIVES_HELD, (adapter) => ({ ...adapter, fileStamp: () => Promise.resolve({ kind: 'read', answer: { size: 1n, modifiedNs: 1n } }) }));
    medit.setQueryAnswer('getArchiveContents', [holding(MOD_ARCHIVE, 'meshes/a.nif'), { archive: OVERWRITE_ARCHIVE, files: [], unreadable: 'it is no BA2' }]);

    await instance.refresh();

    expect(asked(medit)).toEqual([['Fallout4', [MOD_ARCHIVE, OVERWRITE_ARCHIVE]]]);
    expect(instance.value.archiveContents).toEqual(new Map([
      [MOD_ARCHIVE, { kind: 'read', answer: ['meshes/a.nif'] }],
      [OVERWRITE_ARCHIVE, { kind: 'unreadable', reason: 'it is no BA2' }],
    ]));
  });

  it('asks mEdit again only for an archive whose stamp changed since it answered', async () => {
    let overwriteStamp = 1n;
    const { instance, medit } = loader(ARCHIVES_HELD, (adapter) => ({
      ...adapter, fileStamp: (path) => Promise.resolve({ kind: 'read', answer: { size: 1n, modifiedNs: path === OVERWRITE_ARCHIVE ? overwriteStamp : 1n } }),
    }));
    medit.setQueryAnswerOnce('getArchiveContents', [holding(MOD_ARCHIVE, 'meshes/a.nif'), holding(OVERWRITE_ARCHIVE, 'old.nif')]);
    medit.setQueryAnswerOnce('getArchiveContents', [holding(OVERWRITE_ARCHIVE, 'new.nif')]);
    await instance.refresh();

    overwriteStamp = 2n;
    await instance.refresh();

    expect(asked(medit)).toEqual([['Fallout4', [MOD_ARCHIVE, OVERWRITE_ARCHIVE]], ['Fallout4', [OVERWRITE_ARCHIVE]]]);
    expect(instance.value.archiveContents).toEqual(new Map([
      [MOD_ARCHIVE, { kind: 'read', answer: ['meshes/a.nif'] }],
      [OVERWRITE_ARCHIVE, { kind: 'read', answer: ['new.nif'] }],
    ]));
  });

  it('holds an archive unanswered while mEdit cannot be reached, never unreadable, and asks again once mEdit runs', async () => {
    const { instance, medit } = loader(ARCHIVES_HELD, (adapter) => ({ ...adapter, fileStamp: () => Promise.resolve({ kind: 'read', answer: { size: 1n, modifiedNs: 1n } }) }));
    medit.setQueryFailureOnce('getArchiveContents', { failed: 'unreachable' });
    medit.setQueryAnswerOnce('getArchiveContents', [holding(MOD_ARCHIVE, 'meshes/a.nif'), holding(OVERWRITE_ARCHIVE)]);
    await instance.refresh();
    const unreached = instance.value.archiveContents.get(MOD_ARCHIVE);

    medit.setStatus('running');
    const reached = (await pastSequence(instance, 1)).archiveContents.get(MOD_ARCHIVE);

    expect([unreached, reached]).toEqual([{ kind: 'unanswered' }, { kind: 'read', answer: ['meshes/a.nif'] }]);
  });

  it('tells the Output once, until it changes, each archive that cannot be read, and why', async () => {
    const { instance, medit, warnings } = loader(ARCHIVES_HELD, (adapter) => ({
      ...adapter, fileStamp: (path) => Promise.resolve(path === OVERWRITE_ARCHIVE ? { kind: 'unreadable', reason: 'gone' } : { kind: 'read', answer: { size: 1n, modifiedNs: 1n } }),
    }));
    medit.setQueryAnswer('getArchiveContents', [{ archive: MOD_ARCHIVE, files: [], unreadable: 'it is no BA2' }]);

    await instance.refresh();
    await instance.refresh();

    expect(warnings).toEqual([
      `[instance] The archive ${MOD_ARCHIVE} cannot be read: it is no BA2`,
      `[instance] The archive ${OVERWRITE_ARCHIVE} cannot be read: gone`,
    ]);
  });

  it('says why an archive is not read when its stamp cannot be read, and asks mEdit nothing for it', async () => {
    const { instance, medit } = loader(ARCHIVES_HELD, (adapter) => ({
      ...adapter, fileStamp: (path) => Promise.resolve(path === MOD_ARCHIVE ? { kind: 'unreadable', reason: 'gone' } : { kind: 'read', answer: { size: 1n, modifiedNs: 1n } }),
    }));
    medit.setQueryAnswer('getArchiveContents', [holding(OVERWRITE_ARCHIVE)]);

    await instance.refresh();

    expect(asked(medit)).toEqual([['Fallout4', [OVERWRITE_ARCHIVE]]]);
    expect(instance.value.archiveContents.get(MOD_ARCHIVE)).toEqual({ kind: 'unreadable', reason: 'gone' });
  });

  it.each([
    ['an archive the INIs list', 'Listed.ba2', true],
    ['an archive named for an active plugin', 'A - Main.ba2', true],
    ['an archive named for a disabled plugin', 'Off - Main.ba2', false],
    ['an archive named for no plugin', 'Other.ba2', false],
  ])('carries whether the game loads %s', async (_case, archive, loads) => {
    const { instance } = loader({
      mods: [mod('A')],
      modFiles: new Map([['A', filesOfMod('A', 'A.esp', 'Off.esp', archive)]]),
      pluginOrder: [{ name: 'A.esp', enabled: true }, { name: 'Off.esp', enabled: false }],
      archiveList: ['Listed.ba2'],
    });

    await instance.refresh();

    expect(instance.value.loadsArchive(archive)).toBe(loads);
  });

  describe('the copies of each file, stacked as the game stacks them', () => {
    const FILE = 'meshes/x.nif';
    const archived = (name: string, archive: string) =>
      ({ origin: modOrigin(name), at: { kind: 'archived', gameRelease: 'Fallout4', archive: `/instance/mods/${name}/${archive}`, file: FILE } });
    const stackOf = async (reading: Partial<InstanceReading>, answers: ReturnType<typeof holding>[]) => {
      const { instance, medit } = loader(
        { pluginOrder: [{ name: 'A.esp', enabled: true }, { name: 'Off.esp', enabled: false }], ...reading },
        (adapter) => ({ ...adapter, fileStamp: () => Promise.resolve({ kind: 'read', answer: { size: 1n, modifiedNs: 1n } }) }),
      );
      medit.setQueryAnswer('getArchiveContents', answers);
      await instance.refresh();
      return instance.value.stackedCopies.get(FILE)?.copies;
    };

    it('stacks the INIs\' archives below each active plugin\'s, whatever the mod order', async () => {
      const copies = await stackOf({
        mods: [mod('B'), mod('A')], archiveList: ['Listed.ba2'],
        modFiles: new Map([['A', filesOfMod('A', 'A.esp', 'A - Main.ba2')], ['B', filesOfMod('B', 'Listed.ba2')]]),
      }, [holding('/instance/mods/A/A - Main.ba2', FILE), holding('/instance/mods/B/Listed.ba2', FILE)]);

      expect(copies).toEqual([archived('A', 'A - Main.ba2'), archived('B', 'Listed.ba2')]);
    });

    it('takes no copy from an archive the game does not load', async () => {
      const copies = await stackOf({
        mods: [mod('A')], modFiles: new Map([['A', filesOfMod('A', 'A.esp', 'Off.esp', 'Off - Main.ba2')]]),
      }, [holding('/instance/mods/A/Off - Main.ba2', FILE)]);

      expect(copies).toBeUndefined();
    });

    it('takes the copies of an archive from the mod whose archive of that name wins', async () => {
      const copies = await stackOf({
        mods: [mod('A'), mod('B')], archiveList: ['Listed.ba2'],
        modFiles: new Map([['A', filesOfMod('A', 'Listed.ba2')], ['B', filesOfMod('B', 'Listed.ba2')]]),
      }, [holding('/instance/mods/A/Listed.ba2', FILE), holding('/instance/mods/B/Listed.ba2', FILE)]);

      expect(copies).toEqual([archived('A', 'Listed.ba2')]);
    });
  });
});
