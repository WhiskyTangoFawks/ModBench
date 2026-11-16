import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

/** A plugin and the records of it a change names; none names the whole plugin. */
export interface PluginRecords { plugin: PluginAddress; keys?: readonly string[] }

/** A change names a plugin, or every plugin when it names none. */
export type PluginChanged = Partial<PluginRecords>;

/** Adds what a change names to what is to be asked of: a plugin named whole stays whole, and the records named twice are both asked. */
export function addNamed(into: Map<string, PluginRecords>, { plugin, keys }: PluginRecords): void {
  const key = pluginAddressKey(plugin);
  const had = into.get(key);
  const whole = had !== undefined && had.keys === undefined;
  const unnamed = keys === undefined || keys.length === 0;
  into.set(key, { plugin, keys: whole || unnamed ? undefined : [...new Set([...had?.keys ?? [], ...keys])] });
}
