import type {
  DecideModOrder, DecidePluginOrder, DownloadedFileMark, EntryRef, FileOrigin, FileRead, FileStamp, HashedFile, InstallationFile,
  InstallOutcome, InstallSource, InstallTarget, InstanceAdapter, InstanceReading, ModOrderChange, OriginFileMark, OriginFileMarked,
  OwnedMetaKeys, PluginOrderChange, Subscription,
} from '../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';

/** An `InstanceReading` of an empty instance, every field overridable. */
export function readingFixture(overrides: Partial<InstanceReading> = {}): InstanceReading {
  return {
    profile: 'Default',
    gameName: 'Fallout 4',
    gameRelease: 'Fallout4',
    mods: [],
    pluginOrder: [],
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
    modFiles: new Map(),
    folderMeta: new Map(),
    sourceMods: { folders: new Map(), folderOf: () => undefined, notes: [] },
    ...overrides,
  };
}

/** A write the adapter was handed, with the arguments the caller chose. A change a caller decides
 *  is recorded as decided against the reading as it stood. */
export type AdapterCall =
  | { readonly verb: 'changeModOrder'; readonly profile: string; readonly changes: readonly ModOrderChange[] }
  | { readonly verb: 'changePluginOrder'; readonly profile: string; readonly changes: readonly PluginOrderChange[] }
  | { readonly verb: 'markDownloadedFile'; readonly name: string; readonly mark: DownloadedFileMark }
  | { readonly verb: 'trashDownloadedFileMeta'; readonly name: string }
  | { readonly verb: 'selectProfile'; readonly profile: string }
  | { readonly verb: 'createModFolder'; readonly mod: string }
  | { readonly verb: 'renameModFolder'; readonly from: string; readonly to: string }
  | { readonly verb: 'markOriginFile'; readonly origin: FileOrigin; readonly relativePath: string; readonly mark: OriginFileMark }
  | { readonly verb: 'renamePlugin'; readonly origin: FileOrigin; readonly from: string; readonly to: string; readonly gameRelease: string | undefined }
  | { readonly verb: 'trashEntryFolder'; readonly entry: EntryRef }
  | { readonly verb: 'trashSourceFolder'; readonly mod: string }
  | { readonly verb: 'install'; readonly source: InstallSource; readonly target: InstallTarget; readonly keys: OwnedMetaKeys };

export type WriteVerb = AdapterCall['verb'];

/** What a test fixes of the instance beside its reading. */
export interface InstanceAnswers {
  /** An origin file's size and hash by the path it is read from; a path not there is unreadable. */
  hashes?: ReadonlyMap<string, HashedFile>;
  stamps?: ReadonlyMap<string, FileStamp>;
  /** The downloaded files a mod's installation records, by mod name. */
  installationFiles?: ReadonlyMap<string, readonly InstallationFile[]>;
  /** Mods whose installation files cannot be answered, by mod name, with why. */
  unreadableInstallations?: ReadonlyMap<string, string>;
  /** Mods whose name gives them no source folder. */
  unsourcedMods?: ReadonlySet<string>;
  /** The folder a build of each mod writes, by mod name; a mod not there has `/mods/<name>`. */
  modFolderPaths?: ReadonlyMap<string, string>;
  installed?: InstallOutcome;
  /** Downloaded files that are gone: they get no mark. */
  goneDownloads?: ReadonlySet<string>;
  /** A write verb that rejects with this message, after it is recorded. */
  refusals?: Partial<Record<WriteVerb, string>>;
}

export interface FakeInstanceAdapter {
  readonly adapter: InstanceAdapter;
  /** Every write, in the order it was handed over. */
  readonly calls: AdapterCall[];
  /** The paths whose hash was asked, in order. */
  readonly hashed: string[];
  /** Every `reading()` after this answers the reading with these fields replaced. */
  read(next: Partial<InstanceReading>): void;
  /** Tells every subscriber the instance changed. */
  changed(): void;
  readonly subscribers: number;
}

const EXCLUDED_SUFFIX = '.excluded';

/** The Instance adapter's second implementation: reads answer from the reading and the answers,
 *  each write is recorded, and a decision a caller hands over runs against the reading. */
