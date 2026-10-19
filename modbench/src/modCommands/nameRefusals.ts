import type { EntryRef, TakenNames } from '../instanceAdapter/instanceAdapter';

export const EMPTY_MOD_NAME = 'A mod name cannot be empty.';

export const modNameTakenRefusal = (name: string): string =>
  `A mod named "${name}" already exists. Install its next release from Downloads, or uninstall it to install anew.`;

export type EntryKey = (entry: EntryRef) => string;

export function unclaimedModName(key: EntryKey, { modFolders }: TakenNames, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const wanted = key({ kind: 'mod', name: trimmed });
  return modFolders?.some((folder) => key(folder) === wanted) ? modNameTakenRefusal(trimmed) : undefined;
}

export function entryNameRefusal(
  key: EntryKey, { mods, modFolders }: TakenNames, kind: EntryRef['kind'], requested: string, clash: string, own?: string,
): string | undefined {
  const wanted = key({ kind, name: requested });
  if (own !== undefined && key({ kind, name: own }) === wanted) return undefined;
  return [...mods, ...(modFolders ?? [])].some((entry) => key(entry) === wanted) ? clash : undefined;
}
