import type { EntryRef, TakenNames } from '../instanceAdapter/instanceAdapter';

export type { TakenNames };

/** The refusal of a mod named by blanks. */
export const EMPTY_MOD_NAME = 'A mod name cannot be empty.';

/** The refusal of a new mod whose name a folder already holds: one wording for create and install. */
export const modNameTakenRefusal = (name: string): string =>
  `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;

/** How the manager matches an entry's name: two entries with one key are one name to it. */
export type EntryKey = (entry: EntryRef) => string;

/** Why a new mod may not take `name`, trimmed: a folder already holds an entry under its key.
 *  Undefined for a free name, or a blank one. */
export function newModNameRefusal(key: EntryKey, { modFolders }: TakenNames, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const wanted = key({ kind: 'mod', name: trimmed });
  return modFolders?.some((folder) => key(folder) === wanted) ? modNameTakenRefusal(trimmed) : undefined;
}

/** `clash` when an entry is listed or has a folder under the key `requested` has as `kind`;
 *  `own`, the entry being renamed, is no clash. */
export function entryNameRefusal(
  key: EntryKey, { mods, modFolders }: TakenNames, kind: EntryRef['kind'], requested: string, clash: string, own?: string,
): string | undefined {
  const wanted = key({ kind, name: requested });
  if (own !== undefined && key({ kind, name: own }) === wanted) return undefined;
  return [...mods, ...(modFolders ?? [])].some((entry) => key(entry) === wanted) ? clash : undefined;
}

/** The refusal of a mark on a file that is gone. */
export const goneFromDisk = (name: string): string => `"${name}" is gone from disk.`;
