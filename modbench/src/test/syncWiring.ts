import type { Instance } from '../instanceLoader/instance';
import { createModSync, type ModSync } from '../mods/modSync';
import { createPluginSync, type PluginSync } from '../plugins/pluginSync';

type Channel = { error(msg: string): void; info(msg: string): void };

/** What the composition root does: each landed value fires the sync with the arguments it carries. */
export function wireModSync(
  instance: Pick<Instance, 'subscribe' | 'value'>, sync: Parameters<typeof createModSync>[0], channel: Channel,
): ModSync {
  const modSync = createModSync(sync, channel, instance.value.managerNames.modOrderFile);
  instance.subscribe((value) => { modSync.run(value.modSyncArguments); });
  return modSync;
}

export function wirePluginSync(
  instance: Pick<Instance, 'subscribe'>, sync: Parameters<typeof createPluginSync>[0], channel: Channel,
): PluginSync {
  const pluginSync = createPluginSync(sync, channel);
  instance.subscribe((value) => { pluginSync.run(value.pluginSyncArguments); });
  return pluginSync;
}
