import type { components } from './generated/api';

export type PluginAddress = components['schemas']['PluginAddress'];

/** ADR-0012: a plugin is its origin and filename, compared without case. */
export function pluginAddressKey({ name, origin }: PluginAddress): string {
  return JSON.stringify([origin.toLowerCase(), name.toLowerCase()]);
}

/** The address of whatever carries a plugin's filename as `plugin` beside its `origin`. */
export const pluginAddressOf = ({ plugin, origin }: { plugin: string; origin: string }): PluginAddress => ({ name: plugin, origin });

export const samePluginAddress = (a: PluginAddress, b: PluginAddress): boolean =>
  pluginAddressKey(a) === pluginAddressKey(b);

/** Every fact is filed and read under origin and filename (ADR-0012). */
export class ByPluginAddress<T> {
  private readonly byAddress = new Map<string, T>();

  set(plugin: PluginAddress, value: T): void {
    this.byAddress.set(pluginAddressKey(plugin), value);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, plugin: PluginAddress, item: U): void {
    const key = pluginAddressKey(plugin);
    this.byAddress.set(key, [...(this.byAddress.get(key) ?? []), item]);
  }

  get(plugin: PluginAddress): T | undefined {
    return this.byAddress.get(pluginAddressKey(plugin));
  }

  has(plugin: PluginAddress): boolean {
    return this.byAddress.has(pluginAddressKey(plugin));
  }
}
