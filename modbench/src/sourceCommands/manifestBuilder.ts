import { basename } from 'node:path';
import { filesNoPackageHolds, isAddress, ordinal, type Manifest, type ManifestPackage, type NexusFile } from '../manifestAdapter/manifestAdapter';
import type { Depot, GameFileTaken, InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** A file of a folder by its own path, with its hash. */
export interface HashedModFile {
  readonly path: string;
  readonly hash: string;
}

/** The game files a mod's files may be, each with the folder that holds it, and the Steam app and depots recorded as installed in `steamAt`. */
export interface GameHeld {
  readonly files: readonly (Omit<GameFileTaken, 'pathInFolder'> & { readonly pathInFolder?: string })[];
  readonly steamApp?: number;
  readonly steamAt?: string;
  readonly depots: readonly Depot[];
}

// Where a package holds a file's bytes: the installation file by its name, or the game folder, the path in it, and the hash.
interface Source {
  readonly installationFile?: string;
  readonly packagePath: string;
  readonly hash: string;
}

export interface DownloadedFile {
  readonly file: InstallationFile;
  readonly package: Extract<ManifestPackage, { kind: 'installationFile' }>;
}

/** The file on Nexus a page names, as a manifest names its host. */
export function nexusFileOf(adapter: Pick<InstanceAdapter, 'nexusFileAt'>): (page: string) => NexusFile | undefined {
  return (page) => {
    const at = adapter.nexusFileAt(page);
    return at?.fileId === undefined ? undefined : { game: at.game, mod: Number(at.modId), file: Number(at.fileId) };
  };
}

const sameIgnoringCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The installation file with the host and version its downloaded file's own metadata gives, none when that gives none, never the mod's. */
export const describedBy = (file: InstallationFile, downloaded: Pick<InstallationFile, 'page' | 'directUrl' | 'version' | 'pageUnreadable'> | undefined): InstallationFile => ({
  ...file, page: downloaded?.page, directUrl: downloaded?.directUrl, version: downloaded?.version, pageUnreadable: downloaded?.pageUnreadable,
});

const isId = (id: number): boolean => Number.isInteger(id) && id >= 1;

/** The downloaded file as a package, its host the Nexus file `nexusFileOf` reads from its page, else its direct URL. */
export const downloadedFileOf = (file: InstallationFile, nexusFileOf: (page: string) => NexusFile | undefined): DownloadedFile => {
  const named = file.page === undefined ? undefined : nexusFileOf(file.page);
  const nexus = named !== undefined && isId(named.mod) && isId(named.file) ? named : undefined;
  const host = nexus !== undefined ? { nexus } : file.directUrl !== undefined && isAddress(file.directUrl) ? { url: file.directUrl } : undefined;
  return { file, package: { kind: 'installationFile', name: basename(file.path), ...file.version ? { packageVersion: file.version } : {}, size: file.size, hash: file.hash, ...host === undefined ? {} : { host } } };
};

/** One per file name, the first by hash. */
export function downloadedFilesOf(files: readonly InstallationFile[], nexusFileOf: (page: string) => NexusFile | undefined): readonly DownloadedFile[] {
  const named = files.map((file) => ({ name: basename(file.path), file }))
    .sort((a, b) => ordinal(a.name, b.name) || ordinal(a.file.hash, b.file.hash));
  return named.filter(({ name }, at) => named.findIndex((other) => other.name === name) === at).map(({ file }) => downloadedFileOf(file, nexusFileOf));
}

export interface ManifestSources {
  readonly installationFile?: DownloadedFile;
  readonly game?: GameHeld;
  readonly downloadedFiles: readonly DownloadedFile[];
}

/** A manifest as update manifest records it, each file's source, and the files no package it names holds. */
export interface Recorded {
  readonly manifest: Manifest;
  readonly sources: ReadonlyMap<string, Source>;
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
  /** The held packages this machine lacks, and the changed files no present package holds that one of them might. */
  readonly missingPackages: readonly string[];
  readonly hiddenFiles: readonly string[];
  /** Why a package of the manifest names no host the downloaded file's metadata would have given. */
  readonly notes: readonly string[];
}

// An entry at the file's own path before another that holds its bytes.
const entryHolding = (entries: readonly { readonly path: string; readonly hash: string }[], file: HashedModFile): string | undefined =>
  (entries.find((entry) => entry.hash === file.hash && sameIgnoringCase(entry.path, file.path)) ?? entries.find((entry) => entry.hash === file.hash))?.path;

const gameFileHolding = (game: GameHeld, file: HashedModFile): string | undefined =>
  (game.files.find((held) => held.hash === file.hash && sameIgnoringCase(held.pathInFolder ?? held.path, file.path))
    ?? game.files.find((held) => held.hash === file.hash))?.path;

// The store that holds the game's files, none unless the Steam install holds the bytes of every file taken; the held manifest's host while the files it takes from the game keep their bytes.
function gameFolderPackage(game: GameHeld, taken: readonly HashedModFile[], held: Manifest | undefined): ManifestPackage {
  const steamHolds = (file: HashedModFile): boolean => game.files.some((one) => one.root === game.steamAt && one.hash === file.hash);
  if (game.steamApp === undefined || !taken.every(steamHolds)) return { kind: 'gameFolder' };
  const kept = held?.packages.find((pkg) => pkg.kind === 'gameFolder');
  const sameFiles = taken.every(({ path, hash }) => held?.files.get(path) === hash);
  if (kept?.kind === 'gameFolder' && kept.host !== undefined && sameFiles) return kept;
  const depots = game.depots.length === 0 ? undefined : Object.fromEntries(game.depots.map(({ id, version }) => [id, version]));
  return { kind: 'gameFolder', host: { steam: { app: game.steamApp, ...depots === undefined ? {} : { depots } } } };
}


export const packageKey = (pkg: ManifestPackage): string => (pkg.kind === 'installationFile' ? `installationFile:${pkg.name}` : pkg.kind);

interface Holder {
  readonly source: Source;
  readonly download?: DownloadedFile;
  readonly hosted: boolean;
}

/** A folder's manifest from its files: an unchanged file keeps its held package, any other takes one with a host first.
 *  A held package this machine lacks stays while an unchanged file only it could hold. */
export function buildManifest(
  { installationFile, game, downloadedFiles }: ManifestSources, files: readonly HashedModFile[], exclude: readonly string[], held: Manifest | undefined,
): Recorded {
  const sources = new Map<string, Source>();
  const used: DownloadedFile[] = installationFile === undefined ? [] : [installationFile];
  const others = downloadedFiles.filter((other) => other.package.name !== installationFile?.package.name);
  const present = new Set([...downloadedFiles, ...installationFile === undefined ? [] : [installationFile]].map(({ package: pkg }) => pkg.name));
  const heldKeys = new Set(held?.packages.map(packageKey));
  const missing = held?.packages.filter((pkg) => pkg.kind === 'installationFile' && !present.has(pkg.name)) ?? [];
  const takenFromTheGame: HashedModFile[] = [];
  const unplaced: HashedModFile[] = [];
  const hiddenFiles: string[] = [];
  const downloadHolder = (one: DownloadedFile, file: HashedModFile): Holder[] => {
    const path = entryHolding(one.file.entries, file);
    return path === undefined ? [] : [{ source: { installationFile: one.package.name, packagePath: path, hash: file.hash }, download: one, hosted: one.package.host !== undefined }];
  };
  for (const file of files) {
    const fromGame = game === undefined ? undefined : gameFileHolding(game, file);
    const steamHolds = game?.steamApp !== undefined && game.files.some((one) => one.root === game.steamAt && one.hash === file.hash);
    const holders: Holder[] = [
      ...installationFile === undefined ? [] : downloadHolder(installationFile, file),
      ...fromGame === undefined ? [] : [{ source: { packagePath: fromGame, hash: file.hash }, hosted: steamHolds }],
      ...[...used, ...others.filter((other) => !used.includes(other))].filter((one) => one !== installationFile).flatMap((one) => downloadHolder(one, file)),
    ];
    const unchanged = held?.files.get(file.path) === file.hash;
    const keyOf = ({ download }: Holder): string => (download === undefined ? 'gameFolder' : packageKey(download.package));
    const holder = (unchanged ? holders.find((one) => heldKeys.has(keyOf(one))) : undefined) ?? holders.find(({ hosted }) => hosted) ?? holders[0];
    if (holder === undefined) {
      if (missing.length === 0) continue;
      if (unchanged) unplaced.push(file);
      else hiddenFiles.push(file.path);
      continue;
    }
    sources.set(file.path, holder.source);
    if (holder.download === undefined) takenFromTheGame.push(file);
    else if (!used.includes(holder.download)) used.push(holder.download);
  }
  const heldAt = (pkg: ManifestPackage): number => held?.packages.findIndex((one) => packageKey(one) === packageKey(pkg)) ?? -1;
  const rank = (pkg: ManifestPackage): number => (heldAt(pkg) < 0 ? Infinity : heldAt(pkg));
  const manifest: Manifest = {
    packages: [
      ...used.map(({ package: pkg }) => pkg),
      ...takenFromTheGame.length === 0 || game === undefined ? [] : [gameFolderPackage(game, takenFromTheGame, held)],
      ...unplaced.length === 0 ? [] : missing,
    ].sort((a, b) => rank(a) - rank(b)),
    exclude,
    ignore: held?.ignore ?? [],
    flags: new Map([...held?.flags ?? []].filter(([path]) => files.some((file) => file.path === path))),
    files: new Map(files.map(({ path, hash }) => [path, hash])),
  };
  const packageFiles = [
    ...used.flatMap(({ file }) => file.entries),
    ...game === undefined || takenFromTheGame.length === 0 ? [] : game.files.map((one) => ({ path: one.pathInFolder ?? one.path, hash: one.hash })),
    ...unplaced,
  ];
  const notes = used.flatMap(({ file }) => file.pageUnreadable === undefined ? [] : [`the page of ${basename(file.path)} could not be read, so its manifest names no host: ${file.pageUnreadable}`]);
  return {
    manifest, sources, notes, hiddenFiles, missingPackages: missing.flatMap((pkg) => (pkg.kind === 'installationFile' ? [pkg.name] : [])),
    ...filesNoPackageHolds(manifest, packageFiles),
  };
}
