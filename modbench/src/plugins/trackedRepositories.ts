import type { PluginMetadata } from '../client';

/** Whether a mod folder is tracked. Injected: the Instance adapter answers it, and this box holds
 *  no door onto the instance of its own (ADR-0007). */
export type IsTracked = (modFolder: string) => Promise<boolean>;

/** The folder a plugin sits in. Injected: the Instance adapter owns every path function. */
export type PluginFolder = (pluginFile: string) => string;

/** Distinct, not one per plugin: a folder can hold several plugins, and each must register with
 *  `vscode.git` exactly once. */
export async function trackedModFoldersOf(
  plugins: readonly Pick<PluginMetadata, 'path'>[], isTracked: IsTracked, pluginFolder: PluginFolder,
): Promise<string[]> {
  const folders = new Set<string>();
  for (const folder of new Set(plugins.map((p) => pluginFolder(p.path)))) {
    if (await isTracked(folder)) folders.add(folder);
  }
  return [...folders];
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
export function pluginAddressKey(name: string, origin: string | undefined): string {
  return `${(origin ?? '').toLowerCase()}|${name.toLowerCase()}`;
}

/** Reindexed by plugin because a field edit knows the plugin it edited, never the folder. */
export function pluginRepositoriesOf<T>(
  plugins: readonly Pick<PluginMetadata, 'name' | 'origin' | 'path'>[],
  folderRepositories: ReadonlyMap<string, T>,
  pluginFolder: PluginFolder,
): Map<string, T> {
  const byPlugin = new Map<string, T>();
  for (const plugin of plugins) {
    const repository = folderRepositories.get(pluginFolder(plugin.path));
    if (repository) byPlugin.set(pluginAddressKey(plugin.name, plugin.origin), repository);
  }
  return byPlugin;
}
