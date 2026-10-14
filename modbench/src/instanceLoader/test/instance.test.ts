import { describe, it, expect, afterEach, vi } from 'vitest';
import type {
  DataFolderArchives, DataFolderPlugins, DownloadedFile, DownloadedFiles, GameFolder, InstanceAdapter, InstanceReading, Mod,
  OriginFiles, Separator, SourceMods,
} from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture } from '../../test/fakeInstanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { Instance, type InstanceValue } from '../instance';
import { factsOf } from '../instanceFacts';

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
  ({ origin: name, folder: `/mods/${name}`, files: relativePaths.map((path) => fileIn(`/mods/${name}`, path)), folders: [], notes: [] });

const sourceModsOf = (folders: Record<string, string>, notes: string[] = []): SourceMods => ({
  folders: new Map(Object.entries(folders)),
  folderOf: (name) => Object.entries(folders).find(([output]) => output.toLowerCase() === name.toLowerCase())?.[1],
  notes,
});

const GAME_FOLDER: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const inDataFolder = (...names: string[]): DataFolderPlugins => ({ kind: 'listed', names: new Set(names) });
const GAME_FOUND: Partial<InstanceReading> = {
  gameFolder: GAME_FOLDER,
  dataFolderPlugins: inDataFolder(),
  dataFolderArchives: { kind: 'listed', archives: [], stringsFiles: [] } satisfies DataFolderArchives,
};

const downloadedFile = (name: string): DownloadedFile =>
  ({ name, path: `/downloads/${name}`, metaPath: `/downloads/${name}.meta`, size: 1, mtimeMs: 1, meta: undefined });
const downloads = (...names: string[]): DownloadedFiles =>
  ({ kind: 'listed', downloadsDir: '/downloads', files: names.map(downloadedFile) });

