import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance } from './instance';
import { pluginStanding, type PluginStanding } from './pluginStanding';
import type { PluginAddress } from '../wire/pluginAddress';

export interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  standingOf: (plugin: PluginAddress) => PluginStanding;
  onChange: (listener: () => void) => Subscription;
  refresh: () => Promise<void>;
}

export const factsOf = (instance: Instance): InstanceFacts => ({
  trackedMods: () => instance.value.trackedMods,
  modDirs: () => instance.value.paths.modDirs,
  standingOf: (plugin) => pluginStanding(instance.value, plugin),
  onChange: (listener) => instance.subscribe(() => { listener(); }),
  refresh: () => instance.refresh(),
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  trackedMods: () => new Set(),
  modDirs: () => new Map(),
  standingOf: () => ({ kind: 'enabled' }),
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
};
