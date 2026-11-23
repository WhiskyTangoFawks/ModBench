import type { PluginAddress } from '../client';
import type { Concerns, InstanceValue } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

interface Asker {
  forget(): void;
  onPluginChanged(listener: (event: { plugin?: PluginAddress; keys?: readonly string[] }) => void): () => void;
}

/** Tells `listener` of a change to one of `facts`, to a plugin source file, or to what mEdit says of a plugin. */
export function heardChanges<K extends keyof InstanceValue>(
  { asker, instance, facts }: {
    asker: Asker;
    instance: { subscribe: (listener: () => void, concerns: Concerns<NoInfer<K>>, readsFile: (path: string) => boolean) => { dispose: () => unknown } } | undefined;
    facts: Concerns<K>;
  },
  listener: (plugin?: PluginAddress, keys?: readonly string[]) => void,
): () => void {
  // The files judged and asked of mEdit are plugin source.
  const instanceSubscription = instance?.subscribe(() => { asker.forget(); listener(); }, facts, isPluginSourcePath);
  const stop = asker.onPluginChanged(({ plugin, keys }) => { listener(plugin, keys); });
  return () => { void instanceSubscription?.dispose(); stop(); };
}
