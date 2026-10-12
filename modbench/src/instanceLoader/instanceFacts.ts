import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance } from './instance';
import { pluginStanding, type PluginStanding } from './pluginStanding';
import type { PluginAddress } from '../wire/pluginAddress';

export interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  sourceMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  sourceDirs: () => ReadonlyMap<string, string>;
  standingOf: (plugin: PluginAddress) => PluginStanding;
  onChange: (listener: () => void) => Subscription;
  refresh: () => Promise<void>;
}

export const factsOf = (instance: Instance): InstanceFacts => ({
  trackedMods: () => instance.value.trackedMods,
  sourceMods: () => instance.value.sourceMods,
  modDirs: () => instance.value.paths.modDirs,
  sourceDirs: () => instance.value.paths.sourceDirs,
  standingOf: (plugin) => pluginStanding(instance.value, plugin),
  onChange: (listener) => instance.subscribe(() => { listener(); }),
  refresh: () => instance.refresh(),
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  trackedMods: () => new Set(),
  sourceMods: () => new Set(),
  modDirs: () => new Map(),
  sourceDirs: () => new Map(),
  standingOf: () => ({ kind: 'enabled' }),
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
};
