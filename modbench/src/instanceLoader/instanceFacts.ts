import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance } from './instance';
import { isDisabledOrInDisabledMod } from './disabledPlugin';
import type { PluginAddress } from '../wire/pluginAddress';

export interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  isDisabledOrInDisabledMod: (plugin: PluginAddress) => boolean;
  onChange: (listener: () => void) => Subscription;
  refresh: () => Promise<void>;
}

export const factsOf = (instance: Instance): InstanceFacts => ({
  trackedMods: () => instance.value.trackedMods,
  modDirs: () => instance.value.paths.modDirs,
  isDisabledOrInDisabledMod: (plugin) => isDisabledOrInDisabledMod(instance.value, plugin),
  onChange: (listener) => instance.subscribe(() => { listener(); }),
  refresh: () => instance.refresh(),
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  trackedMods: () => new Set(),
  modDirs: () => new Map(),
  isDisabledOrInDisabledMod: () => false,
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
};
