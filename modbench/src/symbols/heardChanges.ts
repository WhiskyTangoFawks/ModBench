import type { PluginAddress } from '../client';

interface Asker {
  forget(): void;
  onPluginChanged(listener: (event: { plugin?: PluginAddress; keys?: readonly string[] }) => void): () => void;
}

export function heardChanges(
  { asker, instance }: { asker: Asker; instance: { subscribe: (listener: () => void) => { dispose: () => unknown } } | undefined },
  listener: (plugin?: PluginAddress, keys?: readonly string[]) => void,
): () => void {
  const instanceSubscription = instance?.subscribe(() => { asker.forget(); listener(); });
  const stop = asker.onPluginChanged(({ plugin, keys }) => { listener(plugin, keys); });
  return () => { void instanceSubscription?.dispose(); stop(); };
}
