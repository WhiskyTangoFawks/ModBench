import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

export interface Named { plugin: PluginAddress; keys?: ReadonlySet<string> }

/** Adds a plugin to the plugins to ask of, with the records a change names: a plugin named with none, or twice with different ones, is asked of whole or with both. */
export function addNamed(into: Map<string, Named>, plugin: PluginAddress, keys?: readonly string[]): void {
  const key = pluginAddressKey(plugin);
  const had = into.get(key);
  const whole = had !== undefined && had.keys === undefined;
  const unnamed = keys === undefined || keys.length === 0;
  into.set(key, { plugin, keys: whole || unnamed ? undefined : new Set([...had?.keys ?? [], ...keys]) });
}
