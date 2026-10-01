import type { PluginMetadata } from '../client';

/** Each plugin's tracked folder, by `pluginAddressKey`; a plugin whose origin is not a tracked mod
 *  has no entry. A lookup over the Instance value's own two facts, never a fresh disk check
 *  (ADR-0007). */
export function trackedFoldersOf(
  plugins: readonly Pick<PluginMetadata, 'name' | 'origin'>[],
  trackedMods: ReadonlySet<string>,
  modDirs: ReadonlyMap<string, string>,
): Map<string, string> {
  const folders = new Map<string, string>();
  for (const plugin of plugins) {
    if (!trackedMods.has(plugin.origin)) continue;
    const folder = modDirs.get(plugin.origin);
    if (folder !== undefined) folders.set(pluginAddressKey(plugin.name, plugin.origin), folder);
  }
  return folders;
}

/** Deduplicates its input as a contract of its own, not as a property of one caller. A folder
 *  whose `openRepository` resolves `null` is omitted, so a later `.status()` can never land on a
 *  null handle. */
export async function registerTrackedRepositories<T>(
  openRepository: (modFolder: string) => Promise<T | null | undefined>,
  modFolders: readonly string[],
): Promise<Map<string, T>> {
  const distinct = [...new Set(modFolders)];
  const repositories = new Map<string, T>();
  for (const folder of distinct) {
    const repository = await openRepository(folder);
    if (repository != null) repositories.set(folder, repository);
  }
  return repositories;
}

/** ADR-0012 invariant 1: a plugin is `(origin, filename)` on every map key. */
export function pluginAddressKey(name: string, origin: string): string {
  return `${origin.toLowerCase()}|${name.toLowerCase()}`;
}

/** Reindexed by plugin because a field edit knows the plugin it edited, never the folder. */
export function pluginRepositoriesOf<T>(
  folders: ReadonlyMap<string, string>, folderRepositories: ReadonlyMap<string, T>,
): Map<string, T> {
  const byPlugin = new Map<string, T>();
  for (const [plugin, folder] of folders) {
    const repository = folderRepositories.get(folder);
    if (repository) byPlugin.set(plugin, repository);
  }
  return byPlugin;
}
