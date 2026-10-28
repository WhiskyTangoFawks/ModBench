import { isWithin } from './gameFolder/pathWithin';

export interface FolderRefusal { readonly item: string; readonly reason: string }

/** The manifests among `asked` whose folder restore refuses, each with why (modlist-repository.md, Restore from manifest,
 *  stories 13 and 14). `folders` is every manifest's folder, so an asked one is compared with those it was not asked with. */
export async function foldersRefused(
  instanceRoot: string, folders: ReadonlyMap<string, string>, asked: readonly string[],
): Promise<FolderRefusal[]> {
  const refusals: FolderRefusal[] = [];
  for (const item of asked) {
    const folder = folders.get(item);
    if (folder === undefined) continue;
    const why: string[] = [];
    if (!await isWithin(instanceRoot, folder)) why.push(`its folder '${folder}' is outside the instance folder`);
    for (const [other, otherFolder] of folders) {
      if (other === item) continue;
      const [inside, holds] = [await isWithin(otherFolder, folder), await isWithin(folder, otherFolder)];
      if (inside && holds) why.push(`its folder is also built by '${other}'`);
      else if (inside) why.push(`its folder is inside the folder of '${other}'`);
      else if (holds) why.push(`its folder holds the folder of '${other}'`);
    }
    if (why.length > 0) refusals.push({ item, reason: `was skipped: ${why.join('; ')}.` });
  }
  return refusals;
}