function loader(overrides: Partial<InstanceReading> = {}, wrap: (adapter: InstanceAdapter) => InstanceAdapter = (adapter) => adapter) {
  const fake = fakeInstanceAdapter(readingFixture(overrides));
  const logs: string[] = [];
  const warnings: string[] = [];
  const errorLines: string[] = [];
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
    window,
    log: { info: (msg) => logs.push(msg), warn: (msg) => warnings.push(msg), error: (line) => errorLines.push(line) },
  });
  instances.push(instance);
  return {
    instance, fake, logs, warnings, errorLines, windowListeners,
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

const settleClockLeavingSetImmediateReal = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

const listedRows = (value: InstanceValue) => (value.downloads.kind === 'listed' ? value.downloads.rows : []);

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
      gameName: 'Fallout 4', gameRelease: 'Fallout4', gameFolder: GAME_FOLDER,
    });

    await instance.refresh();

    const { value } = instance;
    expect(value.mods).toEqual(mods);
    expect(value.modFolders?.map((f) => f.name)).toEqual([NONO, 'Hand Extracted Mod']);
    expect(value.activeProfile).toBe('Secondary');
    expect(value.profiles).toEqual(['Default', 'Secondary']);
    expect([value.gameName, value.gameRelease, value.nexusSlug]).toEqual(['Fallout 4', 'Fallout4', 'fallout4']);
    expect(value.gameFolder).toEqual(GAME_FOLDER);
  });

  it('carries each mod a repository builds as tracked, with that repository as its source folder, and each repository alone as a source mod', async () => {
    const { instance, logs } = loader({
      mods: [mod('Harder VATS'), mod('[NODELETE] Radfall'), mod('Plain')],
      sourceMods: sourceModsOf(
        { 'Harder VATS': '/source/Harder VATS', '[nodelete] radfall': '/source/Renamed From', 'Cloned And Unlisted': '/source/Cloned And Unlisted' },
        ['/source/No Configuration builds no mod'],
      ),
    });

    await instance.refresh();

    expect([...instance.value.trackedMods].sort()).toEqual(['Harder VATS', '[NODELETE] Radfall']);
    expect([...instance.value.sourceMods].sort()).toEqual(['Cloned And Unlisted', 'Harder VATS', '[NODELETE] Radfall']);
    expect(instance.value.paths.sourceDirs.get('[NODELETE] Radfall')).toBe('/source/Renamed From');
    expect(instance.value.paths.sourceDirs.get('Cloned And Unlisted')).toBe('/source/Cloned And Unlisted');
    expect(logs).toContain('[instance] /source/No Configuration builds no mod');
  });

  it('carries no source folder for a mod named as a renamed repository\'s folder still is, that repository being the source of the mod its build names', async () => {
    const { instance } = loader({ mods: [mod('Harder VATS')], sourceMods: sourceModsOf({ 'Harder VATS Renamed': '/source/Harder VATS' }) });

    await instance.refresh();

    expect(instance.value.trackedMods.has('Harder VATS')).toBe(false);
    expect(instance.value.paths.sourceDirs.has('Harder VATS')).toBe(false);
    expect(instance.value.paths.sourceDirs.get('Harder VATS Renamed')).toBe('/source/Harder VATS');
  });

  it('tells once, until it changes or clears, each note of the reading', async () => {
    const note = 'no mod is built by /source/No Configuration';
    const { instance, logs, fake } = loader({ sourceMods: sourceModsOf({}, [note]) });
    const told = (): number => logs.filter((line) => line.includes(note)).length;

    await instance.refresh();
    await instance.refresh();
    expect(told()).toBe(1);

    fake.read({ sourceMods: sourceModsOf({}) });
    await instance.refresh();
    fake.read({ sourceMods: sourceModsOf({}, [note]) });
    await instance.refresh();
    expect(told()).toBe(2);
  });

  it('tells once rather than on every watched change that a link in mods/ cannot be followed, without failing the recompute', async () => {
    const { instance, logs, errorLines } = loader({ modFolders: modFoldersOf('Real Mod'), skippedLinks: new Map([['Loop', 'too many levels']]) });

    await instance.refresh();
    await instance.refresh();

    expect(errorLines).toEqual([]);
    expect(instance.sequence).toBe(2);
    expect(logs.filter((line) => line.includes('Loop'))).toEqual(['[instance] mods/Loop is a link Modbench cannot follow, so it is not a mod folder: too many levels']);
  });

  it('carries the winner of a path two enabled mods provide, and each listed mod\'s own files and folders, a disabled mod\'s too', async () => {
    const folder = { relativePath: 'textures', path: '/mods/Harder VATS/textures', excluded: false };
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
    expect(entry?.winner).toBe(`/mods/${NONO}/textures/shared.dds`);
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
      { name: 'NonAsciiRetexture.esp', path: `/mods/${NONO}/NonAsciiRetexture.esp`, origin: NONO, line: 0, enabled: true, winning: true },
      { name: 'Unofficial Fallout 4 Patch.esp', path: '/game/Data/Unofficial Fallout 4 Patch.esp', origin: 'Data/', line: 1, enabled: true, winning: true },
      { name: 'NonAsciiRetexture - Addon.esl', path: `/mods/${NONO}/NonAsciiRetexture - Addon.esl`, origin: NONO, line: null, enabled: false, winning: true },
      { name: 'Harder VATS.esp', path: '/mods/Harder VATS/Harder VATS.esp', origin: 'Harder VATS', line: null, enabled: false, winning: false },
    ]);
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

  it('recomputes once for a burst of the adapter\'s signals, a per-signal recompute landing five more', async () => {
    const { instance, fake } = loader();
    await instance.refresh();
    const before = instance.sequence;

    settleClockLeavingSetImmediateReal();
    try {
      for (let i = 0; i < 6; i++) fake.changed();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    const oneRecomputeForTheBurstAndOneForThisRefresh = 2;
    expect(instance.sequence).toBe(before + oneRecomputeForTheBurstAndOneForThisRefresh);
  });

  it('recomputes when the window regains focus, and not when it loses it, focus being the one signal no watcher can lose', async () => {
    const { instance, windowState } = loader();
    await instance.refresh();
    const before = instance.sequence;

    settleClockLeavingSetImmediateReal();
    try {
      windowState({ focused: false });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
      expect(instance.sequence).toBe(before + 1);

      windowState({ focused: true });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
      expect(instance.sequence).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recomputes nothing while the window keeps its focus', async () => {
    const { instance, windowState } = loader();
    await instance.refresh();
    const before = instance.sequence;

    settleClockLeavingSetImmediateReal();
    try {
      windowState({ focused: true });
      await vi.advanceTimersByTimeAsync(1000);
      await instance.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(instance.sequence).toBe(before + 1);
  });

  it('settles the window regaining focus with the adapter\'s signals, into one recompute, the focus restarting the settle the signal began', async () => {
    const { instance, fake, windowState } = loader();
    await instance.refresh();
    windowState({ focused: false });
    const before = instance.sequence;

    const msWhereTheSignalsOwnSettleHasRunOut = 150;
    settleClockLeavingSetImmediateReal();
    try {
      fake.changed();
      await vi.advanceTimersByTimeAsync(msWhereTheSignalsOwnSettleHasRunOut);
      windowState({ focused: true });
      await vi.advanceTimersByTimeAsync(msWhereTheSignalsOwnSettleHasRunOut);
      await instance.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(instance.sequence).toBe(before + 1);
  });

  it('a refresh mid-burst is the burst\'s recompute, not a second one', async () => {
    const { instance, fake } = loader();
    await instance.refresh();
    const before = instance.sequence;

    const msWhereAWaitLeftArmedWouldFire = 1000;
    vi.useFakeTimers();
    try {
      fake.changed();
      await instance.refresh();
      await vi.advanceTimersByTimeAsync(msWhereAWaitLeftArmedWouldFire);
    } finally {
      vi.useRealTimers();
    }
    await instance.refresh();

    expect(instance.sequence).toBe(before + 2);
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
    instance.subscribe((_value, sequence) => landed.push(sequence));

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

  it('keeps recomputing after a subscriber throws', async () => {
    const { instance, errorLines } = loader();
    const seen: number[] = [];
    instance.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    instance.subscribe((_value, sequence) => seen.push(sequence));

    await instance.refresh();
    await instance.refresh();

    expect(seen).toEqual([1, 2]);
    expect(errorLines.filter((m) => m.includes('subscriber threw'))).toHaveLength(2);
  });
});

describe('Instance — downloads', () => {
  const ARCHIVE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

  it('carries the downloaded files as rows, and the folder they are listed from', async () => {
    const { instance } = loader({ downloadedFiles: downloads(ARCHIVE) });

    await instance.refresh();

    expect(listedRows(instance.value).map((row) => row.name)).toEqual([ARCHIVE]);
    expect(instance.value.paths.downloadsDir).toBe('/downloads');
  });

  it('reads a download as Installed from the meta of a mod folder, one with no line in the mod order too, and drops it once the folder is gone', async () => {
    const { instance, fake } = loader({
      mods: [mod(PATCH)],
      downloadedFiles: downloads(ARCHIVE, 'Off-Profile-1.7z'),
      folderMeta: new Map([[PATCH, { archiveFilename: ARCHIVE }], ['Off Profile Mod', { archiveFilename: 'Off-Profile-1.7z' }]]),
    });
    await instance.refresh();
    expect(listedRows(instance.value).map((row) => [row.name, row.status])).toEqual([[ARCHIVE, 'Installed'], ['Off-Profile-1.7z', 'Installed']]);

    fake.read({ folderMeta: new Map() });
    await instance.refresh();

    expect(listedRows(instance.value).map((row) => row.status)).toEqual(['Downloaded', 'Downloaded']);
  });

  it('yields a value with no downloads, rather than a failure, when the downloads folder is absent', async () => {
    const { instance, fake } = loader({ downloadedFiles: downloads(ARCHIVE) });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files: undefined } });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.downloads).toEqual({ kind: 'listed', rows: [] });
  });

  it('lands mods and plugins when the downloads folder is unresolved, losing only the rows and the folder', async () => {
    const reason = 'download_directory names a drive letter this machine cannot translate';
    const { instance } = loader({ mods: [mod('A')], downloadedFiles: { kind: 'unresolved', reason } });

    await instance.refresh();

    expect(instance.readFailure).toBeUndefined();
    expect(instance.value.mods).toEqual([mod('A')]);
    expect(instance.value.downloads).toEqual({ kind: 'unresolved', reason });
    expect(instance.value.paths.downloadsDir).toBeUndefined();
  });
});

