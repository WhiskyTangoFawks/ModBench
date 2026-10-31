// modlist-repository.md, Status: a mod's folder against its manifest, the rule the Mod status box and mod commands' upgrade
// check both read.

import { isManifestPath } from '../repositoriesLib/manifestPath';
import type { FolderFile, FolderValue, HashedPath, StatusValues } from '../repositoriesLib/statusValues';
import type { Manifest, ManifestPackage } from './manifest';
import type { ManifestAt } from './manifestFiles';
import { isExcludedBy } from './folderPaths';
import { installationFileLack } from './packageLack';
import { packageWithoutHost } from './manifestPackages';

/** A mod by its name and the folder that holds it and its manifest. */
export interface ModAt {
  readonly name: string;
  readonly folder: string;
}

/** A mod's folder against its manifest, each list in ordinal order: `differing` and `namedByNoLine` by the paths the folder
 *  holds them at, the rest by the manifest's paths. `unreadable` is why it lists nothing. */
export interface ModStatus {
  readonly mod: string;
  readonly noManifest: boolean;
  readonly differing: readonly string[];
  readonly namedByNoLine: readonly string[];
  readonly gone: readonly string[];
  /** The files no package holds the bytes of, nor a file of their name; `otherBytes`, those a package holds one of their name of. */
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
  /** Each package with no host, as a noun phrase. */
  readonly noHost: readonly string[];
  /** Why this machine does not hold each package the manifest names, as a clause. */
  readonly packagesLacking: readonly string[];
  /** The manifest's path as the folder spells it; none when the folder holds none or it cannot be read. */
  readonly manifestFile?: string;
  readonly unreadable?: string;
}

const nothing = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], noHost: [], packagesLacking: [], ...over });

const ordered = (paths: Iterable<string>): string[] => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const folded = (path: string): string => path.toLowerCase();


const byOwnPath = (files: Iterable<readonly [string, FolderFile]>, key: (path: string) => string): Map<string, (readonly [string, FolderFile])[]> => {
  const held = new Map<string, (readonly [string, FolderFile])[]>();
  for (const entry of files) held.set(key(entry[1].path), [...held.get(key(entry[1].path)) ?? [], entry]);
  return held;
};

// A file of the manifest against its folder: where the folder holds it, none when it lacks it, and whether that file holds
// the bytes and the exclusion the manifest records, none when a step makes it.
interface FileAgainstFolder {
  readonly path: string;
  readonly hash: string | null;
  readonly pathInFolder?: string;
  readonly holdsItsBytes?: boolean;
}

/** A folder against its manifest: each file the manifest names, and by the path the folder holds it at each file it does not. */
export interface FolderAgainst {
  readonly files: readonly FileAgainstFolder[];
  readonly namedByNoLine: readonly string[];
}

/** The folder's files against `manifest`'s, a path matched in its case, else in any case where the file system ignores it.
 *  Of two files at one own path, the one the manifest's exclusion fits is its. */
export function folderAgainst(manifest: Pick<Manifest, 'files' | 'exclude'>, folder: FolderValue): FolderAgainst {
  const held = [...folder.files].filter(([pathInFolder]) => !isManifestPath(pathInFolder));
  const exactly = byOwnPath(held, (path) => path);
  const inAnyCase = byOwnPath(held, folded);
  const claimed = new Set<string>();
  const files = [...manifest.files].map(([path, hash]): FileAgainstFolder => {
    const excluded = isExcludedBy(manifest.exclude, path);
    const candidates = (exactly.get(path) ?? (folder.ignoresCase ? inAnyCase.get(folded(path)) : undefined) ?? []).filter(([at]) => !claimed.has(at));
    const [pathInFolder, file] = candidates.find(([, one]) => one.excluded === excluded) ?? candidates[0] ?? [];
    if (pathInFolder === undefined || file === undefined) return { path, hash };
    claimed.add(pathInFolder);
    if (hash === null) return { path, hash, pathInFolder };
    return { path, hash, pathInFolder, holdsItsBytes: file.excluded === excluded && file.read.kind === 'read' && file.read.answer.hash === hash };
  });
  return { files, namedByNoLine: ordered(held.flatMap(([pathInFolder]) => (claimed.has(pathInFolder) ? [] : [pathInFolder]))) };
}

