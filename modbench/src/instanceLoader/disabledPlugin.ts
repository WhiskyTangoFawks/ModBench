import type { InstanceValue } from './instance';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

/** An overridden plugin is neither. */
export function isDisabledOrInDisabledMod(
  value: Pick<InstanceValue, 'mods' | 'plugins' | 'pluginsLoadedWithNoLine'>, plugin: PluginAddress,
): boolean {
  const origin = plugin.origin.toLowerCase();
  if (value.mods.some((entry) => entry.kind === 'mod' && !entry.enabled && entry.name.toLowerCase() === origin)) return true;
  const loadedWithNoLine = value.pluginsLoadedWithNoLine?.some((p) => samePluginAddress(p, plugin)) ?? false;
  return !loadedWithNoLine && value.plugins.some((row) => !row.enabled && samePluginAddress(row, plugin));
}
