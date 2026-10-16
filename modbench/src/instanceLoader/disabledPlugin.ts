import type { InstanceValue } from './instance';
import { modOfOrigin } from './modOfOrigin';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

/** An overridden plugin is neither. */
export function isDisabledOrInDisabledMod(
  value: Pick<InstanceValue, 'mods' | 'entryKey' | 'plugins' | 'pluginsLoadedWithNoLine'>, plugin: PluginAddress,
): boolean {
  const mod = modOfOrigin(value, plugin.origin);
  if (value.mods.some((entry) => entry.kind === 'mod' && !entry.enabled && entry.name === mod)) return true;
  const loadedWithNoLine = value.pluginsLoadedWithNoLine?.some((p) => samePluginAddress(p, plugin)) ?? false;
  return !loadedWithNoLine && value.plugins.some((row) => !row.enabled && samePluginAddress(row, plugin));
}
