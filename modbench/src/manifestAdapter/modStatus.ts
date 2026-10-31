// modlist-repository.md, Status: a mod's folder and metadata against its manifest, the rule the Mod status box and mod
// commands' upgrade check both read.

import { isManifestPath } from '../repositoriesLib/manifestPath';
import type { Manifest, ManifestFile } from './manifest';
import type { FolderValue, HeldMetadata, PackageEntries, StatusValues } from '../repositoriesLib/statusValues';
import type { ManifestAt } from './manifestFiles';
import { installationFileLack } from './packageLack';
import { packageOf } from './packageOf';
import { repositoryOf } from './sourceMods';

/** A mod by its name and the folder that holds it and its manifest. */
export interface ModAt {
  readonly name: string;
  readonly folder: string;
}

/** A mod's folder against its manifest, each list by path on disk in ordinal order; `unreadable` is why it lists nothing. */
export interface ModStatus {
  readonly mod: string;
  readonly noManifest: boolean;
  readonly differing: readonly string[];
  readonly namedByNoLine: readonly string[];
  readonly gone: readonly string[];
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
  readonly metadataDiffers: boolean;
  readonly noHost: boolean;
  /** Why this machine does not hold each package the manifest pins, as a clause. */
  readonly packagesLacking: readonly string[];
  /** The manifest's path as the folder spells it; none when the folder holds none or it cannot be read. */
  readonly manifestFile?: string;
  readonly unreadable?: string;
}

const nothing = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false, packagesLacking: [], ...over });

const ordered = (paths: readonly string[]): string[] => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const folded = (path: string): string => path.toLowerCase();

type Fixed = { readonly hash: string } | { readonly package: string; readonly path: string };

// The bytes a line records, or the package entry that fixes them. A source mod's line that records none is a file a step
// makes, which nothing fixes (mods.md, Build, story 3).
function fixedBy(manifest: Manifest, file: ManifestFile): Fixed | undefined {
  if (file.hash !== undefined) return { hash: file.hash };
  const { entry } = file;
  if (entry.kind !== 'held' && entry.kind !== 'heldAt') return undefined;
  const pkg = packageOf(manifest, file);
  if (pkg === undefined || pkg.kind === 'sourceRepository') return undefined;
  return { package: pkg.hash, path: entry.kind === 'heldAt' ? entry.path : file.path };
}

const isBuilt = (manifest: Manifest, file: ManifestFile): boolean => packageOf(manifest, file)?.kind === 'sourceRepository';

// A line against its folder: its file's path on disk, none when the folder lacks it, and whether that file holds the
// bytes its line or a package entry fixes, none when nothing fixes them.
interface LineAgainstFolder {
  readonly line: ManifestFile;
  readonly onDisk?: string;
  readonly holdsItsBytes?: boolean;
}

/** A folder against its manifest: each line but those an archive packs, and each file no line names, by path on disk. */
export interface FolderAgainst {
  readonly lines: readonly LineAgainstFolder[];
  readonly namedByNoLine: readonly string[];
}

/** The folder's files against `manifest`'s lines. A line whose package entry `entries` lacks does not hold its bytes. */
export function folderAgainst(manifest: Manifest, folder: FolderValue, entries: PackageEntries): FolderAgainst {
  const onDisk = new Set([...folder.files.keys()].filter((path) => !isManifestPath(path)));
  const found = (path: string): boolean => onDisk.has(path) || (folder.ignoresCase && [...onDisk].some((held) => folded(held) === folded(path)));
  const spelledOnDisk = (path: string): string => (onDisk.has(path) ? path : [...onDisk].find((held) => folded(held) === folded(path)) ?? path);
  const holds = (path: string, fixes: Fixed): boolean => {
    const fixed = 'hash' in fixes ? fixes.hash : entries.get(fixes.package)?.get(fixes.path);
    const hashed = folder.files.get(path);
    return fixed !== undefined && hashed?.kind === 'read' && hashed.answer.hash === fixed;
  };

  const packed = new Set(manifest.archives.flatMap(({ files }) => files).map(folded));
  const lines: LineAgainstFolder[] = [];
  for (const line of manifest.files.filter(({ path }) => !packed.has(folded(path)))) {
    const fixes = fixedBy(manifest, line);
    if (!found(line.path)) {
      lines.push({ line });
      continue;
    }
    const onDiskAs = spelledOnDisk(line.path);
    lines.push(fixes === undefined ? { line, onDisk: onDiskAs } : { line, onDisk: onDiskAs, holdsItsBytes: holds(onDiskAs, fixes) });
  }

  const named = new Set(manifest.files.map(({ path }) => path));
  const namedByNoLine = [...onDisk].filter((path) => !named.has(path) && ![...named].some((line) => folded(line) === folded(path) && !onDisk.has(line) && found(line)));
  return { lines, namedByNoLine: ordered(namedByNoLine) };
}

