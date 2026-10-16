import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance } from './instance';
import { pluginStanding, type PluginStanding } from './pluginStanding';
import { modOfOrigin } from './modOfOrigin';
import type { PluginAddress } from '../wire/pluginAddress';

export interface InstanceFacts {
  listedSourceMods: () => ReadonlySet<string>;
  sourceMods: () => ReadonlySet<string>;
  modOfOrigin: (origin: string) => string | undefined;
  sourceDirs: () => ReadonlyMap<string, string>;
  standingOf: (plugin: PluginAddress) => PluginStanding;
  onChange: (listener: () => void) => Subscription;
  refresh: () => Promise<void>;
}

export const factsOf = (instance: Instance): InstanceFacts => ({
  listedSourceMods: () => instance.value.listedSourceMods,
  sourceMods: () => instance.value.sourceMods,
  modOfOrigin: (origin) => modOfOrigin(instance.value, origin)?.name,
  sourceDirs: () => instance.value.paths.sourceDirs,
  standingOf: (plugin) => pluginStanding(instance.value, plugin),
  onChange: (listener) => instance.subscribe(() => { listener(); }),
  refresh: () => instance.refresh(),
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  listedSourceMods: () => new Set(),
  sourceMods: () => new Set(),
  modOfOrigin: () => undefined,
  sourceDirs: () => new Map(),
  standingOf: () => ({ kind: 'enabled' }),
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
};
