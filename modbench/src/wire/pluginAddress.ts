import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

// A mod's origin is its folder name, so an origin that is not a mod ends in the one character no
// folder name holds. Equal to mEdit's PluginOrigin.DataDirectory: the snapshot carries it.
export const DATA_DIRECTORY_ORIGIN = 'Data/';

export function pluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin.toLowerCase(), name.toLowerCase()]);
}

/** The address of whatever carries a plugin's filename as `plugin` beside its `origin`. */
export const pluginAddressOf = ({ plugin, origin }: { plugin: string; origin: string }): PluginAddress => ({ name: plugin, origin });

export const samePluginAddress = (a: PluginAddress, b: PluginAddress): boolean =>
  pluginAddressKey(a) === pluginAddressKey(b);
