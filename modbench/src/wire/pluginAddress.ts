import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

// Ends in `/`, which no folder name holds, so no mod shares it. Equal to mEdit's PluginOrigin.
export const DATA_DIRECTORY_ORIGIN = 'Data/';

export function pluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin.toLowerCase(), name.toLowerCase()]);
}

/** The address as spelled: two plugins whose names or origins differ only in case are two keys. */
export function exactPluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin, name]);
}

/** The address of whatever carries a plugin's filename as `plugin` beside its `origin`. */
export const pluginAddressOf = ({ plugin, origin }: { plugin: string; origin: string }): PluginAddress => ({ name: plugin, origin });

export const samePluginAddress = (a: PluginAddress, b: PluginAddress): boolean =>
  pluginAddressKey(a) === pluginAddressKey(b);
