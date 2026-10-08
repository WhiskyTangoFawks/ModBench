import { exactPluginAddressKey, pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

/** Filed by spelling, so plugins whose names differ only in case stay apart. mEdit may answer in
 *  a spelling from before a case-only change, so a reader matching none reads the sole plugin it
 *  matches without case. */
export class ByPluginAddress<T> {
  private readonly byFoldedAddress = new Map<string, Map<string, T>>();

  set(plugin: PluginAddress, value: T): void {
    const key = pluginAddressKey(plugin);
    const spellings = this.byFoldedAddress.get(key) ?? new Map<string, T>();
    spellings.set(exactPluginAddressKey(plugin), value);
    this.byFoldedAddress.set(key, spellings);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, plugin: PluginAddress, item: U): void {
    this.set(plugin, [...(this.exact(plugin) ?? []), item]);
  }

  get(plugin: PluginAddress): T | undefined {
    return this.exact(plugin) ?? this.onlyMatch(plugin);
  }

  has(plugin: PluginAddress): boolean {
    return this.get(plugin) !== undefined;
  }

  private exact(plugin: PluginAddress): T | undefined {
    return this.byFoldedAddress.get(pluginAddressKey(plugin))?.get(exactPluginAddressKey(plugin));
  }

  private onlyMatch(plugin: PluginAddress): T | undefined {
    const spellings = this.byFoldedAddress.get(pluginAddressKey(plugin));
    return spellings?.size === 1 ? [...spellings.values()][0] : undefined;
  }
}
