// The plugins a manifest names, as plugin sync and the Plugins view both judge them (plugins.md, The tree, story 10).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { isPluginAtRoot } from '../tables/pluginFile';

/** A plugin a mod's manifest names that its folder lacks, and that mod. */
export interface PluginNotRestored {
  readonly name: string;
  readonly mod: string;
}

/** Each plugin an enabled mod's manifest names at its folder's root that the folder lacks, by key, from the mod that
 *  wins it in mod order. */
export function pluginsNotRestored(
  enabledModsWinningFirst: readonly string[], goneFrom: (mod: string) => readonly string[],
): ReadonlyMap<string, PluginNotRestored> {
  const named = new Map<string, PluginNotRestored>();
  for (const mod of enabledModsWinningFirst) {
    for (const name of goneFrom(mod).filter((path) => isPluginAtRoot(path))) {
      if (!named.has(pluginKey(name))) named.set(pluginKey(name), { name, mod });
    }
  }
  return named;
}
