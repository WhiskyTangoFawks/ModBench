import { exactPluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

/** The plugins a change or a read names; `undefined` names every plugin. */
export type NamedPlugins = readonly PluginAddress[] | undefined;

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

  /** Files `value` in its place, or forgets the plugin when there is none. */
  put(plugin: PluginAddress, value: T | undefined): void {
    if (value === undefined) this.bySpelling.delete(exactPluginAddressKey(plugin));
    else this.set(plugin, value);
  }

  get size(): number {
    return this.bySpelling.size;
  }

  has(plugin: PluginAddress): boolean {
    return this.bySpelling.has(exactPluginAddressKey(plugin));
  }

  values(): T[] {
    return [...this.bySpelling.values()];
  }
}
