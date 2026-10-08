import type { Subscription } from '../instanceAdapter/instanceAdapter';
import type { Instance } from './instance';

export interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  onChange: (listener: () => void) => Subscription;
  refresh: () => Promise<void>;
}

export const factsOf = (instance: Instance): InstanceFacts => ({
  trackedMods: () => instance.value.trackedMods,
  modDirs: () => instance.value.paths.modDirs,
  onChange: (listener) => instance.subscribe(() => { listener(); }),
  refresh: () => instance.refresh(),
});

export const NO_INSTANCE_FACTS: InstanceFacts = {
  trackedMods: () => new Set(),
  modDirs: () => new Map(),
  onChange: () => ({ dispose: () => undefined }),
  refresh: () => Promise.resolve(),
};
