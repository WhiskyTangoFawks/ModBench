import { basename } from 'node:path';
import { textHash } from '../instanceAdapter/fileContents/contentDigest';
import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import type { NexusFileInfo } from '../ports/nexusFileInfo';
import {
  entryNotFound, filesWinningFirst, isBareName, type DecideModOrder, type DownloadedFile, type DownloadedFileQuery, type DownloadedFiles, type DecidePluginOrder, type DownloadedFileMark, type EntryRef, type FileOrigin, type FileRead, type FileStamp,  type GameFile, type GamePlace, type HashedFile, type InstallationFile, type InstallOutcome, type InstallPackage, type InstallTarget, type InstanceAdapter, type InstanceReading, type ModlistEntry, type ModOrderChange, type OriginFiles, type OriginFileMark, type OriginFileMarked, type ModFolder, type ModFolders, type ModMetadata, type NexusModFile, type OtherManifest, type UnsearchedFolder, type SourceMods, type OriginFile, type InstallKeys, type FomodAnswer, type PluginOrderChange, type PublisherTag, type PublisherTagChange, type Subscription } from '../instanceAdapter/instanceAdapter';
import { modOrderAfter, pluginOrderAfter } from './fakeOrderChanges';
import { groupModOrder } from '../instanceAdapter/modGroups';
import { parseNexusPage } from '../instanceAdapter/nexusPage';
import { pluginsProvidedOf } from '../instanceAdapter/pluginsProvided';
import { loadedWithNoLineOf } from '../tables/gamePaths';
import { overlappedGameRoot } from '../instanceAdapter/gameFolder/pathWithin';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';

function noFilesFor(mods: readonly ModlistEntry[]): ReadonlyMap<string, OriginFiles> {
  return new Map(mods.flatMap((entry) => (entry.kind === 'mod'
    ? [[entry.name, { origin: entry.name, folder: `/instance/mods/${entry.name}`, files: [], folders: [], notes: [] }] as const]
    : [])));
}

/** The source mods whose repositories write the named output folders, and the outputs that repositories build no mod name, by folder. */
export const sourceModsOf = (folders: Record<string, string>, notes: string[] = [], uncloned: readonly string[] = [], claims: Record<string, string> = {}, shared: Record<string, readonly string[]> = {}): SourceMods => {
  const folderOf = (name: string): string | undefined => Object.entries(folders).find(([output]) => output.toLowerCase() === name.toLowerCase())?.[1];
  return {
    folders: new Map(Object.entries(folders)),
    folderOf,
    builds: (name) => folderOf(name) !== undefined || uncloned.some((output) => output.toLowerCase() === name.toLowerCase()),
    claimedOutput: (folder) => Object.entries(folders).find(([, built]) => built === folder)?.[0] ?? claims[folder],
    buildersOf: (name) => Object.entries(shared).find(([output]) => output.toLowerCase() === name.toLowerCase())?.[1] ?? [],
    notes,
  };
};

/** An instance that holds no publisher's configuration. */
export const NO_PUBLISHER = { kind: 'none' } as const;

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
    programVersions: { kind: 'unresolved' },
    dataFolderPlugins: { kind: 'unresolved' },
    creationClubList: [],
    archiveList: [],
    archiveListNotes: [],
    dataFolderArchives: { kind: 'unresolved' },
    profiles: ['Default'],
    modFolders: undefined,
    gameFolderLinks: 0,
    linkNotes: [],
    runtimeOutput: { origin: 'overwrite', folder: undefined, files: [], folders: [], notes: [] },
    modFiles: noFilesFor(overrides.mods ?? []),
    folderMeta: new Map(),
    sourceMods: sourceModsOf({}),
    holdsRepository: false,
    repositorySetUp: false,
    watchNotes: [],
    managerRunning: { kind: 'notRunning' },
    publisherConfiguration: NO_PUBLISHER,
    ...overrides,
  };
}

/** The MD5 the fake gives a downloaded file. */
export const md5Of = (name: string): string => `md5-of-${name}`;

