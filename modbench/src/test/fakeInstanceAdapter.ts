import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import type {
  DecideModOrder, DecidePluginOrder, DownloadedFileMark, EntryRef, FileOrigin, FileRead, FileStamp, GameFile, HashedFile, InstallationFile,
  InstallOutcome, InstallPackage, InstallTarget, InstanceAdapter, InstanceReading, ModlistEntry, ModOrderChange, OriginFiles, OriginFileMark, OriginFileMarked,
  ModFolder, ModFolders, ModMetadata, SourceMods, OriginFile, InstallKeys, PluginOrderChange, Subscription } from '../instanceAdapter/instanceAdapter';
import { groupModOrder } from '../instanceAdapter/modGroups';
import { filesWinningFirst, pluginsProvidedOf } from '../instanceAdapter/pluginsProvided';
import { loadedWithNoLineOf } from '../tables/gamePaths';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';

function noFilesFor(mods: readonly ModlistEntry[]): ReadonlyMap<string, OriginFiles> {
  return new Map(mods.flatMap((entry) => (entry.kind === 'mod'
    ? [[entry.name, { origin: entry.name, folder: `/mods/${entry.name}`, files: [], folders: [], notes: [] }] as const]
    : [])));
}

/** The source mods whose repositories write the named output folders. */
export const sourceModsOf = (folders: Record<string, string>, notes: string[] = []): SourceMods => ({
  folders: new Map(Object.entries(folders)),
  folderOf: (name) => Object.entries(folders).find(([output]) => output.toLowerCase() === name.toLowerCase())?.[1],
  notes,
});

export function readingFixture(overrides: Partial<InstanceReading> = {}): InstanceReading {
  return {
    profile: 'Default',
    gameName: 'Fallout 4',
    gameRelease: 'Fallout4',
    mods: [],
    modGroups: groupModOrder(overrides.mods ?? []),
    pluginOrder: [],
    orderNotes: [],
    downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files: [] },
    gameFolder: GAME_FOLDER_NOT_FOUND,
    dataFolderPlugins: { kind: 'unresolved' },
    creationClubList: [],
    archiveList: [],
    archiveListNotes: [],
    dataFolderArchives: { kind: 'unresolved' },
    profiles: ['Default'],
    modFolders: undefined,
    skippedLinks: new Map(),
    runtimeOutput: { origin: 'overwrite', folder: undefined, files: [], folders: [], notes: [] },
    modFiles: noFilesFor(overrides.mods ?? []),
    folderMeta: new Map(),
    sourceMods: { folders: new Map(), folderOf: () => undefined, notes: [] },
    holdsRepository: false,
    watchNotes: [],
    managerRunning: { kind: 'notRunning' },
    ...overrides,
  };
}

export type AdapterCall =
  | { readonly verb: 'changeModOrder'; readonly profile: string; readonly changes: readonly ModOrderChange[] }
  | { readonly verb: 'changePluginOrder' | 'changePluginOrderOverProvided'; readonly profile: string; readonly changes: readonly PluginOrderChange[] }
  | { readonly verb: 'markDownloadedFile'; readonly name: string; readonly mark: DownloadedFileMark }
  | { readonly verb: 'trashDownloadedFile'; readonly name: string }
  | { readonly verb: 'selectProfile'; readonly profile: string }
  | { readonly verb: 'createModFolder'; readonly mod: string }
  | { readonly verb: 'renameModFolder'; readonly from: string; readonly to: string }
  | { readonly verb: 'markOriginFile'; readonly origin: FileOrigin; readonly relativePath: string; readonly mark: OriginFileMark }
  | { readonly verb: 'renamePlugin'; readonly origin: FileOrigin; readonly from: string; readonly to: string }
  | { readonly verb: 'trashEntryFolder'; readonly entry: EntryRef }
  | { readonly verb: 'trashModFile'; readonly mod: string; readonly relativePath: string }
  | { readonly verb: 'trashSourceFolder'; readonly mod: string }
  | { readonly verb: 'writeModMetadata'; readonly mod: string; readonly metadata: ModMetadata }
  | { readonly verb: 'writeIgnoreList' }
  | { readonly verb: 'removeIgnoreList' }
  | { readonly verb: 'removeRepository' }
  | { readonly verb: 'checkPushRefusalFree' }
  | { readonly verb: 'writeSubmodules' }
  | { readonly verb: 'refuseUnpublishedPins' }
  | { readonly verb: 'install'; readonly package: InstallPackage; readonly target: InstallTarget; readonly keys: InstallKeys };

