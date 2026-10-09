import { exactPluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

/** Filed by spelling, so plugins whose names differ only in case stay apart. */
export class ByPluginAddress<T> {
  private readonly bySpelling = new Map<string, T>();

  set(plugin: PluginAddress, value: T): void {
    this.bySpelling.set(exactPluginAddressKey(plugin), value);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, plugin: PluginAddress, item: U): void {
    this.set(plugin, [...(this.get(plugin) ?? []), item]);
  }

  get(plugin: PluginAddress): T | undefined {
    return this.bySpelling.get(exactPluginAddressKey(plugin));
  }

  has(plugin: PluginAddress): boolean {
    return this.bySpelling.has(exactPluginAddressKey(plugin));
  }
}