describe('Instance — game folder and the archives the game loads', () => {
  const SUPPLIED = '/game/Data/Fallout4 - Interface.ba2';

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

    expect(instance.value.loadOrderSnapshot).toMatchObject({ archives: [{ path: SUPPLIED }] });
    expect(warnings).toEqual([`[instance] ${note}`]);
    expect(logs).toEqual([]);
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

  it('hands a mod\'s plugin a strings file added beside it, at the next read', async () => {
    const reading: Partial<InstanceReading> = {
      ...GAME_FOUND,
      mods: [mod('Tracked Patch Mod')],
      pluginOrder: [{ name: 'Tracked Patch Mod.esp', enabled: true }],
      modFolders: modFoldersOf('Tracked Patch Mod'),
    };
    const { instance, fake } = loader({ ...reading, modFiles: new Map([['Tracked Patch Mod', filesOfMod('Tracked Patch Mod', 'Tracked Patch Mod.esp')]]) });
    await instance.refresh();

    const stringsFile = '/mods/Tracked Patch Mod/Strings/Tracked Patch Mod_en.STRINGS';
    fake.read({ modFiles: new Map([['Tracked Patch Mod', filesOfMod('Tracked Patch Mod', 'Tracked Patch Mod.esp', 'Strings/Tracked Patch Mod_en.STRINGS')]]) });
    await instance.refresh();

    expect(instance.value.loadOrderSnapshot).toMatchObject({
      plugins: expect.arrayContaining([expect.objectContaining({ origin: 'Tracked Patch Mod', stringsFiles: [expect.objectContaining({ path: stringsFile })] })]) as unknown,
    });
  });

  it('hands a mod\'s plugin the new stamp of a strings file rewritten beside it, at the next read', async () => {
    const stringsFile = '/mods/Tracked Patch Mod/Strings/Tracked Patch Mod_en.STRINGS';
    let changedNs = 1n;
    const { instance } = loader({
      ...GAME_FOUND,
      mods: [mod('Tracked Patch Mod')],
      pluginOrder: [{ name: 'Tracked Patch Mod.esp', enabled: true }],
      modFolders: modFoldersOf('Tracked Patch Mod'),
      modFiles: new Map([['Tracked Patch Mod', filesOfMod('Tracked Patch Mod', 'Tracked Patch Mod.esp', 'Strings/Tracked Patch Mod_en.STRINGS')]]),
    }, (adapter) => ({ ...adapter, fileStamp: (path) => Promise.resolve({ kind: 'read', answer: { size: 5n, modifiedNs: 1n, changedNs: path === stringsFile ? changedNs : 0n } }) }));
    await instance.refresh();
    const before = handedStringsFiles(instance.value.loadOrderSnapshot);

    changedNs = 2n;
    await instance.refresh();

    const after = handedStringsFiles(instance.value.loadOrderSnapshot);
    expect(after.map(({ path }) => path)).toEqual([stringsFile]);
    expect(before.map(({ path }) => path)).toEqual([stringsFile]);
    expect(after[0]?.stamp).not.toEqual(before[0]?.stamp);
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

  it('keeps every plugins.txt line as a row when the game folder is not found, Data-only rows line-only with no path, a mod-provided row keeping its real path', async () => {
    const { instance } = loader({
      mods: [mod(NONO)],
      pluginOrder: [{ name: 'NonAsciiRetexture.esp', enabled: true }, { name: 'Unofficial Fallout 4 Patch.esp', enabled: true }],
      modFiles: new Map([[NONO, filesOfMod(NONO, 'NonAsciiRetexture.esp')]]),
    });

    await instance.refresh();

    expect(instance.value.plugins).toEqual([
      { name: 'NonAsciiRetexture.esp', path: `/mods/${NONO}/NonAsciiRetexture.esp`, origin: NONO, line: 0, enabled: true, winning: true },
      { name: 'Unofficial Fallout 4 Patch.esp', path: undefined, origin: 'Data/', line: 1, enabled: true, winning: true },
    ]);
  });

  it('carries the paths a view renders: overwrite/, downloads/ and each listed mod\'s own folder, matched as the manager matches names, where it has one', async () => {
    const { instance } = loader({
      mods: [mod('tracked'), mod('Radfall'), separator('Section')],
      modFolders: modFoldersOf('Tracked'),
      runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [], folders: [], notes: [] },
    });

    await instance.refresh();

    const { paths } = instance.value;
    expect(paths.overwriteDir).toBe('/overwrite');
    expect(paths.downloadsDir).toBe('/downloads');
    expect(paths.modDirs).toEqual(new Map([['tracked', '/mods/Tracked']]));
  });

  it('carries a source folder for each source mod alone, one with no mod folder too, and hands it to the facts', async () => {
    const { instance } = loader({ mods: [mod('Radfall')], sourceMods: sourceModsOf({ Radfall: '/source/Radfall' }) });

    await instance.refresh();

    const { paths } = instance.value;
    expect(paths.modDirs.has('Radfall')).toBe(false);
    expect(paths.sourceDirs).toEqual(new Map([['Radfall', '/source/Radfall']]));
    expect(factsOf(instance).sourceDirs()).toBe(paths.sourceDirs);
  });

  it('names the mod manager and its mod-order file as the adapter does rather than as the value spells them, before the first read too', () => {
    const names = { manager: 'Another Manager', modOrderFile: 'order.txt', downloadMetadataFile: 'order.sidecar' };
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
    const folder = { relativePath: 'F4SE', path: '/overwrite/F4SE', excluded: false };
    const { instance, fake } = loader();
    await instance.refresh();
    expect(instance.value.overwriteFiles).toEqual([]);

    fake.read({ runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [log], folders: [folder], notes: [] } });
    await instance.refresh();

    expect(instance.value.overwriteFiles).toEqual([log]);
    expect(instance.value.overwriteFolders).toEqual([folder]);
  });
});

