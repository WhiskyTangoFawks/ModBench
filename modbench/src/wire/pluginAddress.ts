import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

/** Where a new plugin can live: an enabled mod or Overwrite, with its folder and, for a source mod, its source folder. */
export type PluginPlace = components['schemas']['PluginPlace'];

/** A strings file or archive, with the stamp Mod Management read of it. */
export type StampedFile = components['schemas']['StampedFile'];

// The two origins that are not mods end in `/`, which no folder name holds, so no mod shares them.
// mEdit's PluginOrigin holds the Data directory's.
export const DATA_DIRECTORY_ORIGIN = 'Data/';
export const OVERWRITE_ORIGIN = 'overwrite/';

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

// ADR-0012.
export const pluginRowName = ({ name, origin }: PluginAddress): string => `${name} (${origin})`;
