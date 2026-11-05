import type { PluginFlags } from '../repositoriesLib/statusValues';
import { basename, join } from 'node:path';
import { isManifestPath } from '../repositoriesLib/manifestPath';
import { textHash } from '../instanceAdapter/fileContents/contentDigest';
import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import type { NexusFileInfo } from '../ports/nexusFileInfo';
import {
  CHECK_THE_DISK, entryNotFound, filesWinningFirst, type ChangeListener, type Reread, isBareName, type DecideModOrder, type DownloadedFile, type DownloadedFileQuery, type DownloadedFiles, type DecidePluginOrder, type DownloadedFileMark, type EntryRef, type FileOrigin, type FileRead, type FileStamp,  type GameFile, type GamePlace, type HashedFile, type InstallationFile, type InstallOutcome, type InstalledPackage, type InstallPackage, type InstallTarget, type InstanceAdapter, type InstanceReading, type ModlistEntry, type ModOrderChange, type OriginFiles, type OriginFileMark, type OriginFileMarked, type ModFolder, type ModFolders, type ModMetadata, type NexusModFile, type OtherManifest, type UnsearchedFolder, type OriginFile, type FomodAnswer, type PluginOrderChange, type PublisherTag, type PublisherTagChange, type Subscription } from '../instanceAdapter/instanceAdapter';
import { modOrderAfter, pluginOrderAfter } from './fakeOrderChanges';
import { groupModOrder } from '../instanceAdapter/modGroups';
import { parseNexusPage } from '../instanceAdapter/nexusPage';
import { pluginsProvidedOf } from '../instanceAdapter/pluginsProvided';
import { loadedWithNoLineOf } from '../tables/gamePaths';
import { ownPathOf, pathInFolderOf } from '../instanceAdapter/excludedPaths';
import { folderValueOver, modValueOver, unheldFolderValueOver } from '../instanceAdapter/modValue';
import { overlappedGameRoot } from '../instanceAdapter/gameFolder/pathWithin';
import { addLoadAfter, type LoadAfter } from '../sortingRules/lootMetadata';
import { READ_SORTING_RULE_FILES } from './readSortingRuleFiles';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';

function noFilesFor(mods: readonly ModlistEntry[]): ReadonlyMap<string, OriginFiles> {
  return new Map(mods.flatMap((entry) => (entry.kind === 'mod'
    ? [[entry.name, { origin: entry.name, folder: `/instance/mods/${entry.name}`, files: [], folders: [], notes: [] }] as const]
    : [])));
}

/** Each repository in the source folder, its folder by its name. A mod folder that holds no manifest is built by the
 *  repository of its name. */
export const repositoriesOf = (repositories: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(repositories));

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
    sortingRuleFiles: READ_SORTING_RULE_FILES,
    archiveList: [],
    archiveListNotes: [],
    dataFolderArchives: { kind: 'unresolved' },
    dataFolderFiles: { kind: 'unresolved' },
    profiles: ['Default'],
    modFolders: undefined,
    gameFolderLinks: 0,
    linkNotes: [],
    runtimeOutput: { origin: 'overwrite', folder: undefined, files: [], folders: [], notes: [] },
    modFiles: noFilesFor(overrides.mods ?? []),
    folderMeta: new Map(),
    sourceModFolders: new Map(),
    holdsRepository: false,
    repositorySetUp: false,
    watchNotes: [],
    unheardChanges: [],
    managerRunning: { kind: 'notRunning' },
    publisherConfiguration: NO_PUBLISHER,
    ...overrides,
  };
}

/** The MD5 the fake gives a downloaded file. */
export const md5Of = (name: string): string => `md5-of-${name}`;