export function fakeInstanceAdapter(reading: InstanceReading = readingFixture(), answers: InstanceAnswers = {}): FakeInstanceAdapter {
  let current = reading;
  const calls: AdapterCall[] = [];
  const hashed: string[] = [];
  const listeners = new Set<() => void>();

  const record = <T>(call: AdapterCall, result: T): Promise<T> => {
    calls.push(call);
    const refusal = answers.refusals?.[call.verb];
    return refusal === undefined ? Promise.resolve(result) : Promise.reject(new Error(refusal));
  };
  const answer = <T>(found: T | undefined, path: string): Promise<FileRead<T>> =>
    Promise.resolve(found === undefined ? { kind: 'unreadable', reason: `no answer fixed for ${path}` } : { kind: 'read', answer: found });

  const adapter: InstanceAdapter = {
    reading: () => Promise.resolve(current),
    names: { manager: 'Fake manager', modOrderFile: 'modlist.txt', downloadMetadataFile: '.meta' },
    modFolderPath: (mod) => Promise.resolve(answers.modFolderPaths?.get(mod) ?? `/mods/${mod}`),
    sourceFolder: (mod) => (answers.unsourcedMods?.has(mod) ? undefined : `/source/${mod}`),
    installationFiles: (mod) => {
      const reason = answers.unreadableInstallations?.get(mod);
      return Promise.resolve(reason === undefined ? { kind: 'read', answer: answers.installationFiles?.get(mod) ?? [] } : { kind: 'unreadable', reason });
    },
    managerFilesInModFolder: ['meta.ini'],
    fileStamp: (path) => answer(answers.stamps?.get(path), path),
    originFileHash: (path) => {
      hashed.push(path);
      return answer(answers.hashes?.get(path), path);
    },
    changeModOrder: (profile, decide: DecideModOrder) => {
      const changes = decide(current.mods, current.modFolders);
      return record({ verb: 'changeModOrder', profile, changes }, { wrote: changes.length > 0 });
    },
    changePluginOrder: (profile, decide: DecidePluginOrder) => {
      const changes = decide(current.pluginOrder);
      return record({ verb: 'changePluginOrder', profile, changes }, { wrote: changes.length > 0 });
    },
    markDownloadedFile: (name, mark) =>
      record({ verb: 'markDownloadedFile', name, mark }, answers.goneDownloads?.has(name) ? { gone: true } as const : { gone: false, wrote: true } as const),
    trashDownloadedFileMeta: (name) => record({ verb: 'trashDownloadedFileMeta', name }, true),
    selectProfile: (profile) => record({ verb: 'selectProfile', profile }, { wrote: true }),
    createModFolder: (mod) => record({ verb: 'createModFolder', mod }, undefined),
    renameModFolder: (from, to) => record({ verb: 'renameModFolder', from, to }, undefined),
    markOriginFile: (origin, relativePath, mark) =>
      record<OriginFileMarked>({ verb: 'markOriginFile', origin, relativePath, mark }, { gone: false, wrote: true, relativePath }),
    entryKey: (entry) => (entry.kind === 'separator' ? `${entry.name}_separator` : entry.name).toLowerCase(),
    includedPath: (relativePath) => relativePath.split('/').map((segment) => segment.replace(EXCLUDED_SUFFIX, '')).join('/'),
    excludedSuffix: EXCLUDED_SUFFIX,
    renamePlugin: (origin, from, to, gameRelease) => record({ verb: 'renamePlugin', origin, from, to, gameRelease }, undefined),
    trashEntryFolder: (entry) => record({ verb: 'trashEntryFolder', entry }, true),
    trashSourceFolder: (mod) => record({ verb: 'trashSourceFolder', mod }, true),
    install: (source, target, keys) =>
      record<InstallOutcome>({ verb: 'install', source, target, keys }, answers.installed ?? { landed: true, isFomod: false }),
    subscribe: (listener): Subscription => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };

  return {
    adapter, calls, hashed,
    read: (next) => { current = { ...current, ...next }; },
    changed: () => { for (const listener of [...listeners]) listener(); },
    get subscribers() { return listeners.size; },
  };
}
