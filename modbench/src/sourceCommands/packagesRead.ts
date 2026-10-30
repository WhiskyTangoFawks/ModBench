// modlist-repository.md, Restore from manifest, story 4: where this machine holds each file a manifest's packages
// fix, and what it lacks.

import type { FileRead, GameFile, GamePlace, InstallationFile, InstanceAdapter, PackageFile } from '../instanceAdapter/instanceAdapter';
import { packageOf, pinText, type Manifest, type ManifestFile, type ManifestPackage } from '../manifestAdapter/manifestAdapter';
import type { NamedGameFolder } from './gameFolderFacts';

type Adapter = Pick<InstanceAdapter, 'gameFiles' | 'textHash'>;

/** The downloaded file of each name `manifest` names, as the downloads folder holds it now. */
export async function downloadedNow(adapter: Pick<InstanceAdapter, 'downloadedFile'>, manifest: Manifest): Promise<PackagesHeld['downloaded']> {
  const read = new Map<string, FileRead<InstallationFile | undefined>>();
  for (const pkg of manifest.packages) {
    if (pkg.kind === 'installationFile') read.set(pkg.name, await adapter.downloadedFile(pkg.name));
  }
  return (name) => read.get(name) ?? { kind: 'read', answer: undefined };
}

/** What restore takes a manifest's packages from on this machine. */
export interface PackagesHeld {
  /** The downloaded file of a name, as the downloads folder holds it. */
  readonly downloaded: (name: string) => FileRead<InstallationFile | undefined>;
  readonly game: NamedGameFolder | string;
  /** The label of each VS Code task this machine has. */
  readonly tasks: ReadonlySet<string>;
}

/** Where each line a package fixes has its bytes, and the hash it fixes, by the line's path, each package's entries by its
 *  hash, and what the mod lacks. */
export interface PackagesRead {
  readonly packageFiles: ReadonlyMap<string, PackageFile>;
  readonly hashes: ReadonlyMap<string, string>;
  readonly entries: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly lacks: readonly string[];
  readonly installationFiles: readonly InstallationFile[];
  /** The game files the lines take, by the place that holds them. */
  readonly gameFiles: ReadonlyMap<GamePlace, readonly GameFile[]>;
}

type InstallationFilePackage = Extract<ManifestPackage, { kind: 'installationFile' }>;
type GameFolderPackage = Extract<ManifestPackage, { kind: 'gameFolder' }>;

const pathInPackage = (line: ManifestFile): string => (line.entry.kind === 'heldAt' ? line.entry.path : line.path);

const folded = (path: string): string => path.toLowerCase();

// An entry is named in its case, else in any case, as the game reads a path.
function entryOf(file: InstallationFile, path: string): { readonly path: string; readonly hash: string } | undefined {
  return file.entries.find((entry) => entry.path === path) ?? file.entries.find((entry) => folded(entry.path) === folded(path));
}

function installationFilesOf(manifest: Manifest, downloaded: PackagesHeld['downloaded']): { held: Map<string, InstallationFile>; lacks: string[] } {
  const held = new Map<string, InstallationFile>();
  const lacks: string[] = [];
  for (const named of manifest.packages.filter((pkg): pkg is InstallationFilePackage => pkg.kind === 'installationFile')) {
    const read = downloaded(named.name);
    if (read.kind === 'unreadable') lacks.push(`installation file '${named.name}' could not be read: ${read.reason}`);
    else if (read.answer === undefined) lacks.push(`installation file '${named.name}' is missing`);
    else if (read.answer.hash !== named.hash) lacks.push(`installation file '${named.name}' has other bytes`);
    else held.set(named.name, read.answer);
  }
  return { held, lacks };
}

function lineLack(manifest: Manifest, line: ManifestFile): string | undefined {
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
  readonly entries: Map<string, ReadonlyMap<string, string>>;
  readonly lacks: string[];
  readonly files: Map<GamePlace, GameFile[]>;
}

async function takenFrom(
  adapter: Adapter, manifest: Manifest, lines: readonly ManifestFile[], places: readonly PlaceRead[], unreadable: ReadonlyMap<string, string>,
): Promise<GameTaken> {
  const taken: GameTaken = { packageFiles: new Map(), hashes: new Map(), entries: new Map(), lacks: [], files: new Map() };
  const hashes = new Map<string, Map<string, string>>();
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
    hashes.set(pkg, (hashes.get(pkg) ?? new Map<string, string>()).set(path, file.hash));
    pinned.set(pkg, [...pinned.get(pkg) ?? [], { path: line.path, hash: file.hash }]);
  }
  for (const pkg of manifest.packages.filter((one): one is GameFolderPackage => one.kind === 'gameFolder' && pinned.has(one.name))) {
    if (taken.lacks.length > 0) break;
    if (await adapter.textHash(pinText(pinned.get(pkg.name) ?? [])) === pkg.hash) taken.entries.set(pkg.hash, hashes.get(pkg.name) ?? new Map());
    else taken.lacks.push(`the files it takes from the game folder '${pkg.name}' have other bytes`);
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
async function gameFilesOf(adapter: Adapter, manifest: Manifest, lines: readonly ManifestFile[], game: NamedGameFolder | string): Promise<GameTaken> {
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

/** Why this machine cannot run `manifest`'s steps: each tool it has no task for (mods.md, Build, story 14). */
export function toolsWithoutTask(manifest: Manifest, tasks: ReadonlySet<string>): string | undefined {
  const pages = new Map<string, string>();
  for (const { task, page } of manifest.tools) if (!pages.has(task)) pages.set(task, page);
  const named = [...new Set([...manifest.steps.map(({ task }) => task), ...pages.keys()])].filter((task) => !tasks.has(task))
    .map((task) => (pages.has(task) ? `'${task}' (${pages.get(task) ?? ''})` : `'${task}'`));
  const last = named.pop();
  if (last === undefined) return undefined;
  return named.length === 0 ? `this machine has no task for its tool ${last}` : `this machine has no task for its tools ${named.join(', ')} and ${last}`;
}

/** Where this machine holds the bytes each of `manifest`'s lines fixes, from the installation files and the game's places. */
export async function packagesRead(adapter: Adapter, manifest: Manifest, { downloaded, game, tasks }: PackagesHeld): Promise<PackagesRead> {
  const installed = installationFilesOf(manifest, downloaded);
  const packageFiles = new Map<string, PackageFile>();
  const hashes = new Map<string, string>();
  const entries = new Map<string, Map<string, string>>();
  const lacks = [...installed.lacks];
  const fromTheGame: ManifestFile[] = [];
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
      const held = entries.get(pkg.hash) ?? new Map(file.entries.map(({ path, hash }) => [path, hash]));
      entries.set(pkg.hash, held.set(pathInPackage(line), entry.hash));
    }
  }
  const taken = await gameFilesOf(adapter, manifest, fromTheGame, game);
  for (const [path, file] of taken.packageFiles) packageFiles.set(path, file);
  for (const [path, hash] of taken.hashes) hashes.set(path, hash);
  const noTask = toolsWithoutTask(manifest, tasks);
  return {
    packageFiles, hashes, entries: new Map([...entries, ...taken.entries]), lacks: [...new Set([...lacks, ...taken.lacks, ...(noTask === undefined ? [] : [noTask])])],
    installationFiles: [...installed.held.values()], gameFiles: taken.files,
  };
}
