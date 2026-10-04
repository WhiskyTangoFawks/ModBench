import type { Instance, InstanceValue } from './instanceLoader/instance';
import type { ModSync } from './mods/modSync';
import type { PluginSync } from './plugins/pluginSync';

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function modSyncOnEachValue(instance: Pick<Instance, 'subscribe'>, modSync: ModSync) {
  return instance.subscribe((value) => { void modSync.run(value.modSyncArguments); });
}

export function pluginSyncOnEachValue(instance: Pick<Instance, 'subscribe'>, pluginSync: PluginSync) {
  return instance.subscribe((value) => { void pluginSync.run(value.pluginSyncArguments); });
}

/** The command's Argument is the instance value. Without one there is no value to sync, so it does
 *  nothing: a command never reads the Instance loader. */
export const modSyncCommand = (modSync: ModSync) => async (value?: InstanceValue): Promise<void> => {
  if (value !== undefined) await modSync.run(value.modSyncArguments);
};

export const pluginSyncCommand = (pluginSync: PluginSync) => async (value?: InstanceValue): Promise<void> => {
  if (value !== undefined) await pluginSync.run(value.pluginSyncArguments);
};
