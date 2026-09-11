import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginMetadata } from './client';

// ADR-0007: tracked *is* the presence of `.git` — a filesystem check, no registry, no backend.
function isTracked(modFolder: string): boolean {
  return fs.existsSync(path.join(modFolder, '.git'));
}

function modFolderOf(plugin: Pick<PluginMetadata, 'path'>): string {
  return path.dirname(plugin.path);
}

/** Distinct, not one per plugin: a folder can hold several plugins, and each must register with
 *  `vscode.git` exactly once. */
export function trackedModFoldersOf(plugins: readonly Pick<PluginMetadata, 'path'>[]): string[] {
  const folders = new Set<string>();
  for (const plugin of plugins) {
    const folder = modFolderOf(plugin);
    if (isTracked(folder)) folders.add(folder);
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

/** Reindexed by filename because a field edit knows the plugin it edited, never the folder.
 *  Filename is unique among plugins an edit can reach: a file-level loser is read-only
 *  (ADR-0012). */
export function pluginRepositoriesOf<T>(
  plugins: readonly Pick<PluginMetadata, 'name' | 'path'>[],
  folderRepositories: ReadonlyMap<string, T>,
): Map<string, T> {
  const byPlugin = new Map<string, T>();
  for (const plugin of plugins) {
    const repository = folderRepositories.get(modFolderOf(plugin));
    if (repository) byPlugin.set(plugin.name, repository);
  }
  return byPlugin;
}