export type AdapterCall =
  | { readonly verb: 'keepPackageEntries'; readonly hash: string; readonly entries: ReadonlyMap<string, string> }
  | { readonly verb: 'changeModOrder'; readonly profile: string; readonly changes: readonly ModOrderChange[] }
  | { readonly verb: 'changePluginOrder' | 'changePluginOrderOverProvided'; readonly profile: string; readonly changes: readonly PluginOrderChange[] }
  | { readonly verb: 'markDownloadedFile'; readonly name: string; readonly mark: DownloadedFileMark }
  | { readonly verb: 'writeNexusFileInfo'; readonly name: string; readonly info: NexusFileInfo }
  | { readonly verb: 'putDownloadedFile'; readonly name: string; readonly info: NexusFileInfo }
  | { readonly verb: 'trashDownloadedFile'; readonly name: string }
  | { readonly verb: 'selectProfile'; readonly profile: string }
  | { readonly verb: 'createModFolder'; readonly mod: string }
  | { readonly verb: 'renameModFolder'; readonly from: string; readonly to: string }
  | { readonly verb: 'markOriginFile'; readonly origin: FileOrigin; readonly relativePath: string; readonly mark: OriginFileMark }
  | { readonly verb: 'moveIntoOverwrite'; readonly moves: Parameters<InstanceAdapter['moveIntoOverwrite']>[0] }
  | { readonly verb: 'renamePlugin'; readonly origin: FileOrigin; readonly from: string; readonly to: string }
  | { readonly verb: 'trashEntryFolder'; readonly entry: EntryRef }
  | { readonly verb: 'trashFileIn'; readonly folder: string; readonly relativePath: string }
  | { readonly verb: 'writeFilesIn'; readonly folder: string; readonly files: Parameters<InstanceAdapter['writeFilesIn']>[1] }
  | { readonly verb: 'trashSourceFolder'; readonly mod: string }
  | { readonly verb: 'followModFolders'; readonly moves: Parameters<InstanceAdapter['followModFolders']>[0] }
  | { readonly verb: 'changePublisherTag'; readonly change: PublisherTagChange; readonly tag: string; readonly paths: readonly string[] }
  | { readonly verb: 'writeNewestVersion'; readonly mod: string; readonly version: string }
  | { readonly verb: 'writeModMetadata'; readonly mod: string; readonly metadata: ModMetadata }
  | { readonly verb: 'writeIgnoreList' }
  | { readonly verb: 'keepOutOfPublisher' }
  | { readonly verb: 'takeBackKeepOutOfPublisher' }
  | { readonly verb: 'takeBackIgnoreList' }
  | { readonly verb: 'takeBackPushRefusal' }
  | { readonly verb: 'removeRepository' }
  | { readonly verb: 'checkPushRefusalFree' }
  | { readonly verb: 'writeSubmodules'; readonly acted: readonly string[] | 'every' }
  | { readonly verb: 'writeOtherManifestLines' }
  | { readonly verb: 'refuseUnpublishedPins' }
  | { readonly verb: 'writePathTokens' }
  | { readonly verb: 'install'; readonly package: InstallPackage; readonly target: InstallTarget; readonly keys: InstallKeys; readonly fomod?: FomodAnswer };

export type WriteVerb = AdapterCall['verb'];

/** Refuses every write of one verb with the message. */
export const refusing = (verb: WriteVerb, message: string): NonNullable<InstanceAnswers['refusals']> =>
  (call) => (call.verb === verb ? message : undefined);

