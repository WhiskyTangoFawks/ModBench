// modlist-repository.md, Status: a mod's folder and metadata against its manifest, the rule the Mod status box and mod
// commands' upgrade check both read.

import { basename, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { MANIFEST_SUFFIX } from '../wire/sourceMod';
import type { Manifest, ManifestFile } from './manifest';
import { manifestIn, sourceManifestIn } from './manifestFiles';
import { packageOf } from './packageOf';

type Read<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };

interface HeldMetadata {
  readonly version?: string;
  readonly installationFile?: { readonly name: string; readonly page?: string };
}

/** What a status reads of a mod besides its manifest, as the Instance adapter answers it. */
export interface FolderReads {
  filesIn(folder: string): Promise<readonly string[]>;
  fileStamp(path: string): Promise<Read<unknown>>;
  originFileHash(path: string): Promise<Read<{ readonly hash: string }>>;
  packageEntries(hash: string): Promise<ReadonlyMap<string, string> | undefined>;
  modMetadata(mod: string): Promise<Read<HeldMetadata>>;
}

/** A mod by its name and folder, and a source mod's source folder, which holds its manifest. */
export interface ModAt {
  readonly name: string;
  readonly folder: string;
  readonly sourceFolder?: string;
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
  readonly unreadable?: string;
}

const nothing = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false, ...over });

const ordered = (paths: readonly string[]): string[] => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const folded = (path: string): string => path.toLowerCase();

// The hash, or the repository whose build wrote it, that fixes a line's bytes, and its path in that package.
function fixedBy(manifest: Manifest, file: ManifestFile): { readonly package: string; readonly path: string } | undefined {
  const { entry } = file;
  if (entry.kind !== 'held' && entry.kind !== 'heldAt') return undefined;
  const pkg = packageOf(manifest, file);
  if (pkg === undefined) return undefined;
  return { package: pkg.kind === 'sourceRepository' ? pkg.name : pkg.hash, path: entry.kind === 'heldAt' ? entry.path : file.path };
}

// A line of a manifest against its folder: the file it names, by its path on disk, none when the folder holds none, and
// whether that file holds the bytes a package entry fixes, none when no package fixes them.
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

/** The folder's files against `manifest`'s lines. A file is hashed only where a package entry fixes its bytes, and a line
 *  whose package entry `reads` lacks does not hold its bytes. */
export async function folderAgainst(manifest: Manifest, folder: string, reads: Omit<FolderReads, 'modMetadata'>): Promise<FolderAgainst> {
  const manifestName = folded(`${basename(folder)}${MANIFEST_SUFFIX}`);
  const onDisk = new Set((await reads.filesIn(folder)).filter((path) => folded(path) !== manifestName));
  // A line names a file in another case only where the file system finds that file by the line's name.
  const found = async (path: string): Promise<boolean> => onDisk.has(path) || (await reads.fileStamp(join(folder, path))).kind === 'read';
  const spelledOnDisk = (path: string): string => (onDisk.has(path) ? path : [...onDisk].find((held) => folded(held) === folded(path)) ?? path);
  const holds = async (path: string, fixes: NonNullable<ReturnType<typeof fixedBy>>): Promise<boolean> => {
    const fixed = (await reads.packageEntries(fixes.package))?.get(fixes.path);
    if (fixed === undefined) return false;
    const hashed = await reads.originFileHash(join(folder, path));
    return hashed.kind === 'read' && hashed.answer.hash === fixed;
  };

  const packed = new Set(manifest.archives.flatMap(({ files }) => files).map(folded));
  const lines: LineAgainstFolder[] = [];
  for (const line of manifest.files.filter(({ path }) => !packed.has(folded(path)))) {
    const fixes = fixedBy(manifest, line);
    if (!(await found(line.path))) {
      lines.push({ line });
      continue;
    }
    const onDiskAs = spelledOnDisk(line.path);
    lines.push(fixes === undefined ? { line, onDisk: onDiskAs } : { line, onDisk: onDiskAs, holdsItsBytes: await holds(onDiskAs, fixes) });
  }

  const named = new Set(manifest.files.map(({ path }) => path));
  const namedByNoLine: string[] = [];
  for (const path of onDisk) {
    if (named.has(path)) continue;
    const namesIt = await Promise.all([...named].filter((line) => folded(line) === folded(path) && !onDisk.has(line)).map(found));
    if (!namesIt.includes(true)) namedByNoLine.push(path);
  }
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
    notInPackage: paths(({ line }) => line.entry.kind !== 'otherBytes' && line.entry.kind !== 'madeByStep' && fixedBy(manifest, line) === undefined),
    otherBytes: paths(({ line }) => line.entry.kind === 'otherBytes'),
  };
}

