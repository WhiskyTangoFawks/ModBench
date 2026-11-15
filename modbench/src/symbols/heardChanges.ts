import type { PluginAddress } from '../client';

interface Asker {
  forget(): void;
  onPluginChanged(listener: (event: { plugin?: PluginAddress }) => void): () => void;
}

export function heardChanges(
  { asker, instance }: { asker: Asker; instance: { subscribe: (listener: () => void) => { dispose: () => unknown } } | undefined },
  listener: (plugin?: PluginAddress) => void,
): () => void {
  const instanceSubscription = instance?.subscribe(() => { asker.forget(); listener(); });
  const stop = asker.onPluginChanged(({ plugin }) => { listener(plugin); });
  return () => { void instanceSubscription?.dispose(); stop(); };
}