/** What a test fixes of the instance beside its reading. */
export interface InstanceAnswers {
  /** An origin file's size and hash by the path it is read from; a path not there is unreadable. */
  hashes?: ReadonlyMap<string, HashedFile>;
  stamps?: ReadonlyMap<string, FileStamp>;
  /** Each folder's files by forward-slash path; a folder not there holds none. */
  folderFiles?: ReadonlyMap<string, readonly string[]>;
  /** Each downloaded file's entries by its hash; a hash not there has none in the index. */
  packageEntries?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Why the entries of a game folder package cannot be written to the hash index. */
  packageEntriesNotWritten?: string;
  /** What the installation of each mod answers, by mod name; a mod not there records none. */
  installations?: ReadonlyMap<string, FileRead<InstallationFile | undefined>>;
  /** What each downloaded file answers, by name; a name not there is not in the downloads folder. */
  downloadedFiles?: ReadonlyMap<string, FileRead<InstallationFile>>;
  /** The downloaded files, those the hash index holds and those it lacks, and why any could not be read; none when not said. */
  downloadedFilesHashed?: { readonly files: readonly InstallationFile[]; readonly lacking?: readonly InstallationFile[]; readonly notes: readonly string[] };
  /** Why each downloaded file cannot be queried, by name. */
  unreadableQueries?: ReadonlyMap<string, string>;
  /** What each downloaded file's query holds beyond its MD5 and the game, by name. */
  queries?: ReadonlyMap<string, Partial<DownloadedFileQuery>>;
  /** What the game files a mod's files take answer, by mod name; a mod not there takes none. */
  gameFilesTaken?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['gameFilesTakenBy']>>>;
  /** The game files the game folder holds, by their lower-cased path; a path not there has none. */
  gameFiles?: ReadonlyMap<string, GameFile>;
  unreadableGameFiles?: ReadonlyMap<string, string>;
  /** The places of the game, the game folder first, each holding the three answers above of its own; the game folder alone, holding them, when not said. */
  places?: readonly (GamePlace & Pick<InstanceAnswers, 'gameFiles' | 'unreadableGameFiles' | 'gameFilesTaken'>)[];
  /** Why each mod's metadata cannot be read, by mod name. */
  unreadableMetadata?: ReadonlyMap<string, string>;
  /** Why each mod's metadata cannot hold the metadata a manifest says, by mod name. */
  unwritableMetadata?: ReadonlyMap<string, string>;
  /** What each mod's metadata says, by mod name; a mod not there says none. */
  metadata?: ReadonlyMap<string, ModMetadata>;
  /** Where each mod is on Nexus, by mod name; a mod not there has no Nexus mod ID. */
  nexusFiles?: ReadonlyMap<string, FileRead<NexusModFile>>;
  /** The mods the mod manager shows an update for once a newest version is written. */
  updatable?: ReadonlySet<string>;
  /** The publisher tags the instance's publisher declares. */
  publisherTags?: readonly PublisherTag[];
  /** Why the publisher's configuration cannot be read. */
  unreadablePublisher?: string;
  /** Paths the publisher refuses as outside the instance. */
  outsideInstance?: ReadonlySet<string>;
  /** Mods whose name gives them no source folder. */
  unsourcedMods?: ReadonlySet<string>;
  /** The reads beside `reading()` that reject, with the message each rejects with. */
  unreadReads?: Partial<Record<'profiles' | 'modOrder' | 'downloadedFiles' | 'sourceMods' | 'pathsOutsideFolders' | 'otherManifests', string>>;
  installed?: InstallOutcome;
  /** Whether the instance folder holds a repository on disk now, whatever its reading said. */
  repositoryOnDisk?: boolean;
  /** Why a path token stays in the working tree once path tokens are written. */
  pathTokenLeft?: string;
  /** Each path no path token names in a file the instance repository holds. */
  pathsOutsideFolders?: Awaited<ReturnType<InstanceAdapter['pathsOutsideFolders']>>;
  /** Each folder outside the mod folders that holds its manifest. */
  otherManifests?: readonly OtherManifest[];
  /** Each folder the search for other manifests could not read. */
  unsearched?: readonly UnsearchedFolder[];
  /** What writing the submodules says. */
  submodules?: Awaited<ReturnType<InstanceAdapter['writeSubmodules']>>;
  /** The host of each source folder, by its path; a folder not there has no remote. */
  hosts?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['sourceHost']>>>;
  /** What the instance repository holds of each submodule, by name. */
  pins?: ReadonlyMap<string, Awaited<ReturnType<InstanceAdapter['submodule']>>>;
  /** Each submodule the source folder holds no repository for. */
  uncloned?: Awaited<ReturnType<InstanceAdapter['unclonedSubmodules']>>;
  /** The reason a trashed downloaded file's metadata is left behind. */
  metadataLeftBehind?: string;
  /** A write that rejects with the message this returns for it, after it is recorded. */
  refusals?: (call: AdapterCall) => string | undefined;
  /** The reason reading a file of an origin fails, or `undefined` when it reads. */
  unreadOriginFile?: (file: { readonly origin: FileOrigin; readonly relativePath: string }) => string | undefined;
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

const EXCLUSION_MARK = '.mohidden';

const entryKey = (entry: EntryRef): string => (entry.kind === 'separator' ? `${entry.name}_separator` : entry.name).toLowerCase();

/** The folders of the given entries, a bare name being a mod, held as the fake's `entryKey` folds names. */
export function modFoldersOf(...entries: readonly (string | (EntryRef & { modName?: string }))[]): ModFolders {
  return modFoldersIn('/instance/mods', ...entries);
}

/** As `modFoldersOf`, each folder in `mods`. */
export function modFoldersIn(mods: string, ...entries: readonly (string | (EntryRef & { modName?: string }))[]): ModFolders {
  return foldersHolding(entries.map((entry) => {
    const ref = typeof entry === 'string' ? { kind: 'mod' as const, name: entry } : entry;
    return { kind: ref.kind, name: ref.name, path: `${mods}/${ref.name}`, modName: ref.modName ?? ref.name };
  }));
}

const foldersHolding = (all: readonly ModFolder[]): ModFolders =>
  ({ all, holding: (entry) => all.find((folder) => entryKey(folder) === entryKey(entry)) });

function folderBeside(folders: ModFolders | undefined, name: string): string {
  const held = folders?.all[0]?.path ?? '/instance/mods/';
  return `${held.slice(0, Math.max(held.lastIndexOf('/'), held.lastIndexOf('\\')))}/${name}`;
}

const reachesOut = (relativePath: string): boolean => relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));

