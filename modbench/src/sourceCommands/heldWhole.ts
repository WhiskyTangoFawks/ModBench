import type { InstanceAdapter, ModFolder } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';

/** The `names` less each that `takes` and git holds whole, which are git's (ADR-0022): refused with `reason` when named, and
 *  passed over when the gesture runs on `everyMod`. */
export async function setAsideHeldWhole(
  adapter: Pick<InstanceAdapter, 'modFolderPath' | 'foldersHeldWhole'>, names: readonly string[], among: readonly ModFolder[] | undefined,
  { takes, everyMod, reason }: { takes: (name: string) => boolean; everyMod: boolean; reason: string },
): Promise<{ readonly rest: readonly string[]; readonly refused: readonly ItemRefusal<string>[] }> {
  const folders = await Promise.all(names.filter(takes).map(async (name) => [name, await adapter.modFolderPath(name, among)] as const));
  const held = await adapter.foldersHeldWhole(folders.flatMap(([, folder]) => (folder === undefined ? [] : [folder])));
  const heldNames = new Set(folders.flatMap(([name, folder]) => (folder !== undefined && held.has(folder) ? [name] : [])));
  return {
    rest: names.filter((name) => !heldNames.has(name)),
    refused: everyMod ? [] : [...heldNames].map((item) => ({ item, reason })),
  };
}
