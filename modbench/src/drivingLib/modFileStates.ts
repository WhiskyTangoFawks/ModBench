import type { Covering, FileOrigin, InstanceValue, Mod, OriginFile, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { copyStandingOf, fileOrderConflictOf, modOrigin, sameOrigin } from '../instanceLoader/fileConflictIndex';

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

export type IndicatorsValue = Pick<InstanceValue, 'mods' | 'modGroups' | 'filesByMod' | 'stackedCopies'>;

export function indicatorsOf(value: Pick<InstanceValue, 'stackedCopies'>, { name, updateAvailable }: Mod, files: readonly OriginFile[]): ModIndicator[] {
  const holds: Record<ModIndicator, boolean> = {
    ...copyStandingOf(value.stackedCopies, modOrigin(name)),
    containsExcludedFiles: files.some((file) => file.excluded),
    updateAvailable: updateAvailable === true,
  };
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
  return value.dataFolderFiles.kind === 'listed' ? value.dataFolderFiles.files.get(entry.toLowerCase())?.path : undefined;
}

export interface ArchivedEntryStanding {
  readonly path: string;
  /** Whether the game gets this copy: its archive is loaded, it wins the entry's stack, and no loose file in the game folder wins over it. */
  readonly gotten: boolean;
  readonly gameFolderFile: string | undefined;
}

type EntriesValue = Pick<InstanceValue, 'files' | 'archiveContents' | 'loadsArchive' | 'stackedCopies' | 'dataFolderFiles'>;

/** The entries of an archive file of `origin`, each with the standing the Mods view draws on its row: the grey and the tooltip. Empty for a file that is no archive mEdit read. */
export function archivedEntriesOf(value: EntriesValue, origin: FileOrigin, enabled: boolean, file: OriginFile): ArchivedEntryStanding[] {
  const contents = value.archiveContents.get(file.sourcePath);
  if (contents?.kind !== 'read') return [];
  const archiveGotten = !isFileNotGotten(value, origin, enabled, file) && value.loadsArchive(file.relativePath);
  return contents.answer.map((path) => {
    const winner = value.stackedCopies.get(path)?.copies[0];
    const gameFolderFile = gameFolderFileOver(value, path);
    const winsEntry = winner !== undefined && gameFolderFile === undefined && sameOrigin(winner.origin, origin) && winner.at.kind === 'archived' && winner.at.archive === file.sourcePath;
    return { path, gotten: archiveGotten && winsEntry, gameFolderFile };
  });
}
