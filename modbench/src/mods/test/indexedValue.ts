import type { InstanceValue, Mod, OriginFile, OriginFolder } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { buildFileConflictIndex, indexReusing, stackReusing, type LoadedArchive } from '../../instanceLoader/fileConflictIndex';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

export const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });

export const file = (origin: string, relativePath: string, excluded = false): OriginFile => {
  const path = `/instance/${origin}/${relativePath}`;
  return { relativePath, path, sourcePath: path, excluded, markedExcluded: excluded, includedPath: relativePath };
};

export const folder = (origin: string, relativePath: string, excluded = false): OriginFolder =>
  ({ relativePath, path: `/instance/${origin}/${relativePath}`, includedPath: relativePath, excluded });

const NO_FOLDERS: readonly OriginFolder[] = [];

/** An instance value over these mods and their files, and the archives the game loads, indexed and stacked as the
 *  Instance loader does: a mod lists each archive of its own the game loads, and what it holds is read. */
export function indexedValueOf(
  mods: ModlistEntry[],
  listings: Record<string, { files: OriginFile[]; folders?: OriginFolder[] }>,
  overwrite: { files: OriginFile[]; folders?: OriginFolder[] } = { files: [] },
  loaded: readonly LoadedArchive[] = [],
): Promise<InstanceValue> {
  const archivesOf = (name: string, files: readonly OriginFile[]): OriginFile[] => loaded.flatMap(({ origin, archive }) => {
    const relativePath = archive.slice(`/instance/${name}/`.length);
    return origin.kind === 'mod' && origin.name === name && !files.some((held) => held.sourcePath === archive) ? [file(name, relativePath)] : [];
  });
  const modFiles = new Map(mods.flatMap((entry) => {
    if (entry.kind !== 'mod') return [];
    const listing = listings[entry.name] ?? { files: [] };
    const archives = archivesOf(entry.name, listing.files);
    const files = archives.length === 0 ? listing.files : [...listing.files, ...archives];
    return [[entry.name, { origin: entry.name, folder: `/instance/${entry.name}`, files, folders: listing.folders ?? NO_FOLDERS, notes: [] }] as const];
  }));
  const index = buildFileConflictIndex(mods, overwrite.files, modFiles);
  return Promise.resolve(instanceValueFixture({
    mods, files: index.files, filesByMod: index.filesByMod, foldersByMod: index.foldersByMod, stackedCopies: stackReusing()(index, loaded, 'Fallout4'),
    overwriteFiles: overwrite.files, overwriteFolders: overwrite.folders ?? [],
    archiveContents: new Map(loaded.flatMap(({ archive, files }) => (files === undefined ? [] : [[archive, { kind: 'read', answer: files }] as const]))),
  }));
}

/** Instance values over `mods`, each built from the one before as the Instance loader builds the next: a file that reads the
 *  same keeps its object, and so does every part the change leaves as it was. */
export function indexedValues(mods: ModlistEntry[]): (listings: Record<string, { files: OriginFile[]; folders?: OriginFolder[] }>) => InstanceValue {
  const index = indexReusing();
  const stack = stackReusing();
  const loaded: readonly LoadedArchive[] = [];
  const overwrite: OriginFile[] = [];
  let held = instanceValueFixture({ mods });
  return (listings) => {
    const modFiles = new Map(mods.flatMap((entry) => {
      const listing = entry.kind === 'mod' ? listings[entry.name] : undefined;
      return listing === undefined ? [] : [[entry.name, { origin: entry.name, folder: `/instance/${entry.name}`, files: listing.files, folders: listing.folders ?? NO_FOLDERS, notes: [] }] as const];
    }));
    const built = index(mods, overwrite, modFiles);
    held = { ...held, files: built.files, filesByMod: built.filesByMod, foldersByMod: built.foldersByMod, stackedCopies: stack(built, loaded, 'Fallout4') };
    return held;
  };
}