type FolderLists = Pick<ModStatus, 'differing' | 'namedByNoLine' | 'gone' | 'notInPackage' | 'otherBytes'>;

function listsOf(manifest: Manifest, { lines, namedByNoLine }: FolderAgainst): FolderLists {
  const paths = (where: (against: LineAgainstFolder) => boolean, path = (against: LineAgainstFolder): string => against.line.path): string[] =>
    ordered(lines.filter(where).map(path));
  return {
    differing: paths(({ holdsItsBytes }) => holdsItsBytes === false, ({ onDisk, line }) => onDisk ?? line.path),
    namedByNoLine,
    gone: paths(({ onDisk }) => onDisk === undefined),
    notInPackage: paths(({ line }) => line.entry.kind !== 'otherBytes' && line.entry.kind !== 'madeByStep' && !isBuilt(manifest, line) && fixedBy(manifest, line) === undefined),
    otherBytes: paths(({ line }) => line.entry.kind === 'otherBytes'),
  };
}

const sameInstallationFile = (held: HeldMetadata['installationFile'], says: HeldMetadata['installationFile']): boolean =>
  (held === undefined ? says === undefined : says !== undefined && held.name === says.name && held.page === says.page);

// Whether updating the manifest from the metadata would write another version or installation file. A manifest with no
// package holds no version, so the version the metadata holds is no difference.
function metadataDiffers(held: HeldMetadata, manifest: Manifest): boolean {
  const says = metadataOf(manifest);
  return (manifest.packages.length === 0 ? undefined : held.version) !== says.version || !sameInstallationFile(held.installationFile, says.installationFile);
}

function packagesLacking(manifest: Manifest, values: Extract<StatusValues, { kind: 'read' }>): string[] {
  const lacking: string[] = [];
  for (const pkg of manifest.packages) {
    if (pkg.kind === 'gameFolder' && values.gameFolder.kind === 'notFound') lacking.push('the game folder was not found');
    if (pkg.kind !== 'installationFile') continue;
    const downloaded = values.downloadedFiles.get(pkg.name);
    if (downloaded === undefined) throw new Error(`the downloaded file '${pkg.name}' was not read`);
    const lack = installationFileLack(pkg, downloaded);
    if (lack !== undefined) lacking.push(lack);
  }
  return lacking;
}

/** The version and installation file the manifest holds, as a mod's metadata holds them. */
export function metadataOf(manifest: Manifest): HeldMetadata {
  const named = manifest.packages.find(({ kind, name }) => kind === 'installationFile' && name === manifest.installationFile);
  return {
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(named?.kind === 'installationFile' ? { installationFile: { name: named.name, ...(named.page === undefined ? {} : { page: named.page }) } } : {}),
  };
}

/** Whether writing `says` into the metadata replaces a value `held` holds: another version, another installation file,
 *  or another page for the same one. A value either side lacks replaces nothing (modlist-repository.md, Restore from
 *  manifest, story 2). */
export function metadataOverwritten(held: HeldMetadata, says: HeldMetadata): boolean {
  const version = held.version !== undefined && says.version !== undefined && held.version !== says.version;
  const file = held.installationFile !== undefined && says.installationFile !== undefined && (held.installationFile.name !== says.installationFile.name
    || (held.installationFile.page !== undefined && says.installationFile.page !== undefined && held.installationFile.page !== says.installationFile.page));
  return version || file;
}

/** The mod's folder and metadata against its manifest (modlist-repository.md, Status). A line whose package entry the
 *  values lack differs. */
export function statusFrom(mod: ModAt, { read, file }: ManifestAt, values: StatusValues): ModStatus {
  if (values.metadata.kind === 'unreadable') return nothing(mod.name, { unreadable: `its metadata could not be read: ${values.metadata.reason}` });
  if (read === undefined) return nothing(mod.name, { noManifest: true });
  if ('refused' in read) return nothing(mod.name, { unreadable: read.refused });
  if (values.kind === 'metadataOnly') throw new Error('a manifest is judged against its folder');
  if (values.kind === 'unreadable') return nothing(mod.name, { unreadable: `a file could not be read: ${values.reason}` });
  const { manifest } = read;
  const repository = repositoryOf(manifest);
  return {
    ...nothing(mod.name, { manifestFile: file }), ...listsOf(manifest, folderAgainst(manifest, values.folder, values.packageEntries)),
    metadataDiffers: metadataDiffers(values.metadata.answer, manifest), noHost: repository?.isSubmodule === false,
    packagesLacking: packagesLacking(manifest, values),
  };
}
