// What a row says of its mod's status against its manifest (modlist-repository.md, Status).

import type { ModStatus } from '../manifestAdapter/manifestAdapter';

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// modlist-repository.md, Status, stories 1 and 6.
const differs = ({ differing, namedByNoLine, gone, metadataDiffers }: ModStatus): boolean => differing.length + namedByNoLine.length + gone.length > 0 || metadataDiffers;

function stateOf(status: ModStatus): string | undefined {
  if (status.noManifest) return 'no manifest';
  return differs(status) ? 'differs' : undefined;
}

const countedFiles = (files: readonly string[], phrase: string): string | undefined =>
  files.length > 0 ? `${counted(files.length, 'file', 'files')} its package ${phrase}` : undefined;

/** What a mod row's description says of its status (mods.md, A row, Mod). */
export function statusDescription(status: ModStatus): string | undefined {
  const state = stateOf(status);
  const notHeld = countedFiles(status.notInPackage, 'does not hold');
  const otherBytes = countedFiles(status.otherBytes, 'holds with other bytes');
  const noHost = status.noHost ? 'its package has no host' : undefined;
  return [state, notHeld, otherBytes, noHost].filter((part) => part !== undefined).join(' · ') || undefined;
}

/** What a separator row's description says of its status (mods.md, A row, Separator). */
export const separatorDescription = stateOf;

/** What a mod row's tooltip says of the files its folder lacks (modlist-repository.md, Status, story 4). */
export const lackedLine = ({ gone }: ModStatus): string | undefined =>
  (gone.length > 0 ? `its folder lacks ${counted(gone.length, 'file', 'files')} its manifest names` : undefined);

/** Each file of the mod whose row says differs, by its path on disk. */
export const differingFiles = ({ differing, namedByNoLine }: ModStatus): ReadonlySet<string> => new Set([...differing, ...namedByNoLine]);

/** Whether the mod counts in the view's badge (modlist-repository.md, Status, story 5). */
export const countsInBadge = (status: ModStatus): boolean => status.noManifest || differs(status);
