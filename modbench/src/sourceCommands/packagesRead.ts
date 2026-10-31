// mods.md, Build, story 1: where this machine holds each file a build file's packages fix, and what it lacks.

import type { FileRead, GameFile, GamePlace, InstallationFile, InstanceAdapter, PackageFile } from '../instanceAdapter/instanceAdapter';
import { installationFileLack, packageOf, pinText, type BuildFile, type BuildFileLine, type BuildFilePackage } from '../manifestAdapter/manifestAdapter';
import type { NamedGameFolder } from './gameFolderFacts';

type Adapter = Pick<InstanceAdapter, 'gameFiles' | 'textHash'>;

/** What this machine holds of the installation file a manifest pins. */
export interface PinHeld {
  /** The downloaded file of the pinned name, else one under another name with the pinned size and hash. */
  readonly read: FileRead<InstallationFile | undefined>;
  /** The file under another name that holds the pinned bytes, when no file has the pinned name. */
  readonly underAnotherName?: InstallationFile;
  /** The file under another name that holds the pinned bytes, when the file of the pinned name holds other bytes or cannot be read. */
  readonly elsewhere?: InstallationFile;
  /** Why a downloaded file could not be checked for the pinned bytes. */
  readonly notes: readonly string[];
}

export async function downloadedFileHoldingPin(
  adapter: Pick<InstanceAdapter, 'downloadedFile' | 'downloadedFileHolding'>, pinned: { readonly name: string; readonly size: number; readonly hash: string },
): Promise<PinHeld> {
  const named = await adapter.downloadedFile(pinned.name);
  if (named.kind === 'read' && named.answer?.hash === pinned.hash) return { read: named, notes: [] };
  const { file, notes } = await adapter.downloadedFileHolding(pinned);
  if (named.kind === 'read' && named.answer === undefined) return { read: { kind: 'read', answer: file }, ...(file === undefined ? {} : { underAnotherName: file }), notes };
  return { read: named, ...(file === undefined ? {} : { elsewhere: file }), notes };
}

/** The downloaded file of each name `buildFile` names, as the downloads folder holds it now. */
export async function downloadedNow(adapter: Pick<InstanceAdapter, 'downloadedFile' | 'downloadedFileHolding'>, buildFile: BuildFile): Promise<PackagesHeld['downloaded']> {
  const read = new Map<string, FileRead<InstallationFile | undefined>>();
  for (const pkg of buildFile.packages) {
    if (pkg.kind === 'installationFile') read.set(pkg.name, (await downloadedFileHoldingPin(adapter, pkg)).read);
  }
  return (name) => read.get(name) ?? { kind: 'read', answer: undefined };
}

/** What a build takes a build file's packages from on this machine. */
export interface PackagesHeld {
  /** The downloaded file of a name, as the downloads folder holds it. */
  readonly downloaded: (name: string) => FileRead<InstallationFile | undefined>;
  readonly game: NamedGameFolder | string;
}

/** Where each line a package fixes has its bytes, and the hash it fixes, by the line's path, and what the mod lacks. */
export interface PackagesRead {
  readonly packageFiles: ReadonlyMap<string, PackageFile>;
  readonly hashes: ReadonlyMap<string, string>;
  readonly lacks: readonly string[];
  readonly installationFiles: readonly InstallationFile[];
  /** The game files the lines take, by the place that holds them. */
  readonly gameFiles: ReadonlyMap<GamePlace, readonly GameFile[]>;
}

type InstallationFilePackage = Extract<BuildFilePackage, { kind: 'installationFile' }>;
type GameFolderPackage = Extract<BuildFilePackage, { kind: 'gameFolder' }>;

const pathInPackage = (line: BuildFileLine): string => (line.entry.kind === 'heldAt' ? line.entry.path : line.path);

const folded = (path: string): string => path.toLowerCase();

// An entry is named in its case, else in any case, as the game reads a path.
function entryOf(file: InstallationFile, path: string): { readonly path: string; readonly hash: string } | undefined {
  return file.entries.find((entry) => entry.path === path) ?? file.entries.find((entry) => folded(entry.path) === folded(path));
}

function installationFilesOf(manifest: BuildFile, downloaded: PackagesHeld['downloaded']): { held: Map<string, InstallationFile>; lacks: string[] } {
  const held = new Map<string, InstallationFile>();
  const lacks: string[] = [];
  for (const named of manifest.packages.filter((pkg): pkg is InstallationFilePackage => pkg.kind === 'installationFile')) {
    const read = downloaded(named.name);
    const lack = installationFileLack(named, read);
    if (lack !== undefined) lacks.push(lack);
    else if (read.kind === 'read' && read.answer !== undefined) held.set(named.name, read.answer);
  }
  return { held, lacks };
}

function lineLack(manifest: BuildFile, line: BuildFileLine): string | undefined {
  if (line.entry.kind === 'notHeld') return `its package does not hold '${line.path}'`;
  if (line.entry.kind === 'otherBytes') return `its package holds '${line.path}' with other bytes`;
  if (line.entry.kind !== 'madeByStep' && packageOf(manifest, line) === undefined) return `'${line.path}' names no installation file`;
  return undefined;
}

interface PlaceRead {
  readonly place: GamePlace;
  readonly files: ReadonlyMap<string, GameFile>;
}

interface GameTaken {
  readonly packageFiles: Map<string, PackageFile>;
  readonly hashes: Map<string, string>;
  readonly lacks: string[];
  readonly files: Map<GamePlace, GameFile[]>;
}

