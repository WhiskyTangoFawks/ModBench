import type { Covering, FileOrigin, InstanceValue, Mod, OriginFile, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { copyStandingOf, fileOrderConflictOf, foldPath, modOrigin, sameOrigin, type CopyStanding } from '../instanceLoader/fileConflictIndex';

/** Each indicator in the order mods.md's table lists them, with its name there.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const MOD_INDICATORS = [
  { id: 'overwritesLooseFiles', name: 'Overwrites loose files', badge: '⊕', colour: 'modbench.modOverwritesLooseFiles' },
  { id: 'overwrittenLooseFiles', name: 'Overwritten loose files', badge: '⊖', colour: 'modbench.modOverwrittenLooseFiles' },
  { id: 'overwritesArchiveWithLooseFiles', name: 'Overwrites an archive with loose files', badge: '⊞', colour: 'modbench.modOverwritesArchiveWithLooseFiles' },
  { id: 'archiveOverwrittenByLooseFiles', name: 'Archive is overwritten by loose files', badge: '⊟', colour: 'modbench.modArchiveOverwrittenByLooseFiles' },
  { id: 'overwritesAnotherArchiveFile', name: 'Overwrites another archive file', badge: '⊛', colour: 'modbench.modOverwritesAnotherArchiveFile' },
  { id: 'overwrittenByAnotherArchiveFile', name: 'Overwritten by another archive file', badge: '⊝', colour: 'modbench.modOverwrittenByAnotherArchiveFile' },
  { id: 'redundant', name: 'Redundant', badge: '⊗', colour: 'modbench.modRedundant' },
  { id: 'containsExcludedFiles', name: 'Contains excluded files', badge: '⊘', colour: 'modbench.modContainsExcludedFiles' },
  { id: 'updateAvailable', name: 'Update available', badge: '↑', colour: 'modbench.modUpdateAvailable' },
] as const;

export type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

export type IndicatorsValue = Pick<InstanceValue, 'mods' | 'modGroups' | 'filesByMod' | 'stackedCopies' | 'archiveContents'>;

/** Each path a mod may hold a copy at: each of its files, and each file an archive of its holds. */
export const copyPathsOf = (value: Pick<InstanceValue, 'archiveContents'>, files: readonly OriginFile[]): string[] => files.flatMap(({ relativePath, sourcePath }) => {
  const read = value.archiveContents.get(sourcePath);
  return [relativePath, ...read?.kind === 'read' ? read.answer : []];
});

export function indicatorsOf(value: Pick<InstanceValue, 'stackedCopies' | 'archiveContents'>, { name, updateAvailable }: Mod, files: readonly OriginFile[]): ModIndicator[] {
  return indicatorsFrom(copyStandingOf(value.stackedCopies, modOrigin(name), copyPathsOf(value, files)), files.some((file) => file.excluded), updateAvailable === true);
}

/** The indicators a mod's copy standing, its excluded files and its update give it, in mods.md's order. */
export function indicatorsFrom(standing: CopyStanding, containsExcludedFiles: boolean, updateAvailable: boolean): ModIndicator[] {
  const holds: Record<ModIndicator, boolean> = { ...standing, containsExcludedFiles, updateAvailable };
  return MOD_INDICATORS.flatMap(({ id }) => (holds[id] ? [id] : []));
}

export const isNotDeployed = (enabled: boolean, entry: OriginFolder): boolean => !enabled || entry.excluded;

export function isFileNotGotten(value: Pick<InstanceValue, 'files'>, origin: FileOrigin, enabled: boolean, file: OriginFile): boolean {
  return isNotDeployed(enabled, file) || fileOrderConflictOf(value.files.get(file.relativePath), origin) === 'loses';
}

/** The publisher tags that mark the file or folder at `path`, as its publisher applies them. */
export const pathTagsOf = (covering: Covering, path: string, mod: string | undefined): PublisherTag[] =>
  covering(path, mod).filter(({ marksPaths }) => marksPaths);

/** The path of the loose file in the game folder that wins over every archived copy of `entry`: a mod's loose copy
 *  overlays the game folder's, so there is none while one exists. */
export function gameFolderFileOver(value: Pick<InstanceValue, 'dataFolderFiles' | 'stackedCopies'>, entry: string): string | undefined {
  return value.stackedCopies.get(entry)?.copies[0]?.at.kind === 'archived' ? gameFolderFile(value, entry) : undefined;
}

/** The path of the loose file `entry` in the game folder's Data folder, if it holds one. */
export function gameFolderFile(value: Pick<InstanceValue, 'dataFolderFiles'>, entry: string): string | undefined {
  return value.dataFolderFiles.kind === 'listed' ? value.dataFolderFiles.files.get(foldPath(entry))?.path : undefined;
}

export interface ArchivedFileStanding {
  readonly path: string;
  readonly gotten: boolean;
  readonly gameFolderFile: string | null;
}

type ArchiveValue = Pick<InstanceValue, 'files' | 'archiveContents' | 'loadsArchive' | 'stackedCopies' | 'dataFolderFiles'>;

export const archiveGotten = (value: ArchiveValue, origin: FileOrigin, enabled: boolean, file: OriginFile): boolean =>
  !isFileNotGotten(value, origin, enabled, file) && value.loadsArchive(file.relativePath);

export function unreadableArchiveReason(value: Pick<InstanceValue, 'archiveContents'>, file: OriginFile): string | undefined {
  const read = value.archiveContents.get(file.sourcePath);
  return read?.kind === 'unreadable' ? read.reason : undefined;
}

export function archivedFilesOf(value: ArchiveValue, origin: FileOrigin, enabled: boolean, file: OriginFile): ArchivedFileStanding[] {
  const contents = value.archiveContents.get(file.sourcePath);
  if (contents?.kind !== 'read') return [];
  const loaded = archiveGotten(value, origin, enabled, file);
  return contents.answer.map((path) => {
    const winner = value.stackedCopies.get(path)?.copies[0];
    const over = gameFolderFileOver(value, path);
    const winsEntry = winner !== undefined && over === undefined && sameOrigin(winner.origin, origin) && winner.at.kind === 'archived' && winner.at.archive === file.sourcePath;
    return { path, gotten: loaded && winsEntry, gameFolderFile: over ?? null };
  });
}
