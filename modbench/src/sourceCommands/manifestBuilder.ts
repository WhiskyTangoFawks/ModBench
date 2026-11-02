import { basename } from 'node:path';
import { filesNoPackageHolds, isAddress, ordinal, type Manifest, type ManifestPackage, type NexusFile } from '../manifestAdapter/manifestAdapter';
import type { Depot, GameFileTaken, InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** A file of a folder by its own path, with its hash. */
export interface HashedModFile {
  readonly path: string;
  readonly hash: string;
}

/** A place of the game: the game files a mod's files may be, and the Steam app and depots it records as installed. */
export interface GamePlaceHeld {
  readonly files: readonly (Omit<GameFileTaken, 'pathInFolder'> & { readonly pathInFolder?: string })[];
  readonly steamApp?: number;
  readonly depots: readonly Depot[];
}

/** The game's places, the game folder first. */
export interface GameHeld {
  readonly places: readonly [GamePlaceHeld, ...GamePlaceHeld[]];
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

/** The installation file with the host its downloaded file's own metadata gives, none when that gives none, never the mod's. */
export const hostedBy = (file: InstallationFile, downloaded: Pick<InstallationFile, 'page' | 'directUrl'> | undefined): InstallationFile => ({
  ...file, page: downloaded?.page, directUrl: downloaded?.directUrl,
});

const isId = (id: number): boolean => Number.isInteger(id) && id >= 1;

/** The downloaded file as a package, its host the Nexus file `nexusFileOf` reads from its page, else its direct URL. */
export const downloadedFileOf = (file: InstallationFile, nexusFileOf: (page: string) => NexusFile | undefined): DownloadedFile => {
  const named = file.page === undefined ? undefined : nexusFileOf(file.page);
  const nexus = named !== undefined && isId(named.mod) && isId(named.file) ? named : undefined;
  const host = nexus !== undefined ? { nexus } : file.directUrl !== undefined && isAddress(file.directUrl) ? { url: file.directUrl } : undefined;
  return { file, package: { kind: 'installationFile', name: basename(file.path), size: file.size, hash: file.hash, ...host === undefined ? {} : { host } } };
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
}

// An entry at the file's own path before another that holds its bytes.
const entryHolding = (entries: readonly { readonly path: string; readonly hash: string }[], file: HashedModFile): string | undefined =>
  (entries.find((entry) => entry.hash === file.hash && sameIgnoringCase(entry.path, file.path)) ?? entries.find((entry) => entry.hash === file.hash))?.path;

const gameFileHolding = (place: GamePlaceHeld, file: HashedModFile): string | undefined =>
  (place.files.find((held) => held.hash === file.hash && sameIgnoringCase(held.pathInFolder ?? held.path, file.path))
    ?? place.files.find((held) => held.hash === file.hash))?.path;

const depotsOf = (places: readonly GamePlaceHeld[]): Record<string, string> | undefined => {
  const depots = places.flatMap((place) => place.depots);
  return depots.length === 0 ? undefined : Object.fromEntries(depots.map(({ id, version }) => [id, version]));
};

// The store of the places the files come from; the held manifest's while the files it takes from the game keep their bytes.
function gameFolderPackage(places: readonly GamePlaceHeld[], taken: readonly HashedModFile[], held: Manifest | undefined): ManifestPackage {
  const kept = held?.packages.find((pkg) => pkg.kind === 'gameFolder');
  const sameFiles = taken.every(({ path, hash }) => held?.files.get(path) === hash);
  if (kept?.kind === 'gameFolder' && kept.host !== undefined && sameFiles) return kept;
  const app = places.find((place) => place.steamApp !== undefined)?.steamApp;
  const depots = depotsOf(places);
  if (app === undefined) return kept ?? { kind: 'gameFolder' };
  return { kind: 'gameFolder', host: { steam: { app, ...depots === undefined ? {} : { depots } } } };
}

// The place that holds the most of the files first, then one a store installed, as a link makes two places hold one file.
const rankedPlaces = (game: GameHeld | undefined, files: readonly HashedModFile[]): GamePlaceHeld[] => (game?.places ?? [])
  .map((place, at) => ({ place, at, count: files.filter((file) => gameFileHolding(place, file) !== undefined).length }))
  .sort((a, b) => b.count - a.count || Number(b.place.steamApp !== undefined) - Number(a.place.steamApp !== undefined) || a.at - b.at)
  .map(({ place }) => place);

/** A folder's manifest from its files, `exclude` naming the paths it excludes: each file's bytes taken from its installation
 *  file, then the game's places, then another downloaded file. */
export function buildManifest(
  { installationFile, game, downloadedFiles }: ManifestSources, files: readonly HashedModFile[], exclude: readonly string[], held: Manifest | undefined,
): Recorded {
  const sources = new Map<string, Source>();
  const used: DownloadedFile[] = installationFile === undefined ? [] : [installationFile];
  const others = downloadedFiles.filter((other) => other.package.name !== installationFile?.package.name);
  const takenFromTheGame: HashedModFile[] = [];
  const placesTaken = new Set<GamePlaceHeld>();
  const places = rankedPlaces(game, files);
  for (const file of files) {
    const own = installationFile === undefined ? undefined : entryHolding(installationFile.file.entries, file);
    if (own !== undefined && installationFile !== undefined) { sources.set(file.path, { installationFile: installationFile.package.name, packagePath: own, hash: file.hash }); continue; }
    const fromGame = places.map((place) => ({ place, path: gameFileHolding(place, file) })).find(({ path }) => path !== undefined);
    if (fromGame?.path !== undefined) {
      sources.set(file.path, { packagePath: fromGame.path, hash: file.hash });
      takenFromTheGame.push(file);
      placesTaken.add(fromGame.place);
      continue;
    }
    const other = [...used, ...others.filter((one) => !used.includes(one))].map((one) => ({ one, path: entryHolding(one.file.entries, file) }))
      .find(({ path }) => path !== undefined);
    if (other?.path === undefined) continue;
    if (!used.includes(other.one)) used.push(other.one);
    sources.set(file.path, { installationFile: other.one.package.name, packagePath: other.path, hash: file.hash });
  }
  const manifest: Manifest = {
    packages: [
      ...used.map(({ package: pkg }) => pkg),
      ...takenFromTheGame.length === 0 || game === undefined ? [] : [gameFolderPackage(game.places.filter((place) => placesTaken.has(place)), takenFromTheGame, held)],
    ],
    exclude,
    ignore: held?.ignore ?? [],
    flags: new Map([...held?.flags ?? []].filter(([path]) => files.some((file) => file.path === path))),
    files: new Map(files.map(({ path, hash }) => [path, hash])),
  };
  const packageFiles = [
    ...used.flatMap(({ file }) => file.entries),
    ...game === undefined || takenFromTheGame.length === 0 ? [] : game.places.flatMap((place) => place.files.map((one) => ({ path: one.pathInFolder ?? one.path, hash: one.hash }))),
  ];
  return { manifest, sources, ...filesNoPackageHolds(manifest, packageFiles) };
}
