import { basename } from 'node:path';
import { ordinalIgnoreCaseThenOrdinal, pinText } from '../manifestAdapter/manifestAdapter';
import type { GameDepot, Manifest, ManifestFile, ManifestPackage, PackageEntry } from '../manifestAdapter/manifestAdapter';
import type { Depot, GameFileTaken, InstallationFile } from '../instanceAdapter/instanceAdapter';

export interface HashedModFile {
  readonly path: string;
  readonly hash: string;
}

/** A place of the game: the game files a mod's files may be, and the store depots it records as installed. */
export interface GamePlaceHeld {
  readonly files: readonly (Omit<GameFileTaken, 'pathInFolder'> & { readonly pathInFolder?: string })[];
  readonly depots: readonly Depot[];
}

/** The game folder by the game's name, its places the game folder first. */
export interface GameHeld {
  readonly name: string;
  readonly places: readonly [GamePlaceHeld, ...GamePlaceHeld[]];
}

type Held = { readonly path: string; readonly hash: string; readonly pathInFolder: string };

const sameIgnoringCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const entryAt = (filePath: string, packagePath: string): PackageEntry =>
  (sameIgnoringCase(filePath, packagePath) ? { kind: 'held' } : { kind: 'heldAt', path: packagePath });

const lineIn = (holder: string, path: string, packagePath: string): ManifestFile => ({ path, entry: entryAt(path, packagePath), package: holder });

// The files a package holds, looked up by hash, each at its path in the package and the path in the folder it is for.
class Holder {
  private readonly byHash = new Map<string, Held[]>();
  private readonly pathsInFolder: Set<string>;

  constructor(readonly name: string, files: readonly Held[]) {
    for (const file of files) this.byHash.set(file.hash, [...this.byHash.get(file.hash) ?? [], file]);
    this.pathsInFolder = new Set(files.map((file) => file.pathInFolder.toLowerCase()));
  }

  pathHolding(held: HashedModFile): string | undefined {
    return this.ownPathHolding(held) ?? this.byHash.get(held.hash)?.[0]?.path;
  }

  /** The path of the file held for `held`'s path, when it has its bytes. */
  ownPathHolding(held: HashedModFile): string | undefined {
    return this.byHash.get(held.hash)?.find((file) => sameIgnoringCase(file.pathInFolder, held.path))?.path;
  }

  holdsAPathOf(held: HashedModFile): boolean {
    return this.pathsInFolder.has(held.path.toLowerCase());
  }
}

export interface DownloadedFile {
  readonly holder: Holder;
  readonly package: Extract<ManifestPackage, { kind: 'installationFile' }>;
}

const downloadedFileOf = (file: InstallationFile): DownloadedFile => {
  const name = basename(file.path);
  return {
    holder: new Holder(name, file.entries.map((entry) => ({ path: entry.path, hash: entry.hash, pathInFolder: entry.path }))),
    package: { kind: 'installationFile', name, size: file.size, hash: file.hash, ...file.page === undefined ? {} : { page: file.page } },
  };
};

/** One holder per file name, the first by hash, built once for a request. */
export function downloadedFilesOf(files: readonly InstallationFile[]): readonly DownloadedFile[] {
  const named = files.map((file) => ({ name: basename(file.path), file }))
    .sort((a, b) => ordinal(a.name, b.name) || ordinal(a.file.hash, b.file.hash));
  return named.filter(({ name }, at) => named.findIndex((other) => other.name === name) === at).map(({ file }) => downloadedFileOf(file));
}

export interface ManifestSources {
  readonly installationFile?: InstallationFile;
  readonly game?: GameHeld;
  readonly downloadedFiles: readonly DownloadedFile[];
}

/** A game folder package's entries, each package path's hash, which the hash index keeps under the pin. */
export interface PackageEntries {
  readonly hash: string;
  readonly entries: ReadonlyMap<string, string>;
}

type Taken = { readonly file: HashedModFile; readonly packagePath: string };

class Sourcing {
  readonly packages: { holder: Holder; package: ManifestPackage }[] = [];
  readonly lines = new Map<string, ManifestFile>();

  constructor(own: DownloadedFile | undefined) {
    if (own !== undefined) this.packages.push({ holder: own.holder, package: own.package });
  }

  unsourced(files: readonly HashedModFile[]): HashedModFile[] {
    return files.filter((file) => !this.lines.has(file.path));
  }

  take(holder: Holder | undefined, files: readonly HashedModFile[], ownPathOnly = false): Taken[] {
    const taken: Taken[] = [];
    if (holder === undefined) return taken;
    for (const file of files) {
      const packagePath = ownPathOnly ? holder.ownPathHolding(file) : holder.pathHolding(file);
      if (packagePath === undefined) continue;
      this.lines.set(file.path, lineIn(holder.name, file.path, packagePath));
      taken.push({ file, packagePath });
    }
    return taken;
  }

  recordUnsourced(files: readonly HashedModFile[]): void {
    for (const file of this.unsourced(files)) {
      const holding = this.packages.map(({ holder }) => holder).find((holder) => holder.holdsAPathOf(file));
      this.lines.set(file.path, holding === undefined
        ? { path: file.path, entry: { kind: 'notHeld' } }
        : { path: file.path, entry: { kind: 'otherBytes' }, package: holding.name });
    }
  }

  // The version rides the first package, so a mod with no package has none.
  manifest(ordered: readonly HashedModFile[], version: string | undefined): Manifest {
    const first = this.packages[0]?.holder.name;
    const files = ordered.flatMap((file) => {
      const line = this.lines.get(file.path);
      return line === undefined ? [] : [line.package === first ? { path: line.path, entry: line.entry } : line];
    });
    return {
      packages: this.packages.map(({ package: pkg }) => pkg), exclude: [], archives: [], steps: [], tools: [], files,
      ...this.packages.length > 0 && version !== undefined ? { version } : {},
    };
  }
}

