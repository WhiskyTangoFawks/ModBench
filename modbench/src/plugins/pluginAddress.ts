import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

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
