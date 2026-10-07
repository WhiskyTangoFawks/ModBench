import type { SyncChannel } from './drivingLib/syncFailureReport';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { createModSync, type ModSync } from './mods/modSync';
import { createPluginSync, type PluginSync } from './plugins/pluginSync';

export interface InstanceSyncs {
  dispose(): void;
  modSync: ModSync;
  pluginSync: PluginSync;
}

interface InstanceSyncsDeps {
  instance: Pick<Instance, 'subscribe' | 'value'>;
  syncMods: Parameters<typeof createModSync>[0];
  syncPlugins: Parameters<typeof createPluginSync>[0];
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function instanceSyncs({ instance, syncMods, syncPlugins, channel }: InstanceSyncsDeps): InstanceSyncs {
  const modSync = createModSync(syncMods, channel, instance.value.managerNames.modOrderFile);
  const pluginSync = createPluginSync(syncPlugins, channel);
  const subscription = instance.subscribe((value) => {
    void modSync.run(value.modSyncArguments);
    void pluginSync.run(value.pluginSyncArguments);
  });
  return { modSync, pluginSync, dispose: () => { subscription.dispose(); } };
}

type LoadOrderPut = (value: InstanceValue) => void;

export function loadOrderPutHandler(editing: { onRecompute: LoadOrderPut }): LoadOrderPut {
  return (value) => { editing.onRecompute(value); };
}

export function loadOrderPutOnEachValue(instance: Pick<Instance, 'subscribe'>, put: LoadOrderPut) {
  return instance.subscribe(put);
}
