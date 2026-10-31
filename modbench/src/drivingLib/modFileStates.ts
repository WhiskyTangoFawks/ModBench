import type { Covering, FileOrigin, InstanceValue, Mod, OriginFile, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { fileOrderConflictOf, modOrigin, outranksACopy, winsPath } from '../instanceLoader/fileConflictIndex';

/** Each indicator in the order mods.md's table lists them, with its name there.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const MOD_INDICATORS = [
  { id: 'overwritesLooseFiles', name: 'Overwrites loose files', badge: '⊕', colour: 'modbench.modOverwritesLooseFiles' },
  { id: 'overwrittenLooseFiles', name: 'Overwritten loose files', badge: '⊖', colour: 'modbench.modOverwrittenLooseFiles' },
  { id: 'redundant', name: 'Redundant', badge: '⊗', colour: 'modbench.modRedundant' },
  { id: 'containsExcludedFiles', name: 'Contains excluded files', badge: '⊘', colour: 'modbench.modContainsExcludedFiles' },
  { id: 'updateAvailable', name: 'Update available', badge: '↑', colour: 'modbench.modUpdateAvailable' },
] as const;

export type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

export type IndicatorsValue = Pick<InstanceValue, 'mods' | 'modGroups' | 'files' | 'filesByMod'>;

export function indicatorsOf(value: Pick<InstanceValue, 'files'>, { name, updateAvailable }: Mod, files: readonly OriginFile[]): ModIndicator[] {
  const own = modOrigin(name);
  const entries = files.filter((file) => !file.excluded).map((file) => value.files.get(file.relativePath));
  const gets = entries.some((entry) => winsPath(entry, own));
  const loses = entries.some((entry) => fileOrderConflictOf(entry, own) === 'loses');
  const redundant = loses && !gets;
  const holds: Record<ModIndicator, boolean> = {
    overwritesLooseFiles: entries.some((entry) => outranksACopy(entry, own)),
    overwrittenLooseFiles: loses && !redundant,
    redundant,
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
