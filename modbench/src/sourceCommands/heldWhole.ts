import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

// ADR-0022: a folder git holds whole is git's, so no manifest records it and none restores it.
export async function modsHeldWhole(adapter: Pick<InstanceAdapter, 'modFolderPath' | 'foldersHeldWhole'>, mods: readonly string[]): Promise<ReadonlySet<string>> {
  const folders = await Promise.all(mods.map(async (mod) => [mod, await adapter.modFolderPath(mod)] as const));
  const held = await adapter.foldersHeldWhole(folders.flatMap(([, folder]) => (folder === undefined ? [] : [folder])));
  return new Set(folders.flatMap(([mod, folder]) => (folder !== undefined && held.has(folder) ? [mod] : [])));
}