export type WriteVerb = AdapterCall['verb'];

/** Refuses every write of one verb with the message. */
export const refusing = (verb: WriteVerb, message: string): NonNullable<InstanceAnswers['refusals']> =>
  (call) => (call.verb === verb ? message : undefined);

/** What a test fixes of the instance beside its reading. */
export interface InstanceAnswers {
  /** An origin file's size and hash by the path it is read from; a path not there is unreadable. */
  hashes?: ReadonlyMap<string, HashedFile>;
  stamps?: ReadonlyMap<string, FileStamp>;
  /** What the installation of each mod answers, by mod name; a mod not there records none. */
  installations?: ReadonlyMap<string, FileRead<InstallationFile | undefined>>;
  /** What each downloaded file answers, by name; a name not there is not in the downloads folder. */
  downloads?: ReadonlyMap<string, FileRead<InstallationFile>>;
  /** What the game files a mod's files take answer, by mod name; a mod not there takes none. */
  gameFilesTaken?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['gameFilesTakenBy']>>>;
  /** The game files the game folder holds, by their lower-cased path; a path not there has none. */
  gameFiles?: ReadonlyMap<string, GameFile>;
  /** Why each mod's metadata cannot be read, by mod name. */
  unreadableMetadata?: ReadonlyMap<string, string>;
  /** Why each mod's metadata cannot hold the metadata a manifest says, by mod name. */
  unwritableMetadata?: ReadonlyMap<string, string>;
  /** What each mod's metadata says, by mod name; a mod not there says none. */
  metadata?: ReadonlyMap<string, ModMetadata>;
  /** Mods whose name gives them no source folder. */
  unsourcedMods?: ReadonlySet<string>;
  /** The reads beside `reading()` that reject, with the message each rejects with. */
  unreadReads?: Partial<Record<'profiles' | 'modOrder' | 'downloadedFiles' | 'sourceMods', string>>;
  installed?: InstallOutcome;
  /** Whether the instance folder holds a repository on disk now, whatever its reading said. */
  repositoryOnDisk?: boolean;
  /** What writing the submodules says. */
  submodules?: Awaited<ReturnType<InstanceAdapter['writeSubmodules']>>;
  /** The host of each source folder, by its path; a folder not there has no remote. */
  hosts?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['sourceHost']>>>;
  /** What the instance repository holds of each submodule, by name. */
  pins?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['submodule']>>>;
  /** Downloaded files that are gone: they get no mark. */
  goneDownloads?: ReadonlySet<string>;
  /** The reason a trashed downloaded file's metadata is left behind. */
  metadataLeftBehind?: string;
  /** A write that rejects with the message this returns for it, after it is recorded. */
  refusals?: (call: AdapterCall) => string | undefined;
  /** Origin files that are gone: they get no mark. */
  goneOriginFiles?: readonly { readonly origin: FileOrigin; readonly relativePath: string }[];
  heldPlugins?: readonly { readonly origin: FileOrigin; readonly name: string }[];
  /** Entries with no folder to trash, by name. */
  foldersAbsent?: ReadonlySet<string>;
}

export interface FakeInstanceAdapter {
  readonly adapter: InstanceAdapter;
  readonly calls: readonly AdapterCall[];
  forgetCalls(): void;
  readonly hashed: string[];
  /** Every `reading()` after this answers the reading with these fields replaced. */
  read(next: Partial<InstanceReading>): void;
  changed(): void;
  /** Every `reading()` after this rejects with the message, until it is called with `undefined`. */
  failReading(message: string | undefined): void;
  readonly readings: number;
  readonly subscribers: number;
}

const EXCLUDED_SUFFIX = '.excluded';

const entryKey = (entry: EntryRef): string => (entry.kind === 'separator' ? `${entry.name}_separator` : entry.name).toLowerCase();
const originKey = (origin: FileOrigin): string => (origin.kind === 'mod' ? `mod:${origin.name}` : origin.kind);

/** The folders of the given entries, a bare name being a mod, held as the fake's `entryKey` folds names. */
export function modFoldersOf(...entries: readonly (string | (EntryRef & { modName?: string }))[]): ModFolders {
  const all: ModFolder[] = entries.map((entry) => {
    const ref = typeof entry === 'string' ? { kind: 'mod' as const, name: entry } : entry;
    return { kind: ref.kind, name: ref.name, path: `/mods/${ref.name}`, modName: ref.modName ?? ref.name };
  });
  return { all, holding: (entry) => all.find((folder) => entryKey(folder) === entryKey(entry)) };
}

