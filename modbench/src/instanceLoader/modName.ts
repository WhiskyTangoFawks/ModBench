import type { EntryRef, ModFolders, ModlistEntry } from '../instanceAdapter/instanceAdapter';

const keyOf = ({ kind, name }: EntryRef): string => `${kind}:${name}`;

/** The name the mod manager knows each entry's folder's mod by, the folder matched as it matches names. */
export const modNamesOf = (entries: readonly ModlistEntry[], folders: ModFolders | undefined): ReadonlyMap<string, string> =>
  new Map(entries.flatMap((entry) => {
    const folder = folders?.holding(entry);
    return folder === undefined ? [] : [[keyOf(entry), folder.modName] as const];
  }));

/** The name mEdit and the gestures know `entry` by: its folder's mod name, which a separator's name is not; undefined
 *  when it has no folder. */
export const modNameOf = (modNames: ReadonlyMap<string, string>, entry: EntryRef): string | undefined => modNames.get(keyOf(entry));
