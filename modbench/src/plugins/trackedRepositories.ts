import type { PluginMetadata } from '../client';

/** The tracked folder a plugin file sits in, undefined when it sits in none. Injected: the Instance
 *  adapter answers it, and this box holds no door onto the instance of its own (ADR-0007). */
export type TrackedFolderOf = (pluginFile: string) => Promise<string | undefined>;

/** Each plugin's tracked folder, by `pluginAddressKey`; a plugin in none has no entry. */
export async function trackedFoldersOf(
  plugins: readonly Pick<PluginMetadata, 'name' | 'origin' | 'path'>[], trackedFolderOf: TrackedFolderOf,
): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  for (const plugin of plugins) {
    const folder = await trackedFolderOf(plugin.path);
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