describe('Instance — what a command is handed instead of probing for it', () => {
  it('carries what mod sync and plugin sync are handed, read with the rest of the value', async () => {
    const { instance } = loader({
      mods: [mod('Consumer')], modFolders: modFoldersOf('Consumer'), modFiles: new Map([['Consumer', filesOfMod('Consumer', 'Mine.esp')]]),
    });

    await instance.refresh();

    const { value } = instance;
    expect(value.modSyncArguments).toEqual({ profile: 'Default', modFolders: value.modFolders });
    expect(value.pluginSyncArguments.profile).toBe('Default');
    expect(value.pluginSyncArguments.provided).toEqual(new Map([['mine.esp', 'Mine.esp']]));
    expect(value.pluginSyncArguments.inData).toBe(value.dataFolderPlugins);
  });

  it('carries mod folders unknown, rather than a failure, when there is no folder for mods at all, absent not being empty', async () => {
    const { instance, fake } = loader({ modFolders: modFoldersOf('A') });
    await instance.refresh();
    const before = instance.sequence;

    fake.read({ modFolders: undefined });
    await instance.refresh();

    expect(instance.sequence).toBe(before + 1);
    expect(instance.value.modFolders).toBeUndefined();
    expect(instance.value.modSyncArguments.modFolders).toBeUndefined();
  });

  it('tells once while it stands that the Data folder could not be listed', async () => {
    const { instance, warnings } = loader({ gameFolder: GAME_FOLDER, dataFolderPlugins: { kind: 'unreadable', reason: 'EACCES' } });

    await instance.refresh();
    await instance.refresh();

    expect(instance.value.dataFolderPlugins).toEqual({ kind: 'unreadable', reason: 'EACCES' });
    expect(warnings).toEqual(['[instance] the game\'s Data folder could not be listed: EACCES']);
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
      ['Fallout4.esm', 'DLCRobot.esm', 'ccListed.esl'].map((name) => ({ name, origin: 'Data/' })));
  });

  it('carries a game master an enabled mod provides where the game folder holds none, at its file\'s spelling, in the snapshot too', async () => {
    const { instance } = loader({
      ...GAME_FOUND, gameRelease: 'Fallout4', mods: [mod('Consumer')], modFolders: modFoldersOf('Consumer'),
      modFiles: new Map([['Consumer', filesOfMod('Consumer', 'dlccoast.esm')]]),
    });

    await instance.refresh();

    const provided = { name: 'dlccoast.esm', origin: 'Consumer' };
    expect(instance.value.pluginsLoadedWithNoLine).toEqual([provided]);
    expect(instance.value.loadOrderSnapshot).toMatchObject({ loadedWithNoLine: [provided] });
  });

  it('carries the load order snapshot put load order sends, keyed on the game folder it was derived from, each mod with its folder and a source mod with its source folder', async () => {
    const { instance } = loader({
      ...GAME_FOUND, gameRelease: 'Fallout4', mods: [mod('Consumer')], modFolders: modFoldersOf('Consumer'),
      modFiles: new Map([['Consumer', filesOfMod('Consumer', 'DLCCoast.esm')]]),
      sourceMods: sourceModsOf({ Consumer: '/source/Consumer Source' }),
    });

    await instance.refresh();

    expect(instance.value.loadOrderSnapshot).toMatchObject({
      dataFolder: '/game/Data',
      plugins: [{
        name: 'DLCCoast.esm',
        provider: { kind: 'Mod', mod: 'Consumer', folder: '/mods/Consumer', sourceFolder: '/source/Consumer Source' },
      }],
      loadedWithNoLine: [{ name: 'DLCCoast.esm', origin: 'Consumer' }],
    });
    const { loadOrderSnapshot } = instance.value;
    expect(loadOrderSnapshot && 'active' in loadOrderSnapshot ? loadOrderSnapshot.active : []).toContainEqual({ name: 'DLCCoast.esm', origin: 'Consumer' });
  });

  it('carries no answer and no snapshot while the game folder is not found', async () => {
    const { instance } = loader({ mods: [mod('Consumer')] });

    await instance.refresh();

    expect(instance.value.gameFolder.kind).toBe('notFound');
    expect(instance.value.pluginsLoadedWithNoLine).toBeUndefined();
    expect(instance.value.loadOrderSnapshot).toBeUndefined();
  });
});
