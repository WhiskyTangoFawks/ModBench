import type { PluginAddress } from '../client';

interface Asker {
  forget(): void;
  onPluginChanged(listener: (event: { plugin: PluginAddress }) => void): () => void;
  onLoadOrderSettled(listener: () => void): () => void;
}

/** Tells `listener` of every change to what a file names: of a plugin, of the load order, or of the instance. The asker has dropped what it held before the listener hears. */
export function heardChanges(
  { asker, instance }: { asker: Asker; instance: { subscribe: (listener: () => void) => { dispose: () => unknown } } | undefined },
  listener: (plugin?: PluginAddress) => void,
): () => void {
  const instanceSubscription = instance?.subscribe(() => { asker.forget(); listener(); });
  const off = [asker.onLoadOrderSettled(() => { listener(); }), asker.onPluginChanged(({ plugin }) => { listener(plugin); })];
  return () => { void instanceSubscription?.dispose(); for (const stop of off) stop(); };
}
