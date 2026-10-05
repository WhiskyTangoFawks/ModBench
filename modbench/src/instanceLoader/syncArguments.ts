import type { ModFolder } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from './instance';
import { providedPluginsOf, type DataFolderPlugins } from './loadOrderSnapshot';

/** Mod sync's inputs: the profile it writes and the mod folders it compares with. */
export interface ModSyncArguments {
  readonly profile: string;
  readonly modFolders: readonly ModFolder[] | undefined;
}

/** Plugin sync's inputs: the profile it writes, the plugins the instance provides, what the Data
 *  folder holds and the plugins the game loads with no line. */
export interface PluginSyncArguments {
  readonly profile: string;
  readonly provided: ReadonlyMap<string, string>;
  readonly inData: DataFolderPlugins;
  readonly loadedWithNoLine: readonly string[] | undefined;
}

type SyncSource = Pick<InstanceValue, 'activeProfile' | 'modFolders' | 'files' | 'dataFolderPlugins' | 'pluginsLoadedWithNoLine'>;

export function modSyncArgumentsOf(source: SyncSource): ModSyncArguments {
  return { profile: source.activeProfile, modFolders: source.modFolders };
}

export function pluginSyncArgumentsOf(source: SyncSource): PluginSyncArguments {
  return {
    profile: source.activeProfile,
    provided: providedPluginsOf(source.files),
    inData: source.dataFolderPlugins,
    loadedWithNoLine: source.pluginsLoadedWithNoLine?.map((plugin) => plugin.name),
  };
}