export type AdapterCall =
  | { readonly verb: 'keepFlaggedHash'; readonly hash: string; readonly flags: PluginFlags; readonly flaggedHash: string }
  | { readonly verb: 'changeModOrder'; readonly profile: string; readonly changes: readonly ModOrderChange[] }
  | { readonly verb: 'changePluginOrder' | 'changePluginOrderOverProvided'; readonly profile: string; readonly changes: readonly PluginOrderChange[] }
  | { readonly verb: 'markDownloadedFile'; readonly name: string; readonly mark: DownloadedFileMark }
  | { readonly verb: 'writeNexusFileInfo'; readonly name: string; readonly info: NexusFileInfo }
  | { readonly verb: 'putDownloadedFile'; readonly name: string; readonly info: NexusFileInfo }
  | { readonly verb: 'copyDownloadedFile'; readonly from: string; readonly name: string }
  | { readonly verb: 'trashDownloadedFile'; readonly name: string }
  | { readonly verb: 'selectProfile'; readonly profile: string }
  | { readonly verb: 'changeUserlist'; readonly additions: readonly LoadAfter[] }
  | { readonly verb: 'changeMasterlist'; readonly masterlist: string; readonly prelude: string }
  | { readonly verb: 'createModFolder'; readonly mod: string }
  | { readonly verb: 'renameModFolder'; readonly from: string; readonly to: string }
  | { readonly verb: 'markOriginFile'; readonly origin: FileOrigin; readonly relativePath: string; readonly mark: OriginFileMark }
  | { readonly verb: 'moveIntoOverwrite'; readonly moves: Parameters<InstanceAdapter['moveIntoOverwrite']>[0] }
  | { readonly verb: 'renamePlugin'; readonly origin: FileOrigin; readonly from: string; readonly to: string }
  | { readonly verb: 'trashEntryFolder'; readonly entry: EntryRef }
  | { readonly verb: 'trashFileIn'; readonly folder: string; readonly relativePath: string }
  | { readonly verb: 'writeFilesIn'; readonly folder: string; readonly files: Parameters<InstanceAdapter['writeFilesIn']>[1] }
  | { readonly verb: 'followModFolders'; readonly moves: Parameters<InstanceAdapter['followModFolders']>[0] }
  | { readonly verb: 'changePublisherTag'; readonly change: PublisherTagChange; readonly tag: string; readonly paths: readonly string[] }
  | { readonly verb: 'writeNewestVersion'; readonly mod: string; readonly version: string }
  | { readonly verb: 'writeModMetadata'; readonly mod: string; readonly metadata: ModMetadata }
  | { readonly verb: 'writeIgnoreList' }
  | { readonly verb: 'takeBackIgnoreList' }
  | { readonly verb: 'takeBackPushRefusal' }
  | { readonly verb: 'removeRepository' }
  | { readonly verb: 'checkPushRefusalFree' }
  | { readonly verb: 'writeSubmodules'; readonly acted: readonly string[] | 'every' }
  | { readonly verb: 'writeOtherManifestLines' }
  | { readonly verb: 'writeSourceModLines'; readonly letIn: readonly string[] }
  | { readonly verb: 'writeHeldWholeLines'; readonly modFolders: readonly string[]; readonly held: boolean }
  | { readonly verb: 'commitFolder'; readonly folder: string; readonly message: string }
  | { readonly verb: 'refuseUnpublishedPins' }
  | { readonly verb: 'writePathTokens' }
  | { readonly verb: 'install'; readonly package: InstallPackage; readonly target: InstallTarget; readonly fomod?: FomodAnswer }
  | { readonly verb: 'writeInstalledFrom'; readonly folder: string; readonly packages: readonly InstalledPackage[] };

export type WriteVerb = AdapterCall['verb'];

/** Refuses every write of one verb with the message. */
export const refusing = (verb: WriteVerb, message: string): NonNullable<InstanceAnswers['refusals']> =>
  (call) => (call.verb === verb ? message : undefined);

/** The key of `InstanceAnswers.flaggedHashes`: the package copy's hash and the flags. */
export const flaggedKey = (hash: string, flags: PluginFlags): string => JSON.stringify([hash, Object.entries(flags).sort(([a], [b]) => (a < b ? -1 : 1))]);

