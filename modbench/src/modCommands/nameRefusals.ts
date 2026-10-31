import { NOT_A_FOLDER_NAME } from '../coreLib/folderName';
import { isBareName, type EntryRef, type TakenNames } from '../instanceAdapter/instanceAdapter';

export const EMPTY_MOD_NAME = 'A mod name cannot be empty.';

const folderNameRefusal = (name: string): string | undefined => (isBareName(name) ? undefined : NOT_A_FOLDER_NAME);

/** Why a name cannot be given to a new mod, whatever its folders hold. */
export const newNameRefusal = (name: string): string | undefined => (name.trim() === '' ? EMPTY_MOD_NAME : folderNameRefusal(name));

/** One wording for create and install. */
export const modNameTakenRefusal = (name: string): string =>
  `A mod named "${name}" already exists. Install its next release from Downloads, or uninstall it to install anew.`;

/** How the manager matches an entry's name: two entries with one key are one name to it. */
export type EntryKey = (entry: EntryRef) => string;

export function newModNameRefusal(key: EntryKey, { modFolders }: TakenNames, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const notAFolder = folderNameRefusal(trimmed);
  if (notAFolder !== undefined) return notAFolder;
  const wanted = key({ kind: 'mod', name: trimmed });
  return modFolders?.some((folder) => key(folder) === wanted) ? modNameTakenRefusal(trimmed) : undefined;
}

export function entryNameRefusal(
  key: EntryKey, { mods, modFolders }: TakenNames, kind: EntryRef['kind'], requested: string, clash: string, own?: string,
): string | undefined {
  const notAFolder = folderNameRefusal(requested);
  if (notAFolder !== undefined) return notAFolder;
  const wanted = key({ kind, name: requested });
  if (own !== undefined && key({ kind, name: own }) === wanted) return undefined;
  return [...mods, ...(modFolders ?? [])].some((entry) => key(entry) === wanted) ? clash : undefined;
}
