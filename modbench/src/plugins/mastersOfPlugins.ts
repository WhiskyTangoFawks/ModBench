import type { InstanceValue } from '../instanceLoader/instance';
import { pluginArgumentOf } from '../drivingLib/argument';
import { pluginNameKey, type PluginAddress } from '../wire/pluginAddress';
import type { PluginFacts } from './pluginFacts';

/** The plugin rows the selected plugins' masters are (plugins.md, The highlight, story 4): for each
 *  master's file name, the row the game loads. A plugin mEdit has not read has no masters. */
export function mastersOfPlugins(
  value: Pick<InstanceValue, 'plugins' | 'pluginsLoadedWithNoLine'>, facts: Pick<PluginFacts, 'mastersOf'>, selection: readonly unknown[],
): PluginAddress[] {
  const loaded = new Map<string, PluginAddress>();
  for (const plugin of [...value.plugins.filter((p) => p.winning), ...value.pluginsLoadedWithNoLine ?? []]) {
    const key = pluginNameKey(plugin.name);
    if (!loaded.has(key)) loaded.set(key, { name: plugin.name, origin: plugin.origin });
  }
  return selection.flatMap((row) => {
    const address = pluginArgumentOf(row)?.plugin;
    return (address ? facts.mastersOf(address) : []).flatMap((master) => loaded.get(pluginNameKey(master)) ?? []);
  });
}