/** What a test fixes of the instance beside its reading. */
export interface InstanceAnswers {
  /** The hash of a plugin once restore set the flags in its package copy, by the copy's hash and `flaggedKey`. */
  flaggedHashes?: ReadonlyMap<string, string>;
  /** An origin file's size and hash by the path it is read from; a path not there is unreadable. */
  hashes?: ReadonlyMap<string, HashedFile>;
  stamps?: ReadonlyMap<string, FileStamp>;
  /** What a file reads as, by the path it is read from: the mod order's winner, else its path in the Data folder. */
  dataFiles?: ReadonlyMap<string, { checksum?: number; version?: string; readable?: boolean }>;
  /** Each folder's files by forward-slash path; a folder not there holds none. */
  folderFiles?: ReadonlyMap<string, readonly string[]>;
  /** The files git holds in a folder, by the folder. */
  heldByGit?: ReadonlyMap<string, readonly string[]>;
  /** The mod folders whose whole git holds. */
  heldWholeByGit?: ReadonlySet<string>;
  /** The mod folders git still leaves out after the ignore list lets them in, such as by .git/info/exclude. */
  leftOutByGit?: ReadonlySet<string>;
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
  /** Each mod's source folder, by mod name, where it is not `/source/<mod>`. */
  sourceFolders?: ReadonlyMap<string, string>;
  /** Folders the instance repository cannot hold a file in. */
  outOfReach?: ReadonlySet<string>;
  /** The reads beside `reading()` that reject, with the message each rejects with. */
  unreadReads?: Partial<Record<'profiles' | 'modOrder' | 'downloadedFiles' | 'sourceModFolders' | 'otherManifests', string>>;
  installed?: InstallOutcome;
  /** Whether the instance folder holds a repository on disk now, whatever its reading said. */
  repositoryOnDisk?: boolean;
  /** Why a path token stays in the working tree once path tokens are written. */
  pathTokenLeft?: string;
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
  /** The masterlist and prelude files git holds uncommitted changes of. */
  uncommittedMasterlist?: readonly string[];
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
  /** Signals a change to `path`, or one with no path. */
  changed(path?: string): void;
  /** Every `reading()` after this rejects with the message, until it is called with `undefined`. */
  failReading(message: string | undefined): void;
  readonly readings: number;
  /** What each `reading()` was handed, in order. */
  readonly rereads: readonly Reread[];
  readonly subscribers: number;
}

const EXCLUSION_MARK = '.mohidden';

const entryKey = (entry: EntryRef): string => (entry.kind === 'separator' ? `${entry.name}_separator` : entry.name).toLowerCase();

type FolderEntry = string | (EntryRef & { modName?: string });

const foldersAt = (pathOf: (name: string) => string, entries: readonly FolderEntry[]): ModFolders =>
  foldersHolding(entries.map((entry) => {
    const ref = typeof entry === 'string' ? { kind: 'mod' as const, name: entry } : entry;
    return { kind: ref.kind, name: ref.name, path: pathOf(ref.name), modName: ref.modName ?? ref.name };
  }));

/** The folders of the given entries, a bare name being a mod, held as the fake's `entryKey` folds names. */
export function modFoldersOf(...entries: readonly FolderEntry[]): ModFolders {
  return foldersAt((name) => `/instance/mods/${name}`, entries);
}

/** As `modFoldersOf`, each folder in `mods` on disk, joined by the platform's separator as the adapter joins it. */
export function modFoldersIn(mods: string, ...entries: readonly FolderEntry[]): ModFolders {
  return foldersAt((name) => join(mods, name), entries);
}

const foldersHolding = (all: readonly ModFolder[]): ModFolders =>
  ({ all, holding: (entry) => all.find((folder) => entryKey(folder) === entryKey(entry)) });

function folderBeside(folders: ModFolders | undefined, name: string): string {
  const held = folders?.all[0]?.path ?? '/instance/mods/';
  return `${held.slice(0, Math.max(held.lastIndexOf('/'), held.lastIndexOf('\\')) + 1)}${name}`;
}

