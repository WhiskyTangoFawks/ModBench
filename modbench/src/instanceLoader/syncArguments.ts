import type { ModFolder, PluginEntry } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from './instance';
import { providedPluginsOf, type DataFolderPlugins } from './loadOrderSnapshot';

/** Mod sync's inputs: the profile it writes and the mod folders it compares with. */
export interface ModSyncArguments {
  readonly profile: string;
  readonly modFolders: readonly ModFolder[] | undefined;
}

/** Plugin sync's inputs: the profile it writes, the plugin order the value read, the plugins the
 *  instance provides, what the Data folder holds and the plugins the game loads with no line. */
export interface PluginSyncArguments {
  readonly profile: string;
  readonly pluginOrder: readonly PluginEntry[];
  readonly provided: ReadonlyMap<string, string>;
  readonly inData: DataFolderPlugins;
  readonly loadedWithNoLine: readonly string[] | undefined;
}

export function modSyncArgumentsOf(source: Pick<InstanceValue, 'activeProfile' | 'modFolders'>): ModSyncArguments {
  return { profile: source.activeProfile, modFolders: source.modFolders };
}

type PluginSyncSource = Pick<InstanceValue, 'activeProfile' | 'files' | 'dataFolderPlugins' | 'pluginsLoadedWithNoLine'>
  & { readonly pluginOrder: readonly PluginEntry[] };

export function pluginSyncArgumentsOf(source: PluginSyncSource): PluginSyncArguments {
  return {
    profile: source.activeProfile,
    pluginOrder: source.pluginOrder,
    provided: providedPluginsOf(source.files),
    inData: source.dataFolderPlugins,
    loadedWithNoLine: source.pluginsLoadedWithNoLine?.map((plugin) => plugin.name),
  };
}
