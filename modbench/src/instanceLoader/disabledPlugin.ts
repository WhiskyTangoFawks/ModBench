import type { InstanceValue } from './instance';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

/** No enabled `plugins.txt` line names the plugin and the game does not load it with no line, or the
 *  mod providing it is disabled. An overridden plugin is neither. */
export function isDisabledOrInDisabledMod(
  value: Pick<InstanceValue, 'mods' | 'plugins' | 'pluginsLoadedWithNoLine'>, plugin: PluginAddress,
): boolean {
  const origin = plugin.origin.toLowerCase();
  if (value.mods.some((entry) => entry.kind === 'mod' && !entry.enabled && entry.name.toLowerCase() === origin)) return true;
  const loadedWithNoLine = value.pluginsLoadedWithNoLine?.some((p) => samePluginAddress(p, plugin)) ?? false;
  return !loadedWithNoLine && value.plugins.some((row) => !row.enabled && samePluginAddress(row, plugin));
}
