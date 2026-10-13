import type { EntryRef, ModFolder } from '../instanceAdapter/instanceAdapter';

/** The refusal of a new mod whose name a folder already holds: one wording for create and install. */
export const modNameTakenRefusal = (name: string): string =>
  `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;

/** The names a prompt checks, as the instance value reads them; the write stays the authority.
 *  `modFolders` is undefined when there is no folder for mods at all. */
export interface TakenNames {
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Why a new mod may not take `name`, trimmed: a folder already holds a mod of that name, or is
 *  named so (a separator's folder), compared without case. Undefined for a free name, or a blank one. */
export function newModNameRefusal({ modFolders }: TakenNames, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return modFolders?.some((folder) => sameName(folder.folderName, trimmed)) ? modNameTakenRefusal(trimmed) : undefined;
}

/** `clash` when another entry of `kind` is listed or has a folder under `requested`, compared
 *  without case; `own`, the entry being renamed, is no clash. */
export function entryNameRefusal(
  { mods, modFolders }: TakenNames, kind: EntryRef['kind'], requested: string, clash: string, own?: string,
): string | undefined {
  if (own !== undefined && sameName(own, requested)) return undefined;
  return [...mods, ...(modFolders ?? [])].some((entry) => entry.kind === kind && sameName(entry.name, requested)) ? clash : undefined;
}

/** The refusal of a mark on a file that is gone. */
export const goneFromDisk = (name: string): string => `"${name}" is gone from disk.`;