/** Each file of `manifest` no package holds the bytes of, split by whether a package holds a file of its name: its path,
 *  in any case (GLOSSARY). A source mod's build makes its files, so none is one. */
export function filesNoPackageHolds(manifest: Manifest, packageFiles: readonly HashedPath[]): Pick<ModStatus, 'notInPackage' | 'otherBytes'> {
  if (manifest.packages.some(({ kind }) => kind === 'repository')) return { notInPackage: [], otherBytes: [] };
  const hashes = new Set(packageFiles.map(({ hash }) => hash));
  const paths = new Set(packageFiles.map(({ path }) => folded(path)));
  const unheld = [...manifest.files].flatMap(([path, hash]) => (hash === null || hashes.has(hash) ? [] : [path]));
  return { notInPackage: ordered(unheld.filter((path) => !paths.has(folded(path)))), otherBytes: ordered(unheld.filter((path) => paths.has(folded(path)))) };
}

type ValuesRead = Extract<StatusValues, { kind: 'read' }>;

const isInstallationFile = (pkg: ManifestPackage): pkg is Extract<ManifestPackage, { kind: 'installationFile' }> => pkg.kind === 'installationFile';

function packagesHeld(manifest: Manifest, values: ValuesRead): { lacking: string[]; files: HashedPath[] } {
  const lacking: string[] = [];
  const files: HashedPath[] = [];
  for (const pkg of manifest.packages.filter(isInstallationFile)) {
    const downloaded = values.downloadedFiles.get(pkg.name);
    if (downloaded === undefined) throw new Error(`the downloaded file '${pkg.name}' was not read`);
    const lack = installationFileLack(pkg, downloaded);
    if (lack !== undefined) lacking.push(lack);
    else if (downloaded.kind === 'read') files.push(...downloaded.answer?.entries ?? []);
  }
  if (manifest.packages.some(({ kind }) => kind === 'gameFolder')) {
    if (values.gameFiles === undefined) lacking.push('the game folder was not found');
    else files.push(...values.gameFiles);
  }
  return { lacking, files };
}

/** The mod's folder against its manifest (modlist-repository.md, Status). Which files no package holds waits for every
 *  package to be on this machine. */
export function statusFrom(mod: ModAt, { read, file }: ManifestAt, values: StatusValues): ModStatus {
  if (read === undefined) return nothing(mod.name, { noManifest: true });
  if ('refused' in read) return nothing(mod.name, { unreadable: read.refused });
  if (values.kind === 'notAsked') throw new Error('a manifest is judged against its folder');
  if (values.kind === 'unreadable') return nothing(mod.name, { unreadable: `a file could not be read: ${values.reason}` });
  const { manifest } = read;
  const { files, namedByNoLine } = folderAgainst(manifest, values.folder);
  const held = packagesHeld(manifest, values);
  return {
    ...nothing(mod.name, { manifestFile: file }),
    differing: ordered(files.flatMap(({ pathInFolder, holdsItsBytes }) => (holdsItsBytes === false && pathInFolder !== undefined ? [pathInFolder] : []))),
    namedByNoLine,
    gone: ordered(files.flatMap(({ path, pathInFolder }) => (pathInFolder === undefined ? [path] : []))),
    ...held.lacking.length === 0 ? filesNoPackageHolds(manifest, held.files) : {},
    noHost: manifest.packages.flatMap((pkg) => packageWithoutHost(pkg, values.repositoryHosted)),
    packagesLacking: held.lacking,
  };
}
