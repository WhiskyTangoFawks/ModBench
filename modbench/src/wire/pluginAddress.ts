import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

/** Where a new plugin can live: an enabled mod or Overwrite, with its folder and, for a source mod, its source folder. */
export type PluginPlace = components['schemas']['PluginPlace'];

/** A strings file or archive, with the stamp Mod Management read of it. */
export type StampedFile = components['schemas']['StampedFile'];

// Ends in `/`, which no folder name holds, so no mod shares it. Equal to mEdit's PluginOrigin.
export const DATA_DIRECTORY_ORIGIN = 'Data/';

/** A plugin's file name as the game compares it. */
export const pluginNameKey = (name: string): string => name.toLowerCase();

export function pluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin.toLowerCase(), pluginNameKey(name)]);
}

/** The address as spelled: two plugins whose names or origins differ only in case are two keys. */
export function exactPluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin, name]);
}

/** The address of whatever carries a plugin's filename as `plugin` beside its `origin`. */
export const pluginAddressOf = ({ plugin, origin }: { plugin: string; origin: string }): PluginAddress => ({ name: plugin, origin });

export const samePluginAddress = (a: PluginAddress, b: PluginAddress): boolean =>
  pluginAddressKey(a) === pluginAddressKey(b);
