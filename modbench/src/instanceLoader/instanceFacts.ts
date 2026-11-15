import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance, InstanceOf } from './instance';
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
  redraw: () => void;
}

const FACTS_READ = { listedSourceMods: true, sourceMods: true, mods: true, paths: true, plugins: true, pluginsLoadedWithNoLine: true } as const;

export const factsOf = (instance: InstanceOf<keyof typeof FACTS_READ | 'entryKey'> & Pick<Instance, 'refresh' | 'redraw'>): InstanceFacts => ({
  listedSourceMods: () => instance.value.listedSourceMods,
  sourceMods: () => instance.value.sourceMods,
  modOfOrigin: (origin) => modOfOrigin(instance.value, origin)?.name,
  sourceDirs: () => instance.value.paths.sourceDirs,
  standingOf: (plugin) => pluginStanding(instance.value, plugin),
  onChange: (listener) => instance.subscribe(() => { listener(); }, FACTS_READ),
  refresh: () => instance.refresh(),
  redraw: () => { instance.redraw(); },
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  listedSourceMods: () => new Set(),
  sourceMods: () => new Set(),
  modOfOrigin: () => undefined,
  sourceDirs: () => new Map(),
  standingOf: () => ({ kind: 'enabled' }),
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
  redraw: () => undefined,
};