const reachesOut = (relativePath: string): boolean => relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));

const notAFileOf = (origin: FileOrigin, relativePath: string): Error =>
  new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${relativePath}"`);

const inTheWay = (path: string): Error => new Error(`The folder "${path}" is in the way`);

const isMarked = (name: string): boolean => name.toLowerCase().endsWith(EXCLUSION_MARK);

const unmarked = (relativePath: string): string =>
  relativePath.split('/').map((segment) => (isMarked(segment) ? segment.slice(0, -EXCLUSION_MARK.length) : segment)).join('/');

export function fileIn(folder: string, relativePath: string): OriginFile {
  const segments = relativePath.split('/');
  const includedPath = unmarked(relativePath);
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
  const flaggedHashes = new Map(answers.flaggedHashes);
  const letInByLines = new Set<string>();
  const putHashedAsTheirText = new Map<string, FileRead<InstallationFile>>();
  const listeners = new Set<ChangeListener>();
  const rereads: Reread[] = [];
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
    reading: (reread = CHECK_THE_DISK) => {
      readings++;
      rereads.push(reread);
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
    sourceModFolders: () => unreadable('sourceModFolders', current.sourceModFolders),
    names: { manager: 'Fake manager', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' },
    publisherTags: answers.publisherTags ?? [],
    changePublisherTag: (change, tag, paths) =>
      write({ verb: 'changePublisherTag', change, tag, paths }, () => paths.flatMap((path) => (answers.outsideInstance?.has(path) ? [{ path, reason: 'It is outside the instance.' }] : []))),
    publisherConfigurationRefusal: () => Promise.resolve(answers.unreadablePublisher),
    followModFolders: (moves) => (answers.publisherTags === undefined ? Promise.resolve() : write({ verb: 'followModFolders', moves }, () => undefined)),
    modFolderPath: (mod) => Promise.resolve(isBareName(mod) ? foldersNow().holding({ kind: 'mod', name: mod })?.path ?? folderBeside(current.modFolders, mod) : undefined),
    foldersRefused: () => Promise.resolve([]),
    sourceFolder: (mod) => (answers.unsourcedMods?.has(mod) ? undefined : answers.sourceFolders?.get(mod) ?? `/source/${mod}`),
    installationFile: (mod) => Promise.resolve(answers.installations?.get(mod) ?? { kind: 'read', answer: undefined }),
    downloadedFile: (name) => Promise.resolve(answers.downloadedFiles?.get(name) ?? putHashedAsTheirText.get(name) ?? { kind: 'read', answer: undefined }),
    downloadedFileHolding: ({ size, hash }) => Promise.resolve({
      file: [...(answers.downloadedFiles?.values() ?? []), ...putHashedAsTheirText.values()].flatMap((read) => (read.kind === 'read' ? [read.answer] : []))
        .find((file) => file.size === size && file.hash === hash),
      notes: [],
    }),
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
    nexusGames: () => Promise.resolve(['fallout4']),
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
    gameFilesTakenBy: ({ root }, folder, paths) => {
      const taken = placeAnswers(root).gameFilesTaken?.get(basename(folder)) ?? { kind: 'read', answer: { gameFiles: [], notes: [] } };
      const asked = paths === undefined ? undefined : new Set(paths.map((path) => path.toLowerCase()));
      return Promise.resolve(taken.kind === 'read' && asked !== undefined
        ? { kind: 'read', answer: { ...taken.answer, gameFiles: taken.answer.gameFiles.filter(({ pathInFolder }) => asked.has(pathInFolder.toLowerCase())) } }
        : taken);
    },
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
    scriptEnvironmentFile: { path: () => '/instance/.env', read: () => Promise.resolve(''), write: () => Promise.resolve() },
    writeIgnoreList: () => record({ verb: 'writeIgnoreList' }, () => record({ verb: 'takeBackIgnoreList' }, undefined)),
    repositoryOnDisk: () => Promise.resolve(answers.repositoryOnDisk ?? false),
    sourceFolderTracked: () => Promise.resolve(false),
    sourceHost: (folder) => Promise.resolve(answers.hosts?.get(folder) ?? { kind: 'read', answer: { kind: 'noRemote' } }),
    submodule: (name) => Promise.resolve(answers.pins?.get(name) ?? { lacks: `no answer fixed for ${name}` }),
    unclonedSubmodules: () => Promise.resolve(answers.uncloned ?? []),
    removeRepository: () => record({ verb: 'removeRepository' }, undefined),
    checkPushRefusalFree: () => record({ verb: 'checkPushRefusalFree' }, undefined),
    writeSubmodules: (acted) => record({ verb: 'writeSubmodules', acted }, answers.submodules ?? { notes: [], other: [], written: [] }),
    otherManifests: () => unreadable('otherManifests', { manifests: answers.otherManifests ?? [], unsearched: answers.unsearched ?? [], nested: [] }),
    writeOtherManifestLines: () => record({ verb: 'writeOtherManifestLines' }, undefined),
    writeSourceModLines: (letIn = []) => record({ verb: 'writeSourceModLines', letIn }, undefined),
    writeHeldWholeLines: (modFolders, held) => write({ verb: 'writeHeldWholeLines', modFolders, held }, () => {
      for (const folder of modFolders) {
        if (held) letInByLines.add(folder);
        else letInByLines.delete(folder);
      }
    }),
    commitFolder: (folder, message) => record({ verb: 'commitFolder', folder, message }, undefined),
    refuseUnpublishedPins: () => record({ verb: 'refuseUnpublishedPins' }, () => record({ verb: 'takeBackPushRefusal' }, undefined)),
    writePathTokens: () => record({ verb: 'writePathTokens' }, answers.pathTokenLeft),
    fileStamp: (path) => answer(answers.stamps?.get(path), path),
    flaggedHash: (hash, flags) => Promise.resolve(flaggedHashes.get(flaggedKey(hash, flags))),
    keepFlaggedHash: (hash, flags, flaggedHash) => write({ verb: 'keepFlaggedHash', hash, flags, flaggedHash }, () => { flaggedHashes.set(flaggedKey(hash, flags), flaggedHash); }),
    originFileHash: (path) => {
      hashed.push(path);
      return answer(answers.hashes?.get(path), path);
    },
    filesIn: (folder) => Promise.resolve((answers.folderFiles?.get(folder) ?? []).filter((path) => !isManifestPath(path))),
    folderValue: (folder) => folderValueOver(adapter, folder),
    foldersHeldWhole: (folders) => Promise.resolve(new Set(
      folders.filter((folder) => answers.heldWholeByGit?.has(folder) === true || (letInByLines.has(folder) && answers.leftOutByGit?.has(folder) !== true)),
    )),
    foldersInReach: (folders) => Promise.resolve(folders.filter((folder) => answers.outOfReach?.has(folder) !== true)),
    filesHeldByGit: (folders) => Promise.resolve(new Map(folders.map((folder) => [folder, answers.heldByGit?.get(folder) ?? []]))),
    unheldFolderValue: (folder) => unheldFolderValueOver(adapter, answers.heldByGit?.get(folder) ?? [], folder),
    modValue: (folder, asked, heldByGit) => modValueOver(adapter, folder, asked, heldByGit),
    textHash,
    dataFileChecksum: (path, winner) => Promise.resolve({ kind: 'read', value: answers.dataFiles?.get(winner ?? path)?.checksum }),
    dataFileVersion: (path, winner) => Promise.resolve({ kind: 'read', value: answers.dataFiles?.get(winner ?? path)?.version }),
    dataFileReadable: (path, winner) => Promise.resolve({ kind: 'read', value: answers.dataFiles?.get(winner ?? path)?.readable === true }),
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
      if (hash !== undefined && text !== hash) return { put: false };
      putHashedAsTheirText.set(name, { kind: 'read', answer: { path: `/downloads/${name}`, size: text.length, hash: hash ?? text, entries: [] } });
      return { put: true };
    },
    copyDownloadedFile: (from, name) =>
      write({ verb: 'copyDownloadedFile', from, name }, () => {
        if (answers.downloadedFiles?.has(name) || putHashedAsTheirText.has(name)) throw new Error(`'${name}' is already in the downloads folder`);
        const source = [...(answers.downloadedFiles?.values() ?? []), ...putHashedAsTheirText.values()].flatMap((read) => (read.kind === 'read' ? [read.answer] : [])).find((file) => file.path === from);
        if (source === undefined) throw new Error(`${from} is not a downloaded file`);
        putHashedAsTheirText.set(name, { kind: 'read', answer: { ...source, path: `/downloads/${name}` } });
      }),
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
    changeUserlist: (additions) =>
      write({ verb: 'changeUserlist', additions }, () => {
        const { userlist } = current.sortingRuleFiles;
        if (userlist.kind === 'unreadable') throw new Error(userlist.reason);
        const before = userlist.kind === 'text' ? userlist.text : '';
        const after = addLoadAfter(before, additions);
        if (after === before) return { wrote: false };
        current = { ...current, sortingRuleFiles: { ...current.sortingRuleFiles, userlist: { path: userlist.path, kind: 'text', text: after } } };
        return { wrote: true };
      }),
    changeMasterlist: ({ masterlist, prelude }) =>
      write({ verb: 'changeMasterlist', masterlist, prelude }, () => {
        const files = current.sortingRuleFiles;
        const held = (file: typeof files.masterlist) => (file.kind === 'text' ? file.text : undefined);
        if (held(files.masterlist) === masterlist && held(files.prelude) === prelude) return { wrote: false };
        current = {
          ...current,
          sortingRuleFiles: {
            ...files,
            masterlist: { path: files.masterlist.path, kind: 'text', text: masterlist },
            prelude: { path: files.prelude.path, kind: 'text', text: prelude },
          },
        };
        return { wrote: true };
      }),
    uncommittedMasterlist: () => Promise.resolve(answers.uncommittedMasterlist ?? []),
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
          folders: held.folders.map((one) => ({ ...one, relativePath: renamedPath(one.relativePath), path: `${folder}/${renamedPath(one.relativePath)}`, includedPath: unmarked(renamedPath(one.relativePath)), excluded: renamedPath(one.relativePath).split('/').some(isMarked) })),
        });
        return { gone: false, wrote: true, relativePath: renamedPath(relativePath) };
      }),
    moveIntoOverwrite: (moves) => write<string | undefined>({ verb: 'moveIntoOverwrite', moves }, () => undefined),
    entryKey,
    exclusionMark: EXCLUSION_MARK,
    pathInFolder: (path, exclude) => pathInFolderOf(path, exclude, EXCLUSION_MARK),
    ownPath: (pathInFolder) => ownPathOf(pathInFolder, EXCLUSION_MARK).path,
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
        if (reachesOut(relativePath)) throw new Error(`Not a file or folder of "${folder}": "${relativePath}"`);
        return undefined;
      }),
    writeFilesIn: (folder, files) =>
      write({ verb: 'writeFilesIn', folder, files }, () => {
        const outside = files.find(({ path }) => reachesOut(path));
        if (outside !== undefined) throw new Error(`Not a file of "${folder}": "${outside.path}"`);
      }),
    trashingReplaced: async (_folder, _paths, _trash, run) => ({ answer: await run() }),
    install: (installed, target, _trash, fomod) =>
      record<InstallOutcome>({ verb: 'install', package: installed, target, ...(fomod && { fomod }) }, answers.installed ?? { landed: true }),
    writeInstalledFrom: (folder, packages) => write({ verb: 'writeInstalledFrom', folder, packages }, () => undefined),
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
    changed: (path) => { for (const listener of [...listeners]) listener(path); },
    failReading: (message) => { readingFailure = message; },
    get readings() { return readings; },
    rereads,
    get subscribers() { return listeners.size; },
  };
}