export const fileIn = (folder: string, relativePath: string): OriginFile =>
  ({ relativePath, path: `${folder}/${relativePath}`, sourcePath: `${folder}/${relativePath}`, excluded: false, excludedByName: false });

/** The Instance adapter's second implementation: reads answer from the reading and the answers,
 *  each write is recorded, and a decision a caller hands over runs against the reading. */
export function fakeInstanceAdapter(reading: InstanceReading = readingFixture(), answers: InstanceAnswers = {}): FakeInstanceAdapter {
  let current = reading;
  let calls: AdapterCall[] = [];
  const hashed: string[] = [];
  const listeners = new Set<() => void>();
  let readings = 0;
  let readingFailure: string | undefined;

  const record = <T>(call: AdapterCall, result: T): Promise<T> => {
    calls.push(call);
    const refusal = answers.refusals?.(call);
    return refusal === undefined ? Promise.resolve(result) : Promise.reject(new Error(refusal));
  };
  const unreadable = <T>(read: keyof NonNullable<InstanceAnswers['unreadReads']>, found: T): Promise<T> => {
    const why = answers.unreadReads?.[read];
    return why === undefined ? Promise.resolve(found) : Promise.reject(new Error(why));
  };
  const answer = <T>(found: T | undefined, path: string): Promise<FileRead<T>> =>
    Promise.resolve(found === undefined ? { kind: 'unreadable', reason: `no answer fixed for ${path}` } : { kind: 'read', answer: found });

  const adapter: InstanceAdapter = {
    reading: () => {
      readings++;
      return readingFailure === undefined ? Promise.resolve(current) : Promise.reject(new Error(readingFailure));
    },
    activeProfile: () => Promise.resolve(current.profile),
    gameRelease: () => Promise.resolve(current.gameRelease),
    profiles: () => unreadable('profiles', current.profiles),
    modOrder: () => unreadable('modOrder', { mods: current.mods, modFolders: current.modFolders?.all }),
    downloadedFiles: () => unreadable('downloadedFiles', current.downloadedFiles),
    sourceMods: () => unreadable('sourceMods', current.sourceMods),
    names: { manager: 'Fake manager', modOrderFile: 'modlist.txt', downloadMetadataFile: '.meta' },
    modFolderPath: (mod) => Promise.resolve(answers.foldersAbsent?.has(mod) ? undefined : `/mods/${mod}`),
    sourceFolder: (mod) => (answers.unsourcedMods?.has(mod) ? undefined : `/source/${mod}`),
    installationFile: (mod) => Promise.resolve(answers.installations?.get(mod) ?? { kind: 'read', answer: undefined }),
    downloadedFile: (name) => Promise.resolve(answers.downloads?.get(name) ?? { kind: 'read', answer: undefined }),
    gameFiles: (_dataFolder, paths) => Promise.resolve({
      kind: 'read', answer: paths.flatMap((path) => answers.gameFiles?.get(path.toLowerCase()) ?? []),
    }),
    gameFilesTakenBy: (_dataFolder, mod) => Promise.resolve(answers.gameFilesTaken?.get(mod) ?? { kind: 'read', answer: { gameFiles: [], notes: [] } }),
    modMetadata: (mod) => {
      const reason = answers.unreadableMetadata?.get(mod);
      return Promise.resolve(reason === undefined ? { kind: 'read', answer: answers.metadata?.get(mod) ?? {} } : { kind: 'unreadable', reason });
    },
    metadataOf: ({ version, archiveFilename }) =>
      Promise.resolve({ version, installationFile: archiveFilename === undefined ? undefined : { name: archiveFilename } }),
    unwritableMetadata: (mod) => Promise.resolve(answers.unwritableMetadata?.get(mod)),
    writeModMetadata: (mod, metadata) => record({ verb: 'writeModMetadata', mod, metadata }, undefined),
    metadataFilesInModFolder: ['meta.ini'],
    statCacheFolder: '/instance/stat-cache',
    writeIgnoreList: () => record({ verb: 'writeIgnoreList' }, undefined),
    removeIgnoreList: () => record({ verb: 'removeIgnoreList' }, undefined),
    repositoryOnDisk: () => Promise.resolve(answers.repositoryOnDisk ?? false),
    sourceHost: (folder) => Promise.resolve(answers.hosts?.get(folder) ?? { kind: 'read', answer: { kind: 'noRemote' } }),
    submodule: (name) => Promise.resolve(answers.pins?.get(name) ?? { lacks: `no answer fixed for ${name}` }),
    removeRepository: () => record({ verb: 'removeRepository' }, undefined),
    checkPushRefusalFree: () => record({ verb: 'checkPushRefusalFree' }, undefined),
    writeSubmodules: () => record({ verb: 'writeSubmodules' }, answers.submodules ?? { notes: [], other: [] }),
    refuseUnpublishedPins: () => record({ verb: 'refuseUnpublishedPins' }, undefined),
    fileStamp: (path) => answer(answers.stamps?.get(path), path),
    originFileHash: (path) => {
      hashed.push(path);
      return answer(answers.hashes?.get(path), path);
    },
    changeModOrder: (profile, decide: DecideModOrder) => {
      const changes = decide(current.mods, current.modFolders);
      return record({ verb: 'changeModOrder', profile, changes }, { wrote: changes.length > 0, landed: changes });
    },
    changePluginOrder: (profile, decide: DecidePluginOrder) => {
      const changes = decide(current.pluginOrder);
      return record({ verb: 'changePluginOrder', profile, changes }, { wrote: changes.length > 0 });
    },
    changePluginOrderOverProvided: (profile, decide) => {
      const changes = decide(current.pluginOrder, pluginsProvidedOf(
        filesWinningFirst(current.mods, current.runtimeOutput.files, (mod) => current.modFiles.get(mod)?.files ?? []),
        current.dataFolderPlugins, loadedWithNoLineOf(current.gameRelease, current.creationClubList),
      ));
      return record({ verb: 'changePluginOrderOverProvided', profile, changes }, { wrote: changes.length > 0 });
    },
    markDownloadedFile: (name, mark) =>
      record({ verb: 'markDownloadedFile', name, mark }, answers.goneDownloads?.has(name) ? { gone: true } as const : { gone: false, wrote: true } as const),
    trashDownloadedFile: (name) =>
      record({ verb: 'trashDownloadedFile', name },
        answers.goneDownloads?.has(name) ? { gone: true } as const : { gone: false, ...(answers.metadataLeftBehind === undefined ? {} : { metadataLeftBehind: answers.metadataLeftBehind }) } as const),
    selectProfile: (profile) => record({ verb: 'selectProfile', profile }, { wrote: profile !== current.profile }),
    createModFolder: (mod) => record({ verb: 'createModFolder', mod }, undefined),
    renameModFolder: (from, to) => record({ verb: 'renameModFolder', from, to }, undefined),
    markOriginFile: (origin, relativePath, mark) =>
      record<OriginFileMarked>({ verb: 'markOriginFile', origin, relativePath, mark },
        answers.goneOriginFiles?.some((gone) => originKey(gone.origin) === originKey(origin) && gone.relativePath === relativePath) ? { gone: true } : { gone: false, wrote: true, relativePath }),
    entryKey,
    includedPath: (relativePath) => relativePath.split('/').map((segment) => segment.replace(EXCLUDED_SUFFIX, '')).join('/'),
    excludedSuffix: EXCLUDED_SUFFIX,
    originHoldsPlugin: (origin, name) => Promise.resolve((answers.heldPlugins ?? []).some((held) =>
      originKey(held.origin) === originKey(origin) && pluginKey(held.name) === pluginKey(name))),
    renamePlugin: (origin, from, to) => record({ verb: 'renamePlugin', origin, from, to }, undefined),
    trashEntryFolder: (entry) => record({ verb: 'trashEntryFolder', entry }, !answers.foldersAbsent?.has(entry.name)),
    trashModFile: (mod, relativePath) => record({ verb: 'trashModFile', mod, relativePath }, undefined),
    trashSourceFolder: (mod) => record({ verb: 'trashSourceFolder', mod }, true),
    install: (installed, target, keys) =>
      record<InstallOutcome>({ verb: 'install', package: installed, target, keys }, answers.installed ?? { landed: true, isFomod: false }),
    subscribe: (listener): Subscription => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };

  return {
    adapter, hashed,
    get calls() { return calls; },
    forgetCalls: () => { calls = []; },
    read: (next) => { current = { ...current, ...(next.mods !== undefined && next.modFiles === undefined ? { modFiles: noFilesFor(next.mods) } : {}), ...(next.mods !== undefined && next.modGroups === undefined ? { modGroups: groupModOrder(next.mods) } : {}), ...next }; },
    changed: () => { for (const listener of [...listeners]) listener(); },
    failReading: (message) => { readingFailure = message; },
    get readings() { return readings; },
    get subscribers() { return listeners.size; },
  };
}