const sameInstallationFile = (held: HeldMetadata['installationFile'], says: HeldMetadata['installationFile']): boolean =>
  (held === undefined ? says === undefined : says !== undefined && held.name === says.name && held.page === says.page);

// Whether updating the manifest from the metadata would write another version or installation file. A manifest with no
// package holds no version, so the version the metadata holds is no difference.
function metadataDiffers(held: HeldMetadata, manifest: Manifest): boolean {
  const [first] = manifest.packages;
  const says = first?.kind === 'installationFile' ? { name: first.name, ...(first.page === undefined ? {} : { page: first.page }) } : undefined;
  return (first === undefined ? undefined : held.version) !== manifest.version || !sameInstallationFile(held.installationFile, says);
}

/** The version and installation file the manifest holds, as a mod's metadata holds them. */
export function metadataOf(manifest: Manifest): HeldMetadata {
  const [first] = manifest.packages;
  return {
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(first?.kind === 'installationFile' ? { installationFile: { name: first.name, ...(first.page === undefined ? {} : { page: first.page }) } } : {}),
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

/** The mod's folder and metadata against its manifest (modlist-repository.md, Status). A file is hashed only where a
 *  package entry fixes its bytes, and a line whose package entry the hash index lacks differs. */
export async function statusOf(mod: ModAt, reads: FolderReads): Promise<ModStatus> {
  try {
    const metadata = await reads.modMetadata(mod.name);
    if (metadata.kind === 'unreadable') return nothing(mod.name, { unreadable: `its metadata could not be read: ${metadata.reason}` });
    const read = mod.sourceFolder === undefined ? await manifestIn(mod.folder) : await sourceManifestIn(mod.sourceFolder);
    if (read === undefined) return nothing(mod.name, { noManifest: true });
    if ('refused' in read) return nothing(mod.name, { unreadable: read.refused });
    const { manifest } = read;
    const [first] = manifest.packages;
    return {
      ...nothing(mod.name), ...listsOf(manifest, await folderAgainst(manifest, mod.folder, reads)),
      metadataDiffers: metadataDiffers(metadata.answer, manifest), noHost: first?.kind === 'sourceRepository' && !first.isSubmodule,
    };
  } catch (err) {
    return nothing(mod.name, { unreadable: `a file could not be read: ${errorMessage(err)}` });
  }
}

interface ModReads extends FolderReads {
  modFolderPath(mod: string): Promise<string | undefined>;
  sourceMods(): Promise<{ folderOf(mod: string): string | undefined }>;
}

/** Each mod's status as the adapters read it now, for a command, which never reads the Mod status box (ADR-0015). A mod
 *  its name gives no folder has none. */
export async function statusesNow(reads: ModReads, mods: readonly string[]): Promise<ModStatus[]> {
  const sourceMods = await reads.sourceMods();
  const statuses = await Promise.all(mods.map(async (name) => {
    const folder = await reads.modFolderPath(name);
    const sourceFolder = sourceMods.folderOf(name);
    return folder === undefined ? [] : [await statusOf({ name, folder, ...(sourceFolder === undefined ? {} : { sourceFolder }) }, reads)];
  }));
  return statuses.flat();
}
