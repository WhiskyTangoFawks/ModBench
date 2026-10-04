import type { InstanceValue, Mod, ModlistEntry, OriginFile, OriginFolder } from '../../instanceLoader/instance';
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
export async function indexedValueOf(
  mods: ModlistEntry[],
  listings: Record<string, { files: OriginFile[]; folders?: OriginFolder[] }>,
  overwrite: { files: OriginFile[]; folders?: OriginFolder[] } = { files: [] },
): Promise<InstanceValue> {
  const adapter: Parameters<typeof buildFileConflictIndex>[2] = {
    originFiles: (origin) => {
      const name = origin.kind === 'mod' ? origin.name : 'overwrite';
      const listing = listings[name] ?? { files: [] };
      return Promise.resolve({ origin: name, folder: `/instance/${name}`, files: listing.files, folders: listing.folders ?? [], notes: [] });
    },
  };
  const index = await buildFileConflictIndex(mods, overwrite.files, adapter, () => undefined);
  return instanceValueFixture({
    mods, files: index.files, filesByMod: index.filesByMod, foldersByMod: index.foldersByMod,
    overwriteFiles: overwrite.files, overwriteFolders: overwrite.folders ?? [],
  });
}