const notAFileOf = (origin: FileOrigin, relativePath: string): Error =>
  new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${relativePath}"`);

const inTheWay = (path: string): Error => new Error(`The folder "${path}" is in the way`);

const isMarked = (name: string): boolean => name.toLowerCase().endsWith(EXCLUSION_MARK);

export function fileIn(folder: string, relativePath: string): OriginFile {
  const segments = relativePath.split('/');
  const includedPath = segments.map((segment) => (isMarked(segment) ? segment.slice(0, -EXCLUSION_MARK.length) : segment)).join('/');
  return {
    relativePath, path: `${folder}/${relativePath}`, sourcePath: `${folder}/${relativePath}`,
    excluded: segments.some(isMarked), markedExcluded: isMarked(relativePath), includedPath,
  };
}

/** The origins' files at their roots, each plugin held by the origin it is given with. */
export function pluginFilesHeld(...held: readonly { readonly origin: FileOrigin; readonly name: string }[]): Pick<InstanceReading, 'modFiles' | 'runtimeOutput'> {
  const originsFiles = (origin: string, folder: string, names: readonly string[]): OriginFiles =>
    ({ origin, folder, files: names.map((name) => fileIn(folder, name)), folders: [], notes: [] });
  const sameOrigin = (a: FileOrigin, b: FileOrigin): boolean => (a.kind === 'mod' && b.kind === 'mod' ? a.name === b.name : a.kind === b.kind);
  const namesIn = (wanted: FileOrigin): string[] => held.filter((one) => sameOrigin(one.origin, wanted)).map((one) => one.name);
  const mods = [...new Set(held.flatMap((one) => (one.origin.kind === 'mod' ? [one.origin.name] : [])))];
  return {
    modFiles: new Map(mods.map((name) => [name, originsFiles(name, `/instance/mods/${name}`, namesIn({ kind: 'mod', name }))])),
    runtimeOutput: originsFiles('overwrite', '/overwrite', namesIn({ kind: 'runtimeOutput' })),
  };
}

/** The downloads folder listing these names, each with no metadata. */
export const downloadedFilesOf = (...names: readonly string[]): DownloadedFiles => ({
  kind: 'listed',
  downloadsDir: '/downloads',
  files: names.map((name) => ({ name, path: `/downloads/${name}`, metadataPath: `/downloads/${name}.meta`, size: 1, mtimeMs: 1, excluded: false, meta: undefined })),
});

/** The Instance adapter's second implementation: reads answer from the reading and the answers,
 *  each write is recorded, and a decision a caller hands over runs against the reading. */
