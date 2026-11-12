import type { Covering, FileOrigin, InstanceValue, Mod, OriginFile, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { copyStandingOf, fileOrderConflictOf, modOrigin } from '../instanceLoader/fileConflictIndex';

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
