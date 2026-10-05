import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

export function pluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin.toLowerCase(), name.toLowerCase()]);
}

/** The address of whatever carries a plugin's filename as `plugin` beside its `origin`. */
export const pluginAddressOf = ({ plugin, origin }: { plugin: string; origin: string }): PluginAddress => ({ name: plugin, origin });

export const samePluginAddress = (a: PluginAddress, b: PluginAddress): boolean =>
  pluginAddressKey(a) === pluginAddressKey(b);
