import type { Instance } from '../instanceLoader/instance';
import { createModSync, type ModSync } from '../mods/modSync';
import { createPluginSync, type PluginSync } from '../plugins/pluginSync';
import type { SyncChannel } from '../drivingLib/syncFailureReport';
import { modSyncOnEachValue, pluginSyncOnEachValue } from '../syncWiring';

export function wireModSync(
  instance: Pick<Instance, 'subscribe' | 'value'>, sync: Parameters<typeof createModSync>[0], channel: SyncChannel,
): ModSync {
  const modSync = createModSync(sync, channel, instance.value.managerNames.modOrderFile);
  modSyncOnEachValue(instance, modSync);
  return modSync;
}

export function wirePluginSync(
  instance: Pick<Instance, 'subscribe'>, sync: Parameters<typeof createPluginSync>[0], channel: SyncChannel,
): PluginSync {
  const pluginSync = createPluginSync(sync, channel);
  pluginSyncOnEachValue(instance, pluginSync);
  return pluginSync;
}
