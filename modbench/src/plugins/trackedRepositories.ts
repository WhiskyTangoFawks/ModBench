import * as vscode from 'vscode';
import type { MEditClient, PluginMetadata } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { pluginAddressKey } from './pluginAddress';

/** Each plugin's tracked folder, by `pluginAddressKey`; a plugin whose origin is not a tracked mod
 *  has no entry. A lookup over the Instance value's own two facts, never a fresh disk check. */
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

/** The one shape this extension needs from a `vscode.git` `Repository`: `status()`. */
export interface MinimalRepository {
  status(): Thenable<unknown>;
}
// Deliberately not the full upstream `git.d.ts`, just the members called, so nothing here can
// drift against an API this extension otherwise never touches. `openRepository` resolves `null`
// for "declined to open".
interface MinimalGitApi {
  openRepository(uri: vscode.Uri): Thenable<MinimalRepository | null>;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/** Where the tracked repositories come from and where a failure is told. */
export interface TrackedRepositoriesDeps {
  readonly client: Pick<MEditClient, 'getPlugins'>;
  readonly outputChannel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>;
  /** The Instance value's own two facts this needs, read fresh at call time. */
  readonly trackedMods: () => ReadonlySet<string>;
  readonly modDirs: () => ReadonlyMap<string, string>;
}

export interface TrackedRepositories {
  /** A computed reconcile's notice, which a landed track gives too: tells the open record panels,
   *  then registers each tracked mod's repository with `vscode.git`, once per notice. */
  conflictsComputedOver: (announce: () => void) => () => Promise<void>;
  /** `Repository.status()`, the same effect the SCM panel's Refresh button has, fired from the
   *  edit rather than waiting on the native watcher. A plugin with no handle is a silent no-op; a
   *  rejected `status()` is logged, never surfaced. */
  refreshSourceControlFor: (plugin: string, origin: string) => void;
}

/** The session's tracked repositories by plugin, held here and refilled by each registration. */
export function trackedRepositoriesOver(deps: TrackedRepositoriesDeps): TrackedRepositories {
  let byPlugin = new Map<string, MinimalRepository>();

  // One `openRepository` per distinct tracked folder (ADR-0007). A logged no-op when `vscode.git` is
  // unavailable: this only narrows the native UI, never blocks reading or editing.
  async function registerHeld(): Promise<void> {
    const { client, outputChannel, trackedMods, modDirs } = deps;
    try {
      const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
      if (!gitExtension) {
        outputChannel.warn('[extension] vscode.git extension not found — tracked mods will not appear in Source Control');
        return;
      }
      const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
      const gitApi = exports.getAPI(1);

      const plugins = await client.getPlugins();
      const folders = trackedFoldersOf(plugins, trackedMods(), modDirs());
      const folderRepositories = await registerTrackedRepositories(
        (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), [...folders.values()]);
      byPlugin = pluginRepositoriesOf(folders, folderRepositories);
    } catch (err) {
      outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${errorMessage(err)}`);
    }
  }

  return {
    conflictsComputedOver: (announce) => async () => {
      announce();
      await registerHeld();
    },
    refreshSourceControlFor: (plugin, origin) => {
      const repo = byPlugin.get(pluginAddressKey(plugin, origin));
      if (!repo) return;
      void repo.status().then(undefined, (err: unknown) => {
        deps.outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${errorMessage(err)}`);
      });
    },
  };
}
