import type { EntryRef, ModFolder, ModlistEntry } from '../instanceAdapter/instanceAdapter';

/** The name mEdit and the gestures know `entry` by, held in `folder`: a mod's own, a separator's folder's, so a mod and a
 *  separator that share a name stay two. */
export const modNameIn = ({ modName }: ModFolder, { kind, name }: EntryRef): string => (kind === 'mod' ? name : modName);

/** The name of a mod order entry; undefined for a separator with no folder. */
export function modNameOf(folders: readonly ModFolder[] | undefined, entry: ModlistEntry): string | undefined {
  if (entry.kind === 'mod') return entry.name;
  const folder = folders?.find(({ kind, name }) => kind === 'separator' && name === entry.name);
  return folder === undefined ? undefined : folder.modName;
}
