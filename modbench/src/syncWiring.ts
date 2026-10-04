import type { Sync } from './drivingLib/syncFailureReport';
import type { Instance, ModSyncArguments, PluginSyncArguments } from './instanceLoader/instance';

type ModSync = Pick<Sync<ModSyncArguments>, 'run'>;
type PluginSync = Pick<Sync<PluginSyncArguments>, 'run'>;

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function modSyncOnEachValue(instance: Pick<Instance, 'subscribe'>, modSync: ModSync) {
  return instance.subscribe((value) => { void modSync.run(value.modSyncArguments); });
}

export function pluginSyncOnEachValue(instance: Pick<Instance, 'subscribe'>, pluginSync: PluginSync) {
  return instance.subscribe((value) => { void pluginSync.run(value.pluginSyncArguments); });
}
