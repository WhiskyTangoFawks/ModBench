import type { EntryRef, ModFolder, ModFolders, ModlistEntry } from '../instanceAdapter/instanceAdapter';

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

/** What a person or an agent reads for the mod the mod manager knows by a name: a mod's name, and a separator as a
 *  separator by its name, never by its folder's name. A name no folder holds reads as it is. */
export const modLabelsOf = (folders: readonly ModFolder[] | undefined): ((modName: string) => string) => {
  const separators = new Map((folders ?? []).filter(({ kind }) => kind === 'separator').map(({ modName, name }) => [modName, name]));
  return (modName) => {
    const separator = separators.get(modName);
    return separator === undefined ? modName : `separator ${separator}`;
  };
};
