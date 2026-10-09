import { createSync, type Sync, type SyncChannel } from './drivingLib/syncFailureReport';
import type { Instance, InstanceValue, ModSyncArguments, PluginSyncArguments } from './instanceLoader/instance';
import type { ModSyncResult } from './modlist/modlist';
import type { PluginSyncResult } from './pluginsCommands/plugins';

export interface InstanceSyncs {
  dispose(): void;
  modSync: Sync<ModSyncArguments>;
  pluginSync: Sync<PluginSyncArguments>;
}

interface InstanceSyncsDeps {
  instance: Pick<Instance, 'subscribe' | 'value'>;
  syncMods: (args: ModSyncArguments) => Promise<ModSyncResult>;
  syncPlugins: (args: PluginSyncArguments) => Promise<PluginSyncResult>;
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function instanceSyncs({ instance, syncMods, syncPlugins, channel }: InstanceSyncsDeps): InstanceSyncs {
  const { modOrderFile } = instance.value.managerNames;
  const modSync = createSync(syncMods, channel, {
    command: 'mod sync',
    prefix: '[modlist]',
    unsynced: `${modOrderFile} is not synced`,
    added: `${modOrderFile} line(s) for folder(s) in mods/ with no line`,
    dropped: `${modOrderFile} line(s) whose folder is gone from mods/`,
  });
  const pluginSync = createSync(syncPlugins, channel, {
    command: 'plugin sync',
    prefix: '[pluginsCommands]',
    unsynced: 'plugins.txt is not synced',
    added: 'disabled plugins.txt line(s) for plugin(s) on disk with no line',
    dropped: 'plugins.txt line(s) with no plugin on disk',
  });
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
