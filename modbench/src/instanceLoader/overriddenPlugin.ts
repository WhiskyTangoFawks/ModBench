import type { InstanceValue } from './instance';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

/** The origin of the enabled file that wins the plugin's filename, or undefined when the plugin itself wins or no file does. */
export function overridingOrigin(value: Pick<InstanceValue, 'plugins'>, plugin: PluginAddress): string | undefined {
  const winner = value.plugins.find((row) => row.winning && row.enabled && row.name.toLowerCase() === plugin.name.toLowerCase());
  return winner !== undefined && !samePluginAddress(winner, plugin) ? winner.origin : undefined;
}
