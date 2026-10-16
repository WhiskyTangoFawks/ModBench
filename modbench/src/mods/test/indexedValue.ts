import type { InstanceValue, Mod, OriginFile, OriginFolder } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { buildFileConflictIndex } from '../../instanceLoader/fileConflictIndex';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

export const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

export const file = (origin: string, relativePath: string, excluded = false): OriginFile => {
  const path = `/instance/${origin}/${relativePath}`;
  return { relativePath, path, sourcePath: path, excluded, excludedByName: excluded };
};

export const folder = (origin: string, relativePath: string, excluded = false): OriginFolder =>
  ({ relativePath, path: `/instance/${origin}/${relativePath}`, excluded });

/** An instance value over these mods, each listing these files, indexed as the Instance loader
 *  indexes them. */
export function indexedValueOf(
  mods: ModlistEntry[],
  listings: Record<string, { files: OriginFile[]; folders?: OriginFolder[] }>,
  overwrite: { files: OriginFile[]; folders?: OriginFolder[] } = { files: [] },
): Promise<InstanceValue> {
  const modFiles = new Map(mods.flatMap((entry) => {
    if (entry.kind !== 'mod') return [];
    const listing = listings[entry.name] ?? { files: [] };
    return [[entry.name, { origin: entry.name, folder: `/instance/${entry.name}`, files: listing.files, folders: listing.folders ?? [], notes: [] }] as const];
  }));
  const index = buildFileConflictIndex(mods, overwrite.files, modFiles, () => undefined);
  return Promise.resolve(instanceValueFixture({
    mods, files: index.files, filesByMod: index.filesByMod, foldersByMod: index.foldersByMod,
    overwriteFiles: overwrite.files, overwriteFolders: overwrite.folders ?? [],
  }));
}