export function fakeInstanceAdapter(reading: InstanceReading = readingFixture(), answers: InstanceAnswers = {}): FakeInstanceAdapter {
  let current = reading;
  let calls: AdapterCall[] = [];
  const hashed: string[] = [];
  const putHashedAsTheirText = new Map<string, FileRead<InstallationFile>>();
  const listeners = new Set<() => void>();
  let readings = 0;
  let readingFailure: string | undefined;

  const write = <T>(call: AdapterCall, run: () => T): Promise<T> => {
    calls.push(call);
    const refusal = answers.refusals?.(call);
    if (refusal !== undefined) return Promise.reject(new Error(refusal));
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const record = <T>(call: AdapterCall, result: T): Promise<T> => write(call, () => result);
  const reorderPlugins = (call: AdapterCall, changes: readonly PluginOrderChange[]): Promise<{ wrote: boolean }> =>
    write(call, () => {
      const order = pluginOrderAfter(current.pluginOrder, changes);
      const wrote = JSON.stringify(order) !== JSON.stringify(current.pluginOrder);
      current = { ...current, pluginOrder: order };
      return { wrote };
    });
  const foldersNow = (): ModFolders => current.modFolders ?? foldersHolding([]);
  const originFilesOf = (origin: FileOrigin): OriginFiles | undefined => (origin.kind === 'mod' ? current.modFiles.get(origin.name) : current.runtimeOutput);
  const downloadedFileNamed = (name: string): DownloadedFile | undefined => {
    if (current.downloadedFiles.kind === 'unresolved') throw new Error(current.downloadedFiles.reason);
    return current.downloadedFiles.files?.find((file) => file.name === name);
  };
  const withOriginFiles = (origin: FileOrigin, next: OriginFiles): void => {
    current = origin.kind === 'mod' ? { ...current, modFiles: new Map(current.modFiles).set(origin.name, next) } : { ...current, runtimeOutput: next };
  };
  const rootFileOf = (origin: FileOrigin, name: string): OriginFile | undefined =>
    originFilesOf(origin)?.files.find((file) => !file.relativePath.includes('/') && pluginKey(file.relativePath) === pluginKey(name));
  const unreadable = <T>(read: keyof NonNullable<InstanceAnswers['unreadReads']>, found: T): Promise<T> => {
    const why = answers.unreadReads?.[read];
    return why === undefined ? Promise.resolve(found) : Promise.reject(new Error(why));
  };
  const answer = <T>(found: T | undefined, path: string): Promise<FileRead<T>> =>
    Promise.resolve(found === undefined ? { kind: 'unreadable', reason: `no answer fixed for ${path}` } : { kind: 'read', answer: found });

  const placeAnswers = (root: string): Pick<InstanceAnswers, 'gameFiles' | 'unreadableGameFiles' | 'gameFilesTaken'> =>
    answers.places === undefined ? answers : answers.places.find((place) => place.root === root) ?? {};

  const adapter: InstanceAdapter = {
    reading: () => {
      readings++;
      return readingFailure === undefined ? Promise.resolve(current) : Promise.reject(new Error(readingFailure));
    },
    activeProfile: () => Promise.resolve(current.profile),
    gameRelease: () => Promise.resolve(current.gameRelease),
    gameFolder: () => Promise.resolve(current.gameFolder),
    gameFolderOverlapping: (folder) => overlappedGameRoot(current.gameFolder, folder),
    gamePlaces: () => Promise.resolve(answers.places ?? (current.gameFolder.kind === 'found' ? [{ root: current.gameFolder.root, holdsDataFiles: true, depots: [], depotProblems: [] }] : [])),
    nonSteamPrefix: () => Promise.resolve({ why: 'no Steam' }),
    profiles: () => unreadable('profiles', current.profiles),
    modOrder: () => unreadable('modOrder', { mods: current.mods, modFolders: current.modFolders?.all }),
    downloadedFiles: () => unreadable('downloadedFiles', current.downloadedFiles),
    downloadedFileAt: async (path) => {
      const listed = await unreadable('downloadedFiles', current.downloadedFiles);
      if (listed.kind === 'unresolved') return { kind: 'unreadable', reason: listed.reason };
      return { kind: 'read', answer: listed.files?.find((file) => file.path === path) };
    },
    sourceMods: () => unreadable('sourceMods', current.sourceMods),
    names: { manager: 'Fake manager', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' },
    publisherTags: answers.publisherTags ?? [],
    changePublisherTag: (change, tag, paths) =>
      write({ verb: 'changePublisherTag', change, tag, paths }, () => paths.flatMap((path) => (answers.outsideInstance?.has(path) ? [{ path, reason: 'It is outside the instance.' }] : []))),
    publisherConfigurationRefusal: () => Promise.resolve(answers.unreadablePublisher),
    followModFolders: (moves) => (answers.publisherTags === undefined ? Promise.resolve() : write({ verb: 'followModFolders', moves }, () => undefined)),
    modFolderPath: (mod) => Promise.resolve(isBareName(mod) ? foldersNow().holding({ kind: 'mod', name: mod })?.path ?? folderBeside(current.modFolders, mod) : undefined),
    foldersRefused: () => Promise.resolve([]),
    sourceFolder: (mod) => (answers.unsourcedMods?.has(mod) ? undefined : `/source/${mod}`),
    installationFile: (mod) => Promise.resolve(answers.installations?.get(mod) ?? { kind: 'read', answer: undefined }),
    downloadedFile: (name) => Promise.resolve(answers.downloadedFiles?.get(name) ?? putHashedAsTheirText.get(name) ?? { kind: 'read', answer: undefined }),
    downloadedFilesHashed: ({ onHashing, signal } = {}) => {
      const { files, lacking = [], notes } = answers.downloadedFilesHashed ?? { files: [], notes: [] };
      const hashed: InstallationFile[] = [];
      for (const [done, file] of lacking.entries()) {
        if (signal?.aborted) break;
        onHashing?.(lacking.length - done);
        hashed.push(file);
      }
      return Promise.resolve({ files: [...files, ...hashed], notes });
    },
    nexusFileAt: parseNexusPage,
    downloadedFileQuery: (name) => {
      const reason = answers.unreadableQueries?.get(name);
      if (reason !== undefined) return Promise.resolve({ kind: 'unreadable', reason });
      return Promise.resolve({ kind: 'read', answer: downloadedFileNamed(name) === undefined ? undefined : { games: ['fallout4'], md5: md5Of(name), ...answers.queries?.get(name) } });
    },
    gameFiles: ({ root }, paths) => {
      const held = placeAnswers(root);
      return Promise.resolve({
        files: paths.flatMap((path) => held.gameFiles?.get(path.toLowerCase()) ?? []),
        unreadable: Object.fromEntries(paths.flatMap((path) => {
          const reason = held.unreadableGameFiles?.get(path.toLowerCase());
          return reason === undefined ? [] : [[path, reason]];
        })),
      });
    },
    gameFilesTakenBy: ({ root }, folder) => Promise.resolve(placeAnswers(root).gameFilesTaken?.get(basename(folder)) ?? { kind: 'read', answer: { gameFiles: [], notes: [] } }),
    modMetadata: (mod) => {
      const reason = answers.unreadableMetadata?.get(mod);
      return Promise.resolve(reason === undefined ? { kind: 'read', answer: answers.metadata?.get(mod) ?? {} } : { kind: 'unreadable', reason });
    },
    nexusFile: (mod) => Promise.resolve(answers.nexusFiles?.get(mod) ?? { kind: 'read', answer: undefined }),
    writeNewestVersion: (mod, version) => record({ verb: 'writeNewestVersion', mod, version }, { updateAvailable: answers.updatable?.has(mod) === true }),
    metadataOf: ({ version, installationFileName }) =>
      Promise.resolve({ version, installationFile: installationFileName === undefined ? undefined : { name: installationFileName } }),
    unwritableMetadata: (mod) => Promise.resolve(answers.unwritableMetadata?.get(mod)),
    writeModMetadata: (mod, metadata) => record({ verb: 'writeModMetadata', mod, metadata }, undefined),
    metadataFilesInModFolder: ['meta.ini'],
    statCacheFolder: '/instance/stat-cache',
    scriptEnvironmentFile: { path: () => '/instance/.env', read: () => Promise.resolve(''), write: () => Promise.resolve() },
    keepOutOfPublisher: () => record({ verb: 'keepOutOfPublisher' }, () => record({ verb: 'takeBackKeepOutOfPublisher' }, undefined)),
    writeIgnoreList: () => record({ verb: 'writeIgnoreList' }, () => record({ verb: 'takeBackIgnoreList' }, undefined)),
    repositoryOnDisk: () => Promise.resolve(answers.repositoryOnDisk ?? false),
    sourceHost: (folder) => Promise.resolve(answers.hosts?.get(folder) ?? { kind: 'read', answer: { kind: 'noRemote' } }),
    submodule: (name) => Promise.resolve(answers.pins?.get(name) ?? { lacks: `no answer fixed for ${name}` }),
    unclonedSubmodules: () => Promise.resolve(answers.uncloned ?? []),
    removeRepository: () => record({ verb: 'removeRepository' }, undefined),
    checkPushRefusalFree: () => record({ verb: 'checkPushRefusalFree' }, undefined),
    writeSubmodules: (acted) => record({ verb: 'writeSubmodules', acted }, answers.submodules ?? { notes: [], other: [] }),
    otherManifests: () => unreadable('otherManifests', { manifests: answers.otherManifests ?? [], unsearched: answers.unsearched ?? [], nested: [] }),
    writeOtherManifestLines: () => record({ verb: 'writeOtherManifestLines' }, undefined),
    refuseUnpublishedPins: () => record({ verb: 'refuseUnpublishedPins' }, () => record({ verb: 'takeBackPushRefusal' }, undefined)),
    writePathTokens: () => record({ verb: 'writePathTokens' }, answers.pathTokenLeft),
    pathsOutsideFolders: () => unreadable('pathsOutsideFolders', answers.pathsOutsideFolders ?? []),
    fileStamp: (path) => answer(answers.stamps?.get(path), path),
    originFileHash: (path) => {
      hashed.push(path);
      return answer(answers.hashes?.get(path), path);
    },
    filesIn: (folder) => Promise.resolve(answers.folderFiles?.get(folder) ?? []),
    packageEntries: (hash) => Promise.resolve(answers.packageEntries?.get(hash)),
    keepPackageEntries: (hash, entries) => record({ verb: 'keepPackageEntries', hash, entries }, answers.packageEntriesNotWritten),
    textHash,
    changeModOrder: (profile, decide: DecideModOrder) => {
      const changes = decide(current.mods, current.modFolders);
      return write({ verb: 'changeModOrder', profile, changes }, () => {
        const { order, landed } = modOrderAfter(current.mods, changes);
        const wrote = JSON.stringify(order) !== JSON.stringify(current.mods);
        current = { ...current, mods: order, modGroups: groupModOrder(order) };
        return { wrote, landed };
      });
    },
    changePluginOrder: (profile, decide: DecidePluginOrder) => {
      const changes = decide(current.pluginOrder);
      return reorderPlugins({ verb: 'changePluginOrder', profile, changes }, changes);
    },
    changePluginOrderOverProvided: (profile, decide) => {
      const changes = decide(current.pluginOrder, pluginsProvidedOf(
        filesWinningFirst(current.mods, current.runtimeOutput.files, (mod) => current.modFiles.get(mod)?.files ?? []),
        current.dataFolderPlugins, loadedWithNoLineOf(current.gameRelease, current.creationClubList),
      ));
      return reorderPlugins({ verb: 'changePluginOrderOverProvided', profile, changes }, changes);
    },
    markDownloadedFile: (name, mark) =>
      write({ verb: 'markDownloadedFile', name, mark }, () => {
        const held = downloadedFileNamed(name);
        if (held === undefined) return { gone: true } as const;
        const excluded = mark === 'Excluded';
        if (current.downloadedFiles.kind === 'listed' && held.excluded !== excluded) {
          current = { ...current, downloadedFiles: { ...current.downloadedFiles, files: current.downloadedFiles.files?.map((file) => (file === held ? { ...file, excluded } : file)) } };
        }
        return { gone: false, wrote: held.excluded !== excluded } as const;
      }),
    putDownloadedFile: async (name, bytes, { hash, info }) => {
      await write({ verb: 'putDownloadedFile', name, info }, () => {
        if (answers.downloadedFiles?.has(name) || putHashedAsTheirText.has(name)) throw new Error(`'${name}' is already in the downloads folder`);
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of bytes) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      if (text !== hash) return { put: false };
      putHashedAsTheirText.set(name, { kind: 'read', answer: { path: `/downloads/${name}`, size: text.length, hash, entries: [] } });
      return { put: true };
    },
    writeNexusFileInfo: (name, info) =>
      write({ verb: 'writeNexusFileInfo', name, info }, () => (downloadedFileNamed(name) === undefined ? { gone: true } as const : { gone: false, wrote: true } as const)),
    trashDownloadedFile: (name) =>
      write({ verb: 'trashDownloadedFile', name }, () => {
        if (downloadedFileNamed(name) === undefined) return { gone: true } as const;
        if (current.downloadedFiles.kind === 'listed') {
          current = { ...current, downloadedFiles: { ...current.downloadedFiles, files: current.downloadedFiles.files?.filter((file) => file.name !== name) } };
        }
        return { gone: false, ...(answers.metadataLeftBehind === undefined ? {} : { metadataLeftBehind: answers.metadataLeftBehind }) } as const;
      }),
    selectProfile: (profile) =>
      write({ verb: 'selectProfile', profile }, () => {
        const wrote = profile !== current.profile;
        current = { ...current, profile };
        return { wrote };
      }),
    createModFolder: (mod) =>
      write({ verb: 'createModFolder', mod }, () => {
        if (!isBareName(mod)) throw new Error(`Not a valid mod name: "${mod}"`);
        const held = foldersNow().holding({ kind: 'mod', name: mod });
        if (held !== undefined) throw inTheWay(held.path);
        current = { ...current, modFolders: foldersHolding([...foldersNow().all, { kind: 'mod', name: mod, path: folderBeside(current.modFolders, mod), modName: mod }]) };
      }),
    renameModFolder: (from, to) =>
      write({ verb: 'renameModFolder', from, to }, () => {
        const held = foldersNow().holding({ kind: 'mod', name: from });
        if (held === undefined) throw new Error(entryNotFound({ kind: 'mod', name: from }));
        const taken = foldersNow().holding({ kind: 'mod', name: to });
        if (taken !== undefined && taken !== held) throw inTheWay(taken.path);
        current = { ...current, modFolders: foldersHolding(foldersNow().all.map((folder) => (folder === held ? { ...folder, name: to, path: folderBeside(current.modFolders, to), modName: to } : folder))) };
      }),
    originFile: (origin, relativePath) => {
      if (reachesOut(relativePath)) return Promise.reject(notAFileOf(origin, relativePath));
      const unread = answers.unreadOriginFile?.({ origin, relativePath });
      if (unread !== undefined) return Promise.reject(new Error(unread));
      return Promise.resolve(originFilesOf(origin)?.files.find((file) => file.relativePath === relativePath));
    },
    markOriginFile: (origin, relativePath, mark) =>
      write<OriginFileMarked>({ verb: 'markOriginFile', origin, relativePath, mark }, () => {
        if (reachesOut(relativePath)) throw notAFileOf(origin, relativePath);
        const held = originFilesOf(origin);
        const there = [...held?.files ?? [], ...held?.folders ?? []].some((one) => one.relativePath === relativePath);
        if (held === undefined || !there) return { gone: true };
        const ownMark = isMarked(relativePath);
        if (mark === 'Included' && !ownMark && relativePath.split('/').slice(0, -1).some(isMarked)) {
          return { gone: false, refusal: `"${relativePath}" has no suffix of its own to remove, and its folder excludes it.` };
        }
        if (ownMark === (mark === 'Excluded')) return { gone: false, wrote: false, relativePath };
        const target = mark === 'Excluded' ? relativePath + EXCLUSION_MARK : relativePath.slice(0, -EXCLUSION_MARK.length);
        if ([...held.files, ...held.folders].some((one) => one.relativePath === target)) return { gone: false, refusal: `"${target}" is already there.` };
        const renamedPath = (path: string): string => (path === relativePath || path.startsWith(`${relativePath}/`)
          ? target + path.slice(relativePath.length)
          : path);
        const folder = held.folder ?? '';
        withOriginFiles(origin, {
          ...held,
          files: held.files.map((file) => fileIn(folder, renamedPath(file.relativePath))),
          folders: held.folders.map((one) => ({ ...one, relativePath: renamedPath(one.relativePath), path: `${folder}/${renamedPath(one.relativePath)}`, excluded: renamedPath(one.relativePath).split('/').some(isMarked) })),
        });
        return { gone: false, wrote: true, relativePath: renamedPath(relativePath) };
      }),
    moveIntoOverwrite: (moves) => write<string | undefined>({ verb: 'moveIntoOverwrite', moves }, () => undefined),
    entryKey,
    exclusionMark: EXCLUSION_MARK,
    originHoldsPlugin: (origin, name) => Promise.resolve(rootFileOf(origin, name) !== undefined),
    renamePlugin: (origin, from, to) =>
      write({ verb: 'renamePlugin', origin, from, to }, () => {
        const sameAsFrom = (name: string): boolean => pluginKey(name) === pluginKey(from);
        const other = current.pluginOrder.find((plugin) => pluginKey(plugin.name) === pluginKey(to) && !sameAsFrom(plugin.name));
        if (other !== undefined && current.pluginOrder.some((plugin) => sameAsFrom(plugin.name))) throw new Error(`Plugin already in plugins.txt: ${other.name}`);
        const own = rootFileOf(origin, from);
        if (own === undefined) throw new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${from}"`);
        const taken = rootFileOf(origin, to);
        if (taken !== undefined && taken !== own) throw new Error(`The file "${taken.path}" is in the way`);
        const files = originFilesOf(origin);
        if (files !== undefined) withOriginFiles(origin, { ...files, files: files.files.map((file) => (file === own ? fileIn(files.folder ?? '', to) : file)) });
        current = { ...current, pluginOrder: current.pluginOrder.map((plugin) => (sameAsFrom(plugin.name) ? { ...plugin, name: to } : plugin)) };
      }),
    trashEntryFolder: async (entry, trash) => {
      const held = await write({ verb: 'trashEntryFolder', entry }, () => foldersNow().holding(entry));
      if (held === undefined) return false;
      await trash(held.path);
      current = { ...current, modFolders: foldersHolding(foldersNow().all.filter((folder) => folder !== held)) };
      return true;
    },
    trashFileIn: (folder, relativePath) =>
      write({ verb: 'trashFileIn', folder, relativePath }, () => {
        if (reachesOut(relativePath)) throw new Error(`Not a file of "${folder}": "${relativePath}"`);
      }),
    writeFilesIn: (folder, files) =>
      write({ verb: 'writeFilesIn', folder, files }, () => {
        const outside = files.find(({ path }) => reachesOut(path));
        if (outside !== undefined) throw new Error(`Not a file of "${folder}": "${outside.path}"`);
      }),
    trashSourceFolder: async (mod, trash) => {
      const source = await write({ verb: 'trashSourceFolder', mod }, () => current.sourceMods.folderOf(mod));
      if (source === undefined) return false;
      await trash(source);
      return true;
    },
    install: (installed, target, keys, fomod) =>
      record<InstallOutcome>({ verb: 'install', package: installed, target, keys, ...(fomod && { fomod }) }, answers.installed ?? { landed: true }),
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