const depotKey = (depot: Depot): string => `${depot.id}\n${depot.version}`;

const distinctDepots = (depots: readonly Depot[]): Depot[] => [...new Map(depots.map((depot) => [depotKey(depot), depot])).values()];

// A pin of the files taken holds while they do, so the depots stay with it, and when a place records none, as a copy of the game does.
function keepingDepots(recorded: ManifestPackage, held: Manifest | undefined): ManifestPackage {
  if (recorded.kind !== 'gameFolder') return recorded;
  const kept = held?.packages.find((named) => named.kind === 'gameFolder' && named.name === recorded.name);
  return kept?.kind === 'gameFolder' && kept.depots.length > 0 && (recorded.depots.length === 0 || kept.hash === recorded.hash)
    ? { ...recorded, depots: kept.depots }
    : recorded;
}

const heldFor = (file: GamePlaceHeld['files'][number]): Held => ({ path: file.path, hash: file.hash, pathInFolder: file.pathInFolder ?? file.path });

const gameHolder = (name: string, places: readonly GamePlaceHeld[]): Holder => new Holder(name, places.flatMap((place) => place.files.map(heldFor)));

/** A mod's manifest from the mod as it is: each file taken by hash from its installation file, then the game's places,
 *  then another download. `held`'s steps and their files stay as written (ADR-0022). */
export async function buildManifest(
  { installationFile, game, downloadedFiles }: ManifestSources, files: readonly HashedModFile[], version: string | undefined, held: Manifest | undefined,
  hashText: (text: string) => Promise<string>,
): Promise<{ manifest: Manifest; gamePackage: PackageEntries | undefined }> {
  const madeByStep = new Set(held?.files.filter((line) => line.entry.kind === 'madeByStep').map((line) => line.path));
  const own = installationFile === undefined ? undefined : downloadedFileOf(installationFile);
  const others = downloadedFiles.filter((other) => other.package.name !== own?.package.name);
  const ordered = files.filter((file) => !madeByStep.has(file.path)).sort((a, b) => ordinalIgnoreCaseThenOrdinal(a.path, b.path));

  const sourcing = new Sourcing(own);
  sourcing.take(own?.holder, ordered);
  const gamePackage = game === undefined ? undefined : await takenFromThePlacesOfTheGame(sourcing, game, ordered, hashText);
  takenFromOtherDownloadedFiles(sourcing, others, ordered);
  sourcing.recordUnsourced(ordered);
  const recorded = sourcing.manifest(ordered, version);

  const base = held ?? recorded;
  const manifest: Manifest = {
    packages: recorded.packages.map((pkg) => keepingDepots(pkg, held)),
    exclude: base.exclude, archives: base.archives, steps: base.steps, tools: base.tools,
    files: [...recorded.files, ...[...madeByStep].map((path): ManifestFile => ({ path, entry: { kind: 'madeByStep' } }))],
    ...base.output === undefined ? {} : { output: base.output },
    ...recorded.version === undefined ? {} : { version: recorded.version },
  };
  return { manifest, gamePackage };
}

async function takenFromThePlacesOfTheGame(
  sourcing: Sourcing, game: GameHeld, ordered: readonly HashedModFile[], hashText: (text: string) => Promise<string>,
): Promise<PackageEntries | undefined> {
  const wanting = sourcing.unsourced(ordered);
  const ranked = game.places
    .map((place, at) => {
      const holder = gameHolder(game.name, [place]);
      return { place, holder, at, count: wanting.filter((file) => holder.pathHolding(file) !== undefined).length };
    })
    .sort((a, b) => b.count - a.count || Number(b.place.depots.length > 0) - Number(a.place.depots.length > 0) || a.at - b.at);
  const taken: Taken[] = [];
  let depots: Depot[] = [];
  for (const ownPathOnly of [true, false]) {
    for (const { place, holder } of ranked) {
      const takenHere = sourcing.take(holder, sourcing.unsourced(wanting), ownPathOnly);
      if (takenHere.length === 0) continue;
      taken.push(...takenHere);
      depots = distinctDepots([...depots, ...place.depots]);
    }
  }
  if (taken.length === 0) return undefined;
  const hash = await hashText(pinText(taken.map(({ file }) => file)));
  const gameDepots: GameDepot[] = depots.map(({ id, version }) => ({ id, version }));
  sourcing.packages.push({ holder: gameHolder(game.name, game.places), package: { kind: 'gameFolder', name: game.name, hash, depots: gameDepots } });
  const entries = new Map(taken.map(({ file, packagePath }) => [entryAt(file.path, packagePath).kind === 'heldAt' ? packagePath : file.path, file.hash]));
  return { hash, entries };
}

function takenFromOtherDownloadedFiles(sourcing: Sourcing, others: readonly DownloadedFile[], ordered: readonly HashedModFile[]): void {
  const used: DownloadedFile[] = [];
  for (const file of sourcing.unsourced(ordered)) {
    const holding = others.map((other) => ({ other, path: other.holder.pathHolding(file) }))
      .filter((candidate) => candidate.path !== undefined)
      .sort((a, b) => Number(!used.includes(a.other)) - Number(!used.includes(b.other)))[0];
    if (holding?.path === undefined) continue;
    if (!used.includes(holding.other)) used.push(holding.other);
    sourcing.lines.set(file.path, lineIn(holding.other.holder.name, file.path, holding.path));
  }
  sourcing.packages.push(...used.map((other) => ({ holder: other.holder, package: other.package })));
}