async function takenFrom(
  adapter: Adapter, manifest: BuildFile, lines: readonly BuildFileLine[], places: readonly PlaceRead[], unreadable: ReadonlyMap<string, string>,
): Promise<GameTaken> {
  const taken: GameTaken = { packageFiles: new Map(), hashes: new Map(), lacks: [], files: new Map() };
  const pinned = new Map<string, { path: string; hash: string }[]>();
  for (const line of lines) {
    const path = pathInPackage(line);
    const at = places.find(({ files }) => files.has(folded(path)));
    const file = at?.files.get(folded(path));
    if (at === undefined || file === undefined) {
      const why = unreadable.get(folded(path));
      taken.lacks.push(why === undefined ? `game file '${path}' is missing` : `game file '${path}' could not be read: ${why}`);
      continue;
    }
    const pkg = packageOf(manifest, line)?.name ?? '';
    taken.packageFiles.set(line.path, { kind: 'gameFile', root: at.place.root, path: file.path });
    taken.hashes.set(line.path, file.hash);
    taken.files.set(at.place, [...taken.files.get(at.place) ?? [], file]);
    pinned.set(pkg, [...pinned.get(pkg) ?? [], { path: line.path, hash: file.hash }]);
  }
  for (const pkg of manifest.packages.filter((one): one is GameFolderPackage => one.kind === 'gameFolder' && pinned.has(one.name))) {
    if (taken.lacks.length > 0) break;
    if (await adapter.textHash(pinText(pinned.get(pkg.name) ?? [])) !== pkg.hash) taken.lacks.push(`the files it takes from the game folder '${pkg.name}' have other bytes`);
  }
  if (taken.lacks.length > 0) {
    for (const pkg of manifest.packages.filter((one): one is GameFolderPackage => one.kind === 'gameFolder' && one.depots.length > 0)) {
      taken.lacks.push(`the game folder '${pkg.name}' is ${pkg.depots.map((depot) => `depot ${depot.id} at version ${depot.version}`).join(' and ')}`);
    }
  }
  return taken;
}

// modlist-repository.md, Restore from manifest, story 4: the game folder first, then each other place of the game, and the
// first order whose places hold every file with the bytes the pin fixes.
async function gameFilesOf(adapter: Adapter, manifest: BuildFile, lines: readonly BuildFileLine[], game: NamedGameFolder | string): Promise<GameTaken> {
  const paths = [...new Set(lines.map(pathInPackage))];
  if (typeof game === 'string') return takenFrom(adapter, manifest, lines, [], new Map(paths.map((path) => [folded(path), game])));
  if (lines.length === 0) return takenFrom(adapter, manifest, lines, [], new Map());
  const unreadable = new Map<string, string>();
  const places: PlaceRead[] = [];
  for (const place of game.places) {
    const read = await adapter.gameFiles(place, paths);
    for (const [path, why] of Object.entries(read.unreadable)) if (!unreadable.has(folded(path))) unreadable.set(folded(path), why);
    places.push({ place, files: new Map(read.files.map((file) => [folded(file.path), file])) });
  }
  const first = await takenFrom(adapter, manifest, lines, places, unreadable);
  for (let at = 1; at < places.length && first.lacks.length > 0; at++) {
    const rotated = await takenFrom(adapter, manifest, lines, [...places.slice(at), ...places.slice(0, at)], unreadable);
    if (rotated.lacks.length === 0) return rotated;
  }
  return first;
}

/** Why this machine cannot run a build file's steps: each tool it has no task for (mods.md, Build, story 13). */
export function toolsWithoutTask(buildFile: BuildFile, tasks: ReadonlySet<string>): string | undefined {
  const pages = new Map<string, string>();
  for (const { task, page } of buildFile.tools) if (!pages.has(task)) pages.set(task, page);
  const named = [...new Set([...buildFile.steps.map(({ task }) => task), ...pages.keys()])].filter((task) => !tasks.has(task))
    .map((task) => (pages.has(task) ? `'${task}' (${pages.get(task) ?? ''})` : `'${task}'`));
  const last = named.pop();
  if (last === undefined) return undefined;
  return named.length === 0 ? `this machine has no task for its tool ${last}` : `this machine has no task for its tools ${named.join(', ')} and ${last}`;
}

/** Where this machine holds the bytes each of `manifest`'s lines fixes, from the installation files and the game's places. */
export async function packagesRead(adapter: Adapter, manifest: BuildFile, { downloaded, game }: PackagesHeld): Promise<PackagesRead> {
  const installed = installationFilesOf(manifest, downloaded);
  const packageFiles = new Map<string, PackageFile>();
  const hashes = new Map<string, string>();
  const lacks = [...installed.lacks];
  const fromTheGame: BuildFileLine[] = [];
  for (const line of manifest.files) {
    const lack = lineLack(manifest, line);
    const pkg = packageOf(manifest, line);
    if (lack !== undefined) lacks.push(lack);
    else if (line.entry.kind === 'madeByStep') continue;
    else if (pkg?.kind === 'gameFolder') fromTheGame.push(line);
    else if (pkg?.kind === 'installationFile') {
      const file = installed.held.get(pkg.name);
      const entry = file === undefined ? undefined : entryOf(file, pathInPackage(line));
      if (file !== undefined && entry === undefined) lacks.push(`installation file '${pkg.name}' holds no '${pathInPackage(line)}'`);
      if (file === undefined || entry === undefined) continue;
      packageFiles.set(line.path, { kind: 'entry', downloadedFile: file.path, entry: entry.path });
      hashes.set(line.path, entry.hash);
    }
  }
  const taken = await gameFilesOf(adapter, manifest, fromTheGame, game);
  for (const [path, file] of taken.packageFiles) packageFiles.set(path, file);
  for (const [path, hash] of taken.hashes) hashes.set(path, hash);
  return {
    packageFiles, hashes, lacks: [...new Set([...lacks, ...taken.lacks])],
    installationFiles: [...installed.held.values()], gameFiles: taken.files,
  };
}
